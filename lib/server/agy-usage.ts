import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { childEnv } from "./providers";
import { resetAtSeconds } from "../usage";
import type { UsageWindow, WorkerModel } from "../types";

const responseSchema = z.object({
  status: z.literal("SUCCESS"),
  num_turns: z.literal(0).optional(),
  command: z.object({
    name: z.enum(["usage", "quota"]),
    data: z.object({
      groups: z
        .array(
          z.object({
            buckets: z
              .array(
                z.object({
                  id: z.string().max(128),
                  name: z.string().max(160).optional(),
                  window: z.string().max(40).optional(),
                  disabled: z.boolean().optional(),
                  remaining_fraction: z
                    .number()
                    .finite()
                    .min(0)
                    .max(1)
                    .nullable()
                    .optional(),
                  remaining: z
                    .object({
                      remaining_fraction: z.number().finite().min(0).max(1),
                    })
                    .nullable()
                    .optional(),
                  reset_time: z.string().nullable().optional(),
                }),
              )
              .max(32),
          }),
        )
        .max(16),
    }),
  }),
});
export function decodeAgyUsage(
  raw: unknown,
  models: WorkerModel[],
): UsageWindow[] {
  const parsed = responseSchema.parse(raw);
  return parsed.command.data.groups.flatMap((group) =>
    group.buckets.flatMap((bucket): UsageWindow[] => {
      const remaining =
        bucket.remaining_fraction ?? bucket.remaining?.remaining_fraction;
      if (bucket.disabled || remaining === undefined) return [];
      // These are the native shared Gemini / third-party pools. Unknown pools
      // cannot be assigned to a model without a verified mapping.
      const family = bucket.id.startsWith("gemini-")
        ? "gemini"
        : bucket.id.startsWith("3p-")
          ? "3p"
          : undefined;
      if (!family) return [];
      const scopedModels = models
        .filter((m) =>
          family === "gemini"
            ? m.id.startsWith("gemini-")
            : /^(claude-|gpt-oss-)/.test(m.id),
        )
        .map((m) => m.id);
      const resetsAt = resetAtSeconds(bucket.reset_time, "iso");
      const duration =
        bucket.window === "weekly"
          ? 10080
          : bucket.window === "5h"
            ? 300
            : undefined;
      return [
        {
          label: `Antigravity · ${bucket.id}`,
          usedPercent: (1 - remaining) * 100,
          models: scopedModels,
          ...(resetsAt ? { resetsAt } : {}),
          ...(duration ? { windowDurationMins: duration } : {}),
        },
      ];
    }),
  );
}
export async function agyUsage(models: WorkerModel[]) {
  // A native read-only slash command. Never fall back to an agent prompt.
  const root = await mkdtemp(path.join(os.tmpdir(), "crouter-agy-usage-"));
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.env.AGY_BIN || "agy",
        ["-p", "/usage", "--output-format", "json"],
        {
          cwd: root,
          env: childEnv(),
          stdio: ["ignore", "pipe", "ignore"],
          detached: process.platform !== "win32",
          shell: false,
        },
      );
      let bytes = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (success = false) => {
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
        if (success) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error("Antigravity usage unavailable"));
      };
      // Cold CLI/Keychain startup routinely exceeds ten seconds.
      const timer = setTimeout(() => finish(), 90000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) finish();
        else chunks.push(chunk);
      });
      child.once("error", () => finish());
      child.once("close", (code) => finish(code === 0));
    });
    return decodeAgyUsage(JSON.parse(raw), models);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
