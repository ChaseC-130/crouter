import "server-only";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { boundedRead } from "../../scripts/project-state.mjs";
import { resetAtSeconds } from "../usage";
import { ProviderUsageError, usageJson } from "./usage-http";
import type { UsageWindow } from "../types";

const exec = promisify(execFile);
const windowSchema = z.object({
  used_percent: z.number().finite().nonnegative(),
  resets_at: z.number().finite().nullable().optional(),
});
const responseSchema = z.object({
  is_subs_active: z.boolean().nullable().optional(),
  require_payment: z.boolean().nullable().optional(),
  subs_usage: z
    .object({
      window: windowSchema.extend({
        window_duration_mins: z.number().int().positive(),
      }),
      weekly: windowSchema,
    })
    .nullable()
    .optional(),
});
export function decodeMuseUsage(raw: unknown): UsageWindow[] {
  const data = responseSchema.parse(raw);
  if (data.require_payment)
    throw new ProviderUsageError(
      "Muse billing setup is incomplete. Finish setup in Muse.",
    );
  if (!data.is_subs_active)
    throw new ProviderUsageError("This Muse login has no active subscription.");
  if (!data.subs_usage)
    throw new ProviderUsageError(
      "Muse did not include subscription quotas in this login response. Try refreshing after using Muse.",
    );
  return (["window", "weekly"] as const).map((key) => {
    const value = data.subs_usage![key];
    const resetsAt =
      value.resets_at && value.resets_at <= 64092211200
        ? resetAtSeconds(value.resets_at, "seconds")
        : undefined;
    return {
      label: key === "window" ? "Muse · session window" : "Muse · weekly",
      usedPercent: Math.min(100, value.used_percent),
      windowDurationMins:
        key === "window" ? data.subs_usage!.window.window_duration_mins : 10080,
      ...(resetsAt ? { resetsAt } : {}),
    };
  });
}
const authSchema = z.object({
  providers: z
    .object({
      meta: z
        .object({ access_token: z.string().max(8192).optional() })
        .optional(),
    })
    .optional(),
});
async function savedToken() {
  const file =
    process.env.MUSE_AUTH_PATH ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "muse/auth.json",
    );
  let token: string | undefined;
  try {
    token = authSchema.parse(JSON.parse(await boundedRead(file, 65536)))
      .providers?.meta?.access_token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ProviderUsageError(
        "Muse login file could not be read. Sign in with muse login.",
      );
  }
  if (token === undefined && process.platform === "darwin") {
    try {
      const result = await exec(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          "ai.meta.dev.credentials",
          "-a",
          "meta",
          "-w",
        ],
        { timeout: 5000, maxBuffer: 65536 },
      );
      token = z
        .object({ access_token: z.string().max(8192) })
        .parse(JSON.parse(result.stdout)).access_token;
    } catch {
      throw new ProviderUsageError(
        "Muse saved login is unavailable. Sign in with muse login and allow access to its saved credential.",
      );
    }
  }
  if (!token?.startsWith("dca:") || /[\r\n]/.test(token))
    throw new ProviderUsageError(
      "Muse needs a saved device-code login. Run muse login, then refresh limits.",
    );
  return token;
}
export async function museUsage() {
  const token = await savedToken();
  // This is the CLI's subscription endpoint. Discard minted inference keys and payment details.
  return decodeMuseUsage(
    await usageJson("https://api.meta.ai/muse-code/key", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-api-version": "1.0.0",
        "User-Agent": "crouter",
      },
      body: "{}",
    }),
  );
}
