import "server-only";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { z } from "zod";
import { boundedRead } from "../../scripts/project-state.mjs";
import { resetAtSeconds } from "../usage";
import { JsonLineClient } from "./jsonline-client";
import { childEnv } from "./providers";
import { grokArgs } from "./grok";
import { ProviderUsageError, usageJson } from "./usage-http";
import type { UsageWindow } from "../types";

// Grok's protobuf JSON can encode a zero amount as {}.
const amount = z.object({ val: z.number().finite().nonnegative().default(0) });
const time = z.string().max(80).nullable().optional();
const creditsSchema = z.object({
  config: z.object({
    creditUsagePercent: z.number().finite().nonnegative().nullable().optional(),
    currentPeriod: z
      .object({ type: z.string().optional(), start: time, end: time })
      .nullable()
      .optional(),
    isUnifiedBillingUser: z.boolean().optional(),
    monthlyLimit: amount.nullable().optional(),
    used: amount.nullable().optional(),
    billingPeriodStart: time,
    billingPeriodEnd: time,
    onDemandUsed: amount.nullable().optional(),
    onDemandCap: amount.nullable().optional(),
  }),
});
function creditWindow(
  used: number,
  start?: string | null,
  end?: string | null,
): UsageWindow[] {
  const resetsAt = resetAtSeconds(end, "iso");
  const startsAt = resetAtSeconds(start, "iso");
  const duration =
    startsAt && resetsAt && startsAt < resetsAt && startsAt * 1000 <= Date.now()
      ? (resetsAt - startsAt) / 60
      : undefined;
  return [
    {
      label:
        duration && duration <= 8 * 1440
          ? "Grok · weekly credits"
          : duration
            ? "Grok · billing period"
            : "Grok · credits",
      usedPercent: Math.min(100, used),
      ...(resetsAt ? { resetsAt } : {}),
      ...(duration ? { windowDurationMins: duration } : {}),
    },
  ];
}
export function decodeGrokCredits(raw: unknown): UsageWindow[] {
  const { config } = creditsSchema.parse(raw);
  const currentEnd = resetAtSeconds(config.currentPeriod?.end, "iso");
  const currentStart = resetAtSeconds(config.currentPeriod?.start, "iso");
  // The official CLI maps an omitted percentage to zero. Limit that default
  // to a recognized, active unified allowance; unknown/null data stays unknown.
  const omittedZero =
    config.creditUsagePercent === undefined &&
    config.isUnifiedBillingUser === true &&
    /^(USAGE_PERIOD_TYPE_WEEKLY|USAGE_PERIOD_TYPE_MONTHLY)$/.test(
      config.currentPeriod?.type || "",
    ) &&
    currentStart &&
    currentEnd &&
    currentStart * 1000 <= Date.now() &&
    currentEnd * 1000 > Date.now();
  const used =
    config.creditUsagePercent ??
    (config.monthlyLimit && config.monthlyLimit.val > 0 && config.used
      ? (config.used.val / config.monthlyLimit.val) * 100
      : omittedZero
        ? 0
        : undefined);
  if (used === undefined) return [];
  return creditWindow(
    used,
    currentEnd ? config.currentPeriod?.start : config.billingPeriodStart,
    currentEnd ? config.currentPeriod?.end : config.billingPeriodEnd,
  );
}
const billingSchema = z.object({
  billingCycle: z
    .object({ billingPeriodStart: time, billingPeriodEnd: time })
    .optional(),
  monthlyLimit: amount,
  usage: z.object({ totalUsed: amount }),
});
export function decodeGrokBilling(raw: unknown): UsageWindow[] {
  const data = billingSchema.parse(raw);
  if (data.monthlyLimit.val <= 0) return [];
  return creditWindow(
    (data.usage.totalUsed.val / data.monthlyLimit.val) * 100,
    data.billingCycle?.billingPeriodStart,
    data.billingCycle?.billingPeriodEnd,
  );
}
const authEntry = z.object({
  key: z.string().min(1).max(8192),
  expires_at: z.union([z.number().finite(), z.string()]),
  principal_type: z.string().optional(),
});
export function decodeGrokToken(raw: unknown, now = Date.now()): string {
  const entries = z.record(z.string(), z.unknown()).parse(raw);
  const names = Object.keys(entries);
  // Use the same account preference as the CLI; never switch accounts on an expired preferred login.
  const name =
    names.find((key) => key.startsWith("https://auth.x.ai::")) ||
    names.find((key) => key === "https://accounts.x.ai/sign-in");
  const parsed = authEntry.safeParse(name ? entries[name] : undefined);
  if (!parsed.success)
    throw new ProviderUsageError(
      "Grok saved login is unavailable. Run grok login, then refresh limits.",
    );
  const auth = parsed.data;
  const expires =
    typeof auth.expires_at === "number"
      ? auth.expires_at * 1000
      : Date.parse(auth.expires_at);
  if (!Number.isFinite(expires) || expires <= now)
    throw new ProviderUsageError(
      "Grok saved login has expired. Run grok login, then refresh limits.",
    );
  if (auth.principal_type?.toLowerCase() === "team")
    throw new ProviderUsageError(
      "Grok does not expose subscription usage for this team login.",
    );
  if (/[\r\n]/.test(auth.key) || auth.key.startsWith("xai-"))
    throw new ProviderUsageError(
      "Grok needs its saved subscription login to read limits.",
    );
  return auth.key;
}
export async function grokUsage(): Promise<{
  windows: UsageWindow[];
  source: string;
}> {
  // ACP metadata only: no session/new, prompts, or inference.
  const root = await mkdtemp(path.join(os.tmpdir(), "crouter-grok-usage-"));
  const client = new JsonLineClient(
    process.env.GROK_BIN || "grok",
    grokArgs,
    childEnv(),
    root,
    undefined,
    "acp",
  );
  try {
    await client.request(
      "initialize",
      {
        protocolVersion: "1",
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      8000,
    );
    const raw = await client.request("x.ai/billing", {}, 12000);
    const windows = creditsSchema.safeParse(raw).success
      ? decodeGrokCredits(raw)
      : decodeGrokBilling(raw);
    if (windows.length)
      return { windows, source: "Grok ACP · account billing" };
  } catch {
    // Current CLI versions omit this method on stdio. The saved-login REST endpoint is supported.
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(
      await boundedRead(
        path.join(
          process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
          "auth.json",
        ),
        65536,
      ),
    );
  } catch {
    throw new ProviderUsageError(
      "Grok saved login could not be read. Run grok login, then refresh limits.",
    );
  }
  const token = decodeGrokToken(raw);
  const windows = decodeGrokCredits(
    await usageJson(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "x-xai-token-auth": "xai-grok-cli",
        },
      },
    ),
  );
  if (!windows.length)
    throw new ProviderUsageError(
      "Grok billing returned no measured credit allowance for this account.",
    );
  return { windows, source: "Grok CLI billing API · existing host login" };
}
