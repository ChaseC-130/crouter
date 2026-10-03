export const efforts = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export function validModel(value) {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(value)
  );
}
export function validSelection(value) {
  return (
    (value.model === undefined || validModel(value.model)) &&
    (value.effort === undefined || efforts.includes(value.effort))
  );
}
