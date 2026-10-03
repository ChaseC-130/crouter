import "server-only";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import { childEnv } from "./providers";
import { dataDir } from "./config";
import { efforts, validModel } from "../../scripts/worker-selection.mjs";
import type { Effort, WorkerModel } from "../types";
const exec = promisify(execFile);
export function decodeCommandModels(
  provider: "grok" | "agy",
  raw: string,
): WorkerModel[] {
  const clean = stripVTControlCharacters(raw);
  if (/not authenticated|not logged in/i.test(clean))
    throw new Error("Host model catalog unavailable");
  const seen = new Set<string>();
  const models = clean.split(/\r?\n/).flatMap((line): WorkerModel[] => {
    const match =
      provider === "agy"
        ? line.match(/^([^\s]+)\t(.+)$/)
        : line.match(/^\s*[*-]\s+([^\s]+)(?:\s+\(default\))?\s*$/);
    if (!match || !validModel(match[1]) || seen.has(match[1])) return [];
    seen.add(match[1]);
    return [
      {
        id: match[1],
        name: (match[2] || match[1]).slice(0, 160),
        description:
          provider === "agy"
            ? "Host-advertised model variant; effort is included in the model ID when specified."
            : "Host-advertised Grok model.",
        efforts: ["default"],
        defaultEffort: "default",
      },
    ];
  });
  if (!models.length || models.length > 64)
    throw new Error("Host model catalog unavailable");
  return models;
}
export async function commandModelCatalog(provider: "grok" | "agy") {
  const result = await exec(
    process.env[`${provider.toUpperCase()}_BIN`] || provider,
    ["models"],
    {
      env: childEnv(),
      cwd: dataDir(),
      timeout: 10000,
      maxBuffer: 65536,
      killSignal: "SIGKILL",
    },
  );
  // Some CLI versions exit successfully with a cached list after auth failure.
  if (/invalid_grant|unauthenticated|no auth credentials/i.test(result.stderr))
    throw new Error("Host model catalog unavailable");
  return decodeCommandModels(provider, result.stdout);
}

const modelId = z.string().refine(validModel);
const effort = z.string().refine((v) => efforts.includes(v));
const codexModels = z.object({
  data: z
    .array(
      z.object({
        model: modelId,
        displayName: z.string().max(160),
        description: z.string().max(2000),
        defaultReasoningEffort: effort,
        supportedReasoningEfforts: z
          .array(z.object({ reasoningEffort: effort }))
          .max(10),
        hidden: z.boolean().optional(),
      }),
    )
    .max(64),
  nextCursor: z.string().nullable().optional(),
});
export function decodeCodexModels(raw: unknown): WorkerModel[] {
  const data = codexModels.parse(raw);
  // Refuse a truncated catalog rather than infer models from another account.
  if (data.nextCursor) throw new Error("Incomplete model catalog");
  return data.data
    .filter((m) => !m.hidden && m.supportedReasoningEfforts.length)
    .map((m) => ({
      id: m.model,
      name: m.displayName,
      description: m.description.slice(0, 500),
      efforts: m.supportedReasoningEfforts.map(
        (e) => e.reasoningEffort as Effort,
      ),
      defaultEffort: m.defaultReasoningEffort as Effort,
    }));
}
const claudeModels = z
  .array(
    z.object({
      value: modelId,
      resolvedModel: modelId.optional(),
      displayName: z.string().max(160),
      description: z.string().max(2000).optional(),
      supportedEffortLevels: z.array(effort).max(10).optional(),
    }),
  )
  .max(64);
export function decodeClaudeModels(raw: unknown): WorkerModel[] {
  const seen = new Set<string>();
  return claudeModels.parse(raw).flatMap((m) => {
    const id = m.resolvedModel || m.value;
    if (seen.has(id)) return [];
    seen.add(id);
    const levels = (
      m.supportedEffortLevels?.length ? m.supportedEffortLevels : ["default"]
    ) as Effort[];
    return [
      {
        id,
        name: m.displayName,
        description: (m.description || "").slice(0, 500),
        efforts: levels,
        defaultEffort: levels.includes("high") ? ("high" as const) : levels[0],
      },
    ];
  });
}
export async function claudeModelCatalog(): Promise<WorkerModel[]> {
  // SDK initialize is a metadata handshake. No user prompt or inference is sent.
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const child = spawn(
      process.env.CLAUDE_BIN || "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--safe-mode",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ],
      {
        cwd: dataDir(),
        env: childEnv(),
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
        shell: false,
      },
    );
    let buffer = "",
      bytes = 0,
      settled = false;
    const finish = (models?: WorkerModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
      if (models?.length) resolve(models);
      else reject(new Error("Host model catalog unavailable"));
    };
    const timer = setTimeout(() => finish(), 20000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) return finish();
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (
            event.type === "control_response" &&
            event.response?.request_id === requestId
          ) {
            if (event.response.subtype !== "success") return finish();
            finish(decodeClaudeModels(event.response.response?.models));
          }
          if (event.type === "control_request")
            child.stdin.write(
              JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "error",
                  request_id: event.request_id,
                  error: "Metadata only",
                },
              }) + "\n",
            );
        } catch {
          /* Ignore diagnostics; never return raw CLI output. */
        }
      }
    });
    child.once("error", () => finish());
    child.once("close", () => finish());
    child.stdin.on("error", () => {});
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      }) + "\n",
    );
  });
}
