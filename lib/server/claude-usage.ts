import "server-only";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { boundedRead } from "../../scripts/project-state.mjs";
import type { UsageWindow } from "../types";
import { resetAtSeconds } from "../usage";

const exec = promisify(execFile);
const quota = z.object({
  utilization: z.number().finite().min(0),
  resets_at: z.string().nullable().optional(),
});
const usageSchema = z.object({
  five_hour: quota.nullable().optional(),
  seven_day: quota.nullable().optional(),
  seven_day_oauth_apps: quota.nullable().optional(),
  seven_day_opus: quota.nullable().optional(),
  seven_day_sonnet: quota.nullable().optional(),
  limits: z
    .array(
      z.object({
        kind: z.string(),
        percent: z.number().finite().min(0),
        resets_at: z.string().nullable().optional(),
        scope: z
          .object({
            model: z
              .object({
                id: z.string().nullable().optional(),
                display_name: z.string().optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .max(64)
    .optional(),
});
export function decodeClaudeUsage(raw: unknown): UsageWindow[] {
  const data = usageSchema.parse(raw);
  const windows: UsageWindow[] = [];
  function add(
    label: string,
    used: number,
    reset?: string | null,
    model?: string,
    duration?: number,
  ) {
    const resetsAt = resetAtSeconds(reset, "iso");
    windows.push({
      label: label.slice(0, 100),
      usedPercent: Math.min(100, used),
      ...(resetsAt ? { resetsAt } : {}),
      ...(model ? { model: model.slice(0, 128) } : {}),
      ...(duration ? { windowDurationMins: duration } : {}),
    });
  }
  if (data.five_hour)
    add(
      "Claude · 5 hours",
      data.five_hour.utilization,
      data.five_hour.resets_at,
      undefined,
      300,
    );
  const weekly = data.seven_day_oauth_apps || data.seven_day;
  if (weekly)
    add(
      "Claude · weekly",
      weekly.utilization,
      weekly.resets_at,
      undefined,
      10080,
    );
  for (const limit of data.limits || []) {
    const model = limit.scope?.model;
    const modelId =
      model?.id || model?.display_name?.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      model &&
      modelId &&
      ["weekly_scoped", "five_hour_scoped"].includes(limit.kind)
    )
      add(
        `Claude · ${model.display_name || modelId} · ${limit.kind === "weekly_scoped" ? "weekly" : "5 hours"}`,
        limit.percent,
        limit.resets_at,
        modelId,
        limit.kind === "weekly_scoped" ? 10080 : 300,
      );
  }
  for (const family of ["opus", "sonnet"] as const) {
    const window = data[`seven_day_${family}`];
    if (window && !windows.some((w) => w.model?.includes(family)))
      add(
        `Claude · ${family} · weekly`,
        window.utilization,
        window.resets_at,
        family,
        10080,
      );
  }
  return windows;
}
const credentialSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1).max(8192),
    expiresAt: z.number().optional(),
  }),
});
async function savedToken() {
  const dir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  let raw: string;
  if (process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR) {
    // The default macOS CLI uses Keychain. A legacy file can still exist with an expired login.
    // Never create, refresh, or persist credentials.
    try {
      const result = await exec(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000, maxBuffer: 65536 },
      );
      raw = result.stdout;
    } catch {
      raw = await boundedRead(path.join(dir, ".credentials.json"), 65536);
    }
  } else raw = await boundedRead(path.join(dir, ".credentials.json"), 65536);
  const auth = credentialSchema.parse(JSON.parse(raw)).claudeAiOauth;
  if (auth.expiresAt && auth.expiresAt <= Date.now())
    throw new Error("Saved host credential expired");
  return auth.accessToken;
}
export class UsageReadError extends Error {
  constructor(public retryAfterMs = 60000) {
    super("Host usage unavailable");
  }
}
export async function claudeUsage(): Promise<UsageWindow[]> {
  const token = await savedToken();
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Number(retry)
        : retry
          ? (Date.parse(retry) - Date.now()) / 1000
          : 60;
    throw new UsageReadError(
      Number.isFinite(seconds)
        ? Math.max(60000, Math.min(seconds * 1000, 3600000))
        : 60000,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new UsageReadError();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 65536) {
      await reader.cancel();
      throw new UsageReadError();
    }
    chunks.push(value);
  }
  return decodeClaudeUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
