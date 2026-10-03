import "server-only";
import { z } from "zod";
import { JsonLineClient } from "./jsonline-client";
import { available, childEnv } from "./providers";
import { isDemo, dataDir } from "./config";
import { mkdir } from "node:fs/promises";
import type { ProviderInfo, UsageWindow } from "../types";
const windowSchema = z.object({
  usedPercent: z.number().finite().min(0),
  windowDurationMins: z.number().positive().nullable().optional(),
  resetsAt: z.number().positive().nullable().optional(),
});
const bucketSchema = z.object({
  limitName: z.string().nullable().optional(),
  primary: windowSchema.nullable().optional(),
  secondary: windowSchema.nullable().optional(),
});
const limitsSchema = z.object({
  rateLimits: bucketSchema.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullable().optional(),
});
export function decodeUsage(raw: unknown): UsageWindow[] {
  const parsed = limitsSchema.parse(raw);
  const buckets =
    parsed.rateLimitsByLimitId && Object.keys(parsed.rateLimitsByLimitId).length
      ? Object.entries(parsed.rateLimitsByLimitId)
      : parsed.rateLimits
        ? [["codex", parsed.rateLimits] as const]
        : [];
  return buckets.flatMap(([id, bucket]) =>
    ["primary", "secondary"].flatMap((key) => {
      const value = bucket[key as "primary" | "secondary"];
      return value
        ? [
            {
              label: `${(bucket.limitName || id).slice(0, 60)} · ${key}`,
              usedPercent: Math.min(100, value.usedPercent),
              ...(value.resetsAt ? { resetsAt: value.resetsAt } : {}),
              ...(value.windowDurationMins
                ? { windowDurationMins: value.windowDurationMins }
                : {}),
            },
          ]
        : [];
    }),
  );
}
export async function codexUsage() {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const client = new JsonLineClient(
    process.env.CODEX_BIN || "codex",
    ["app-server", "--listen", "stdio://", "-c", "analytics.enabled=false"],
    childEnv(),
    dataDir(),
  );
  try {
    await client.request("initialize", {
      clientInfo: { name: "crouter", title: "crouter", version: "0.1.0" },
    });
    client.notify("initialized");
    return decodeUsage(await client.request("account/rateLimits/read"));
  } finally {
    client.close();
  }
}
export async function providerCatalog(): Promise<ProviderInfo[]> {
  const [codex, claude, grok, gemini, agy, muse] = isDemo()
    ? [false, false, false, false, false, false]
    : await Promise.all([
        available("codex"),
        available("claude"),
        available("grok"),
        available("gemini"),
        available("agy"),
        available("muse"),
      ]);
  const rows: ProviderInfo[] = [
    {
      id: "codex",
      name: "ChatGPT · Codex",
      runnable: true,
      installed: codex,
      detail: "Official CLI · saved subscription login",
      windows: [],
      url: "https://learn.chatgpt.com/docs/cli",
    },
    {
      id: "claude",
      name: "Claude Code",
      runnable: true,
      installed: claude,
      detail: "Official CLI · saved subscription login",
      windows: [],
      usageError:
        "No verified subscription quota read interface is integrated. Check Claude’s own usage page.",
      url: "https://claude.ai/settings/usage",
    },
    {
      id: "grok",
      name: "Grok Build",
      runnable: true,
      installed: grok,
      detail: "Official CLI · local login · ACP sessions",
      windows: [],
      usageError:
        "Subscription quota unavailable through the verified local CLI contract. Use Settings → Usage in Grok.",
      url: "https://grok.com",
    },
    {
      id: "agy",
      runnable: process.platform === "darwin",
      installed: agy,
      name: "Antigravity · agy",
      detail:
        "Official Google CLI · native read-only filesystem barrier (macOS)",
      windows: [],
      usageError:
        "Subscription quota is unavailable through this adapter. Use /usage in the official CLI.",
      url: "https://www.antigravity.google/docs/cli/headless/",
    },
    {
      id: "muse",
      name: "Muse Code",
      runnable: process.platform === "darwin",
      installed: muse,
      detail: "Official CLI · retained session UUID · read-only tools (macOS)",
      windows: [],
      usageError:
        "Subscription quota is unavailable through this adapter. Check the official provider account.",
      url: "https://meta-models.github.io/muse-code-sdk/next/",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      runnable: process.platform === "darwin",
      installed: gemini,
      detail:
        "Official Google CLI · plan mode · read-only filesystem barrier (macOS)",
      windows: [],
      usageError:
        "Subscription quota is unavailable through this adapter. CLI token statistics are separate from subscription allowance.",
      url: "https://geminicli.com/docs/quota-and-pricing/",
    },
  ];
  if (isDemo()) {
    rows[0].windows = [
      {
        label: "Synthetic demo · primary",
        usedPercent: 28,
        windowDurationMins: 300,
      },
    ];
    rows[0].usageSource = "Synthetic demo — no account accessed";
    return rows;
  }
  if (codex)
    try {
      rows[0].windows = await codexUsage();
      rows[0].usageSource =
        "Official Codex app-server · account/rateLimits/read";
      rows[0].checkedAt = new Date().toISOString();
      if (!rows[0].windows.length)
        rows[0].usageError =
          "The CLI did not return quota windows for this login.";
    } catch {
      rows[0].usageError =
        "Quota unavailable. Check your local login, subscription, and CLI version.";
    }
  else
    rows[0].usageError =
      "Install the official CLI and log in to read quota windows.";
  return rows;
}
