import path from "node:path";
export function dataDir() {
  return path.resolve(
    process.env.CROUTER_DATA_DIR || path.join(process.cwd(), ".crouter"),
  );
}
export function isDemo() {
  return process.env.CROUTER_DEMO === "1";
}
export function workerTimeout() {
  const n = Number(process.env.WORKER_TIMEOUT_MS || 120000);
  return Number.isFinite(n) ? Math.max(10000, Math.min(n, 600000)) : 120000;
}
