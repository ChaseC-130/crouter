import type {
  ModelRef,
  RoutingPreferenceChange,
  ProviderInfo,
  RoutingPreferences,
  UsageWindow,
  WorkerCandidate,
} from "./types";
import { usageApplies } from "./usage";

export const defaultRoutingPreferences: RoutingPreferences = {
  enabledModels: [],
  usageAware: false,
  minRemainingPercent: 20,
  instructions: "",
  rules: [],
};
export function modelEnabled(preferences: RoutingPreferences, ref: ModelRef) {
  return preferences.enabledModels.some(
    (m) => m.provider === ref.provider && m.model === ref.model,
  );
}
export function applyRoutingPreference(
  current: RoutingPreferences,
  change: RoutingPreferenceChange,
): RoutingPreferences {
  if (change.operation === "rules")
    return {
      ...current,
      instructions: change.instructions,
      rules: change.rules,
    };
  if (change.operation === "usage")
    return { ...current, usageAware: change.enabled };
  if (change.operation === "reserve")
    return { ...current, minRemainingPercent: change.minRemainingPercent };
  const refs =
    change.operation === "models"
      ? change.models
      : [{ provider: change.provider, model: change.model }];
  const enabledModels = current.enabledModels.filter(
    (m) =>
      !refs.some((ref) => ref.provider === m.provider && ref.model === m.model),
  );
  if (change.enabled) {
    for (const ref of refs) {
      if (
        !enabledModels.some(
          (m) => m.provider === ref.provider && m.model === ref.model,
        )
      )
        enabledModels.push(ref);
    }
  }
  return { ...current, enabledModels };
}
export function applicableUsage(
  row: ProviderInfo,
  model: string,
  now = Date.now(),
): UsageWindow[] {
  return row.windows.filter(
    (w) => (!w.resetsAt || w.resetsAt * 1000 > now) && usageApplies(w, model),
  );
}
function modelUsage(row: ProviderInfo, model: string) {
  return row.windows.filter((w) => usageApplies(w, model));
}
export function usageEligibility(
  row: ProviderInfo,
  model: string,
  minimum: number,
  now = Date.now(),
): { eligible: boolean; reason?: string } {
  const windows = applicableUsage(row, model, now);
  if (
    row.usageStale ||
    row.usageError ||
    !row.checkedAt ||
    now - Date.parse(row.checkedAt) > 120000 ||
    !Number.isFinite(Date.parse(row.checkedAt)) ||
    !windows.length
  )
    return { eligible: false, reason: "Fresh usage unavailable" };
  // A passed reset invalidates the reading; never assume that quota replenished.
  if (
    modelUsage(row, model).some(
      (w) => w.resetsAt !== undefined && w.resetsAt * 1000 <= now,
    )
  )
    return { eligible: false, reason: "Usage reset passed; refresh required" };
  if (
    windows.some((w) => w.usedPercent >= 100 || 100 - w.usedPercent < minimum)
  )
    return { eligible: false, reason: `Below ${minimum}% usage reserve` };
  return { eligible: true };
}

export function usageHeadroom(
  windows: UsageWindow[],
  minimum: number,
  now = Date.now(),
) {
  if (!windows.length) return { remainingPercent: 0, score: 0 };
  const remainingPercent = Math.min(...windows.map((w) => 100 - w.usedPercent));
  const score = Math.min(
    ...windows.map((w) => {
      if (w.resetsAt !== undefined && w.resetsAt * 1000 <= now) return 0;
      const remaining = Math.max(0, 100 - w.usedPercent - minimum);
      // Compare the fraction of quota left with the fraction of its window left.
      // Missing duration/reset metadata means percentage-only balancing.
      const fraction =
        w.resetsAt && w.windowDurationMins
          ? Math.max(
              0.05,
              Math.min(
                1,
                (w.resetsAt * 1000 - now) / (w.windowDurationMins * 60000),
              ),
            )
          : 1;
      return remaining / fraction;
    }),
  );
  return { remainingPercent, score };
}

export function usageBalance(
  candidates: WorkerCandidate[],
  minimum: number,
  now = Date.now(),
  random = Math.random,
) {
  // Multiple effort profiles and models sharing one allowance must not multiply its weight.
  const pools = new Map<
    string,
    { score: number; models: Map<string, ReturnType<typeof usageHeadroom>> }
  >();
  for (const c of candidates) {
    if (c.usageStale || !c.windows.length) continue;
    const key = JSON.stringify([c.provider, c.windows]);
    const headroom = usageHeadroom(c.windows, minimum, now);
    const pool = pools.get(key) || { score: headroom.score, models: new Map() };
    pool.models.set(`${c.provider}:${c.model}`, headroom);
    pools.set(key, pool);
  }
  const total = [...pools.values()].reduce((sum, p) => sum + p.score, 0);
  const result = new Map<
    string,
    {
      remainingPercent: number;
      resetAdjustedHeadroom: number;
      targetShare: number;
      preferred: boolean;
    }
  >();
  for (const pool of pools.values()) {
    for (const [key, value] of pool.models)
      result.set(key, {
        remainingPercent: value.remainingPercent,
        resetAdjustedHeadroom: value.score,
        targetShare:
          total > 0
            ? pool.score / total / pool.models.size
            : 1 / pools.size / pool.models.size,
        preferred: false,
      });
  }
  let draw = random();
  for (const value of result.values()) {
    draw -= value.targetShare;
    if (draw < 0) {
      value.preferred = true;
      break;
    }
  }
  return result;
}
