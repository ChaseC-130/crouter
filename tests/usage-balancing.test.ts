import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usageBalance,
  usageEligibility,
  usageHeadroom,
  defaultRoutingPreferences,
} from "../lib/routing-policy";
import { resetAtSeconds } from "../lib/usage";
import { decodeUsage, workerCandidates } from "../lib/server/provider-catalog";
import { decodeClaudeUsage } from "../lib/server/claude-usage";
import { decodeAgyUsage, agyUsage } from "../lib/server/agy-usage";
import type { ProviderInfo, WorkerCandidate, WorkerModel } from "../lib/types";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const now = Date.parse("2030-01-01T00:00:00Z");
const reset = (minutes: number) => (now + minutes * 60000) / 1000;
function candidate(
  model: string,
  used: number,
  minutes: number,
  effort: "low" | "high" = "low",
): WorkerCandidate {
  return {
    id: model + effort,
    provider: "codex",
    model,
    effort,
    description: "Synthetic",
    usageStale: false,
    windows: [
      {
        label: model,
        usedPercent: used,
        resetsAt: reset(minutes),
        windowDurationMins: 300,
      },
    ],
  };
}
test("native reset formats normalize to the same timestamp without guessing units", () => {
  assert.equal(resetAtSeconds("2030-01-01T01:00:00+01:00", "iso"), now / 1000);
  assert.equal(resetAtSeconds(now / 1000, "seconds"), now / 1000);
  assert.equal(resetAtSeconds(now, "milliseconds"), now / 1000);
  assert.equal(resetAtSeconds("invalid", "iso"), undefined);
  assert.equal(resetAtSeconds(null, "seconds"), undefined);
  assert.equal(resetAtSeconds(Infinity, "seconds"), undefined);
  const codex = decodeUsage({
    rateLimits: {
      primary: {
        usedPercent: 25,
        resetsAt: reset(60),
        windowDurationMins: 300,
      },
    },
  });
  const claude = decodeClaudeUsage({
    five_hour: {
      utilization: 25,
      resets_at: new Date(reset(60) * 1000).toISOString(),
    },
  });
  assert.equal(codex[0].resetsAt, claude[0].resetsAt);
  assert.equal(
    usageHeadroom(codex, 20, now).score,
    usageHeadroom(claude, 20, now).score,
  );
});
test("balancing accounts for reset time, all windows, reserve and missing metadata", () => {
  const sooner = candidate("soon", 50, 30);
  const later = candidate("later", 50, 300);
  assert.ok(
    usageHeadroom(sooner.windows, 20, now).score >
      usageHeadroom(later.windows, 20, now).score,
  );
  const weekly = {
    label: "Weekly",
    usedPercent: 70,
    resetsAt: reset(10080),
    windowDurationMins: 10080,
  };
  assert.equal(usageHeadroom([...sooner.windows, weekly], 20, now).score, 10);
  assert.equal(
    usageHeadroom([{ label: "Unknown reset", usedPercent: 50 }], 20, now).score,
    30,
  );
  assert.equal(
    usageHeadroom([{ ...weekly, resetsAt: now / 1000 }], 20, now).score,
    0,
  );
});
test("weighted recommendations distribute requests; efforts and shared models do not multiply pool weight", () => {
  const a = candidate("a", 20, 300),
    b = candidate("b", 60, 300);
  const result = usageBalance(
    [a, { ...a, id: "high", effort: "high" }, b],
    20,
    now,
    () => 0,
  );
  assert.equal(result.get("codex:a")?.targetShare, 0.75);
  assert.equal(result.get("codex:b")?.targetShare, 0.25);
  let aCount = 0;
  for (let i = 0; i < 100; i++)
    if (
      usageBalance([a, b], 20, now, () => (i + 0.5) / 100).get("codex:a")
        ?.preferred
    )
      aCount++;
  assert.equal(aCount, 75);
  const shared = { ...a, model: "shared", id: "shared" };
  const pools = usageBalance([a, shared, b], 20, now, () => 0.9);
  assert.equal(pools.get("codex:a")?.targetShare, 0.375);
  assert.equal(pools.get("codex:shared")?.targetShare, 0.375);
  assert.equal(pools.get("codex:b")?.preferred, true);
});
test("a passed reset requires refresh even when another applicable window remains", () => {
  const row: ProviderInfo = {
    id: "codex",
    name: "Synthetic",
    installed: true,
    runnable: true,
    detail: "Host",
    checkedAt: new Date(now).toISOString(),
    models: [],
    windows: [
      { label: "5h", usedPercent: 99, resetsAt: now / 1000 },
      { label: "Weekly", usedPercent: 10, resetsAt: reset(10080) },
    ],
  };
  assert.equal(usageEligibility(row, "a", 20, now).eligible, false);
  const refreshed = {
    ...row,
    windows: row.windows.map((w) =>
      w.label === "5h" ? { ...w, usedPercent: 0, resetsAt: reset(300) } : w,
    ),
  };
  assert.equal(usageEligibility(refreshed, "a", 20, now).eligible, true);
});
const models: WorkerModel[] = [
  "gemini-test",
  "claude-test",
  "unknown-family",
].map((id) => ({
  id,
  name: id,
  description: "Synthetic",
  efforts: ["default"],
  defaultEffort: "default",
}));
const agyFixture = {
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          buckets: [
            {
              id: "gemini-5h",
              name: "Five hour",
              window: "5h",
              remaining_fraction: 0.8,
              reset_time: new Date(reset(60) * 1000).toISOString(),
            },
            {
              id: "3p-weekly",
              name: "Weekly",
              window: "weekly",
              remaining_fraction: 0.1,
              reset_time: new Date(reset(10080) * 1000).toISOString(),
            },
          ],
        },
      ],
    },
  },
};
test("Antigravity converts remaining fractions, native resets, and shared bucket scopes", () => {
  const windows = decodeAgyUsage(agyFixture, models);
  assert.ok(Math.abs(windows[0].usedPercent - 20) < 0.00001);
  assert.equal(windows[0].resetsAt, reset(60));
  assert.equal(windows[0].windowDurationMins, 300);
  assert.deepEqual(windows[0].models, ["gemini-test"]);
  assert.deepEqual(windows[1].models, ["claude-test"]);
  const row: ProviderInfo = {
    id: "agy",
    name: "Synthetic",
    installed: true,
    runnable: true,
    detail: "Host",
    checkedAt: new Date(now).toISOString(),
    models,
    windows,
  };
  const preferences = {
    ...defaultRoutingPreferences,
    usageAware: true,
    enabledModels: models.map((m) => ({
      provider: "agy" as const,
      model: m.id,
    })),
  };
  assert.deepEqual(
    workerCandidates([row], "auto", now, preferences).map((c) => c.model),
    ["gemini-test"],
  );
  assert.throws(() => decodeAgyUsage({ ...agyFixture, num_turns: 1 }, models));
  assert.throws(() =>
    decodeAgyUsage({ ...agyFixture, status: "ERROR" }, models),
  );
});
test("Antigravity quota adapter uses a metadata-only native command", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "crouter-agy-usage-"));
  const originalBin = process.env.AGY_BIN,
    originalDir = process.env.CROUTER_DATA_DIR;
  try {
    const bin = path.join(temp, "agy");
    await writeFile(
      bin,
      `#!/usr/bin/env node\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['-p','/usage','--output-format','json']))process.exit(2);console.log(${JSON.stringify(JSON.stringify(agyFixture))});`,
      { mode: 0o700 },
    );
    process.env.AGY_BIN = bin;
    process.env.CROUTER_DATA_DIR = temp;
    assert.equal((await agyUsage(models))[0].resetsAt, reset(60));
  } finally {
    if (originalBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = originalBin;
    if (originalDir === undefined) delete process.env.CROUTER_DATA_DIR;
    else process.env.CROUTER_DATA_DIR = originalDir;
    await rm(temp, { recursive: true, force: true });
  }
});

test("metadata cache refreshes at a native reset before the usual 60-second expiry", async () => {
  const { providerCatalog } = await import("../lib/server/provider-catalog");
  const { readFile } = await import("node:fs/promises");
  const temp = await mkdtemp(path.join(os.tmpdir(), "crouter-reset-cache-"));
  const keys = [
    "CODEX_BIN",
    "CLAUDE_BIN",
    "GROK_BIN",
    "AGY_BIN",
    "MUSE_BIN",
    "CROUTER_DATA_DIR",
    "CROUTER_DEMO",
  ];
  const env = new Map(keys.map((key) => [key, process.env[key]]));
  const originalNow = Date.now;
  try {
    const counter = path.join(temp, "reads"),
      bin = path.join(temp, "codex");
    const startsAt = originalNow();
    await writeFile(
      bin,
      `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('synthetic');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(!p.id)return;
if(p.method==='account/rateLimits/read')require('node:fs').appendFileSync(${JSON.stringify(counter)},'read\\n');
const result=p.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:${(startsAt + 5000) / 1000}}}}:p.method==='model/list'?{data:[],nextCursor:null}:{};
console.log(JSON.stringify({id:p.id,result}));});`,
      { mode: 0o700 },
    );
    process.env.CODEX_BIN = bin;
    process.env.CROUTER_DATA_DIR = temp;
    process.env.CROUTER_DEMO = "0";
    for (const key of keys.slice(1, 5))
      process.env[key] = path.join(temp, "missing");
    Date.now = () => startsAt;
    await providerCatalog();
    await providerCatalog();
    assert.equal(
      (await readFile(counter, "utf8")).trim().split("\n").length,
      1,
    );
    Date.now = () => startsAt + 5001;
    await providerCatalog();
    assert.equal(
      (await readFile(counter, "utf8")).trim().split("\n").length,
      2,
    );
  } finally {
    Date.now = originalNow;
    for (const [key, value] of env)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(temp, { recursive: true, force: true });
  }
});
