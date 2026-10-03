import "server-only";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { JsonLineClient } from "./jsonline-client";
import { available, childEnv } from "./providers";
import { isDemo, dataDir } from "./config";
import { claudeUsage, UsageReadError } from "./claude-usage";
import { agyUsage } from "./agy-usage";
import { grokUsage } from "./grok-usage";
import { museUsage } from "./muse-usage";
import { ProviderUsageError } from "./usage-http";
import { resetAtSeconds } from "../usage";
import {
  claudeModelCatalog,
  decodeCodexModels,
  commandModelCatalog,
} from "./host-models";
import { providerNames } from "../types";
import type {
  Provider,
  ProviderInfo,
  UsageWindow,
  WorkerCandidate,
  RoutingPreferences,
} from "../types";
import {
  defaultRoutingPreferences,
  modelEnabled,
  applicableUsage,
  usageEligibility,
} from "../routing-policy";
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
  return buckets.slice(0, 32).flatMap(([id, bucket]) =>
    (["primary", "secondary"] as const).flatMap((key) => {
      const value = bucket[key];
      return value
        ? [
            {
              label: `${(bucket.limitName || id).slice(0, 60)} · ${key}`,
              usedPercent: Math.min(100, value.usedPercent),
              ...(value.resetsAt
                ? { resetsAt: resetAtSeconds(value.resetsAt, "seconds") }
                : {}),
              ...(value.windowDurationMins
                ? { windowDurationMins: value.windowDurationMins }
                : {}),
              // Named buckets can be model-specific. Unknown names are not universal gates.
              ...(id !== "codex" && bucket.limitName ? { model: id } : {}),
            },
          ]
        : [];
    }),
  );
}
const summarySchema = z.object({
  summary: z
    .object({
      lifetimeTokens: z.number().finite().nonnegative().nullable().optional(),
      peakDailyTokens: z.number().finite().nonnegative().nullable().optional(),
      currentStreakDays: z
        .number()
        .finite()
        .nonnegative()
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
export function decodeUsageSummary(raw: unknown): ProviderInfo["usageSummary"] {
  const summary = summarySchema.parse(raw).summary;
  if (!summary) return undefined;
  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => typeof value === "number"),
  );
}
async function codexClient() {
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
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
export async function codexUsage() {
  const client = await codexClient();
  try {
    return decodeUsage(await client.request("account/rateLimits/read"));
  } finally {
    client.close();
  }
}
export function retainUsage(
  row: ProviderInfo,
  previous?: ProviderInfo,
  now = Date.now(),
) {
  const age = previous?.checkedAt
    ? now - Date.parse(previous.checkedAt)
    : Infinity;
  if (previous && age < 15 * 60 * 1000) {
    row.windows = previous.windows.filter(
      (w) => !w.resetsAt || w.resetsAt * 1000 > now,
    );
    row.usageSummary = previous.usageSummary;
    row.checkedAt = previous.checkedAt;
    row.usageSource = previous.usageSource;
    row.usageStale = Boolean(row.windows.length || row.usageSummary);
  }
}
const providers = Object.keys(providerNames) as Provider[];
let cached: ProviderInfo[] | undefined;
let expires = 0;
let pending: Promise<ProviderInfo[]> | undefined;
let cacheKey = "";
const retryAt = new Map<Provider, number>();
async function collect(previous?: ProviderInfo[]): Promise<ProviderInfo[]> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const rows = await Promise.all(
    providers.map(async (id): Promise<ProviderInfo> => ({
      id,
      name: providerNames[id],
      installed: !isDemo() && (await available(id)),
      runnable: !["agy", "muse"].includes(id) || process.platform === "darwin",
      detail: "Uses the CLI and saved account on this host",
      windows: [],
      models: [],
    })),
  );
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
  await Promise.all(
    rows.map(async (row) => {
      const old = previous?.find((p) => p.id === row.id);
      if (!row.installed) {
        row.usageError = "CLI unavailable on this host.";
        return;
      }
      const usageFailed = (error?: unknown) => {
        if (error instanceof UsageReadError)
          retryAt.set(row.id, Date.now() + error.retryAfterMs);
        row.usageError =
          error instanceof ProviderUsageError
            ? error.detail
            : error instanceof UsageReadError && old?.usageError
              ? old.usageError
              : "Host usage could not be refreshed.";
        retainUsage(row, old);
      };
      const modelsFailed = () => {
        // Keep an exact previously advertised catalog briefly; never invent model names.
        if (
          old?.checkedAt &&
          Date.now() - Date.parse(old.checkedAt) < 15 * 60 * 1000
        )
          row.models = old.models;
        row.modelsError = "Host model catalog could not be refreshed.";
      };
      if (row.id === "codex") {
        let client: JsonLineClient | undefined;
        try {
          client = await codexClient();
          const results = await Promise.allSettled([
            client.request("account/rateLimits/read").then(decodeUsage),
            client
              .request("model/list", { limit: 64, includeHidden: false })
              .then(decodeCodexModels),
            client.request("account/usage/read").then(decodeUsageSummary),
          ]);
          const [usage, models, summary] = results;
          if (usage.status === "fulfilled") {
            row.windows = usage.value;
            row.checkedAt = new Date().toISOString();
            row.usageSource = "Codex app-server · account limits and usage";
            if (!row.windows.length)
              row.usageError = "This host account returned no quota windows.";
          } else usageFailed();
          if (models.status === "fulfilled") row.models = models.value;
          else modelsFailed();
          if (summary.status === "fulfilled") row.usageSummary = summary.value;
        } catch {
          usageFailed();
          modelsFailed();
        } finally {
          client?.close();
        }
      } else if (row.id === "claude") {
        const [usage, models] = await Promise.allSettled([
          Date.now() < (retryAt.get(row.id) || 0)
            ? Promise.reject(
                new UsageReadError(retryAt.get(row.id)! - Date.now()),
              )
            : claudeUsage(),
          claudeModelCatalog(),
        ]);
        if (usage.status === "fulfilled") {
          row.windows = usage.value;
          row.checkedAt = new Date().toISOString();
          row.usageSource = "Anthropic OAuth usage · existing host account";
          if (!row.windows.length)
            row.usageError = "This host account returned no quota windows.";
        } else {
          usageFailed(usage.reason);
        }
        if (models.status === "fulfilled") row.models = models.value;
        else modelsFailed();
      } else {
        try {
          row.models =
            row.id === "muse"
              ? [
                  {
                    id: "default",
                    name: "Host CLI default",
                    description:
                      "Model and effort use the existing CLI defaults.",
                    efforts: ["default"],
                    defaultEffort: "default",
                  },
                ]
              : await commandModelCatalog(row.id);
        } catch {
          modelsFailed();
        }
        try {
          if (Date.now() < (retryAt.get(row.id) || 0))
            throw new UsageReadError(retryAt.get(row.id)! - Date.now());
          if (row.id === "grok") {
            const usage = await grokUsage();
            row.windows = usage.windows;
            row.usageSource = usage.source;
          } else if (row.id === "muse") {
            row.windows = await museUsage();
            row.usageSource = "Muse subscription API · existing host login";
          } else {
            row.windows = await agyUsage(row.models);
            row.usageSource = "Antigravity CLI · native /usage quota read";
          }
          row.checkedAt = new Date().toISOString();
          retryAt.delete(row.id);
          if (!row.windows.length)
            row.usageError =
              "This host account returned no supported quota windows.";
        } catch (error) {
          usageFailed(error);
        }
      }
    }),
  );
  return rows;
}
export async function providerCatalog(): Promise<ProviderInfo[]> {
  const key = JSON.stringify([
    isDemo(),
    dataDir(),
    ...providers.map((id) => process.env[`${id.toUpperCase()}_BIN`]),
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    process.env.GROK_HOME,
    process.env.MUSE_AUTH_PATH,
    process.env.XDG_CONFIG_HOME,
  ]);
  if (key !== cacheKey) {
    cached = undefined;
    expires = 0;
    pending = undefined;
    retryAt.clear();
    cacheKey = key;
  }
  if (cached && Date.now() < expires) return structuredClone(cached);
  pending ??= collect(cached)
    .then((rows) => {
      cached = rows;
      const now = Date.now();
      // Refresh at the next reset even if the usual metadata cache is still live.
      expires = Math.min(
        now + 60000,
        ...rows.flatMap((row) =>
          row.windows.flatMap((w) =>
            w.resetsAt && w.resetsAt * 1000 > now ? [w.resetsAt * 1000] : [],
          ),
        ),
      );
      return rows;
    })
    .finally(() => {
      pending = undefined;
    });
  return structuredClone(await pending);
}
export function workerCandidates(
  rows: ProviderInfo[],
  requested: Provider | "auto" = "auto",
  now = Date.now(),
  preferences: RoutingPreferences = defaultRoutingPreferences,
): WorkerCandidate[] {
  const candidates: WorkerCandidate[] = [];
  for (const row of rows) {
    if (
      !row.installed ||
      !row.runnable ||
      (requested !== "auto" && requested !== row.id)
    )
      continue;
    for (const model of row.models) {
      if (!modelEnabled(preferences, { provider: row.id, model: model.id }))
        continue;
      if (
        preferences.usageAware &&
        !usageEligibility(row, model.id, preferences.minRemainingPercent, now)
          .eligible
      )
        continue;
      const windows = preferences.usageAware
        ? applicableUsage(row, model.id, now)
        : [];
      for (const effort of model.efforts)
        candidates.push({
          id: `W-${candidates.length}`,
          provider: row.id,
          model: model.id,
          effort,
          description: `${model.name}. ${model.description}`.slice(0, 650),
          windows,
          usageStale: preferences.usageAware && Boolean(row.usageStale),
        });
    }
  }
  return candidates;
}
