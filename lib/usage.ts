import type { UsageWindow } from "./types";

// Adapters declare their native timestamp unit; routing/UI always use Unix seconds.
export function resetAtSeconds(
  value: string | number | null | undefined,
  format: "iso" | "seconds" | "milliseconds",
) {
  const seconds =
    format === "iso"
      ? typeof value === "string"
        ? Date.parse(value) / 1000
        : NaN
      : typeof value === "number"
        ? value / (format === "milliseconds" ? 1000 : 1)
        : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
export function usageApplies(window: UsageWindow, model: string) {
  return window.models
    ? window.models.includes(model)
    : !window.model || window.model === model || model.includes(window.model);
}
