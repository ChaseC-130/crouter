import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeClaudeUsage, claudeUsage } from "../lib/server/claude-usage";
import {
  decodeClaudeModels,
  decodeCodexModels,
  claudeModelCatalog,
  decodeCommandModels,
} from "../lib/server/host-models";
import {
  providerCatalog,
  retainUsage,
  workerCandidates,
  decodeUsageSummary,
} from "../lib/server/provider-catalog";
import { resolveProjectPath } from "../lib/server/project-paths";
import { providerCommand } from "../lib/server/providers";
import type { ProviderInfo } from "../lib/types";
import { defaultRoutingPreferences } from "../lib/routing-policy";
const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "crouter-host-")),
);
const keys = [
  "CROUTER_DEMO",
  "CROUTER_DATA_DIR",
  "CROUTER_PROJECTS_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_BIN",
  "CLAUDE_BIN",
  "GROK_BIN",
  "AGY_BIN",
  "MUSE_BIN",
];
const env = new Map(keys.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of env) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
after(() => rm(temp, { recursive: true, force: true }));
const token = ["synthetic", "oauth", "placeholder"].join("-");
async function credentials() {
  const dir = path.join(temp, "claude");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 60000 },
    }),
    { mode: 0o600 },
  );
  process.env.CLAUDE_CONFIG_DIR = dir;
}
test("Claude usage preserves percentages and scoped limits without exposing credentials", async () => {
  const fixture = {
    five_hour: { utilization: 1, resets_at: "2030-01-01T00:00:00Z" },
    seven_day: { utilization: 7 },
    seven_day_oauth_apps: { utilization: 4 },
    limits: [
      {
        kind: "weekly_scoped",
        percent: 100,
        scope: { model: { id: "test-large", display_name: "Large" } },
      },
    ],
  };
  const decoded = decodeClaudeUsage(fixture);
  assert.equal(decoded[0].usedPercent, 1);
  assert.equal(decoded[1].usedPercent, 4);
  assert.equal(decoded[2].model, "test-large");
  assert.equal(
    decodeClaudeUsage({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 3,
          scope: { model: { id: null, display_name: "Synthetic" } },
        },
      ],
    })[0].model,
    "synthetic",
  );
  await credentials();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${token}`,
    );
    assert.equal(init?.redirect, "error");
    return Response.json({ ...fixture, accessToken: token });
  };
  const result = await claudeUsage();
  assert.deepEqual(result, decoded);
  assert.ok(!JSON.stringify(result).includes(token));
  await writeFile(
    path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 1 } }),
  );
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error();
  };
  await assert.rejects(() => claudeUsage(), /expired/);
  assert.equal(called, false);
});
test("model catalogs use resolved host IDs and validate supported efforts", () => {
  assert.deepEqual(
    decodeCommandModels(
      "agy",
      "Fetching available models...\nsynthetic-high\tSynthetic (High)\n",
    ).map((m) => m.id),
    ["synthetic-high"],
  );
  assert.deepEqual(
    decodeCommandModels(
      "grok",
      "Default model: synthetic-large\nAvailable models:\n  * synthetic-large (default)\n  - synthetic-small\n",
    ).map((m) => m.id),
    ["synthetic-large", "synthetic-small"],
  );
  assert.throws(
    () =>
      decodeCommandModels(
        "grok",
        "You are not authenticated.\n - cached-model\n",
      ),
    /unavailable/,
  );
  const models = decodeClaudeModels([
    {
      value: "default",
      resolvedModel: "test-sonnet",
      displayName: "Default",
      supportedEffortLevels: ["low", "high"],
    },
    {
      value: "sonnet",
      resolvedModel: "test-sonnet",
      displayName: "Sonnet",
      supportedEffortLevels: ["low", "high"],
    },
    { value: "small", displayName: "Small" },
  ]);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "test-sonnet");
  assert.deepEqual(models[1].efforts, ["default"]);
  assert.throws(() =>
    decodeCodexModels({
      data: [
        {
          model: "--unsafe",
          displayName: "Bad",
          description: "",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [],
        },
      ],
    }),
  );
  assert.throws(() =>
    decodeClaudeModels([
      {
        value: "test",
        displayName: "Test",
        supportedEffortLevels: ["invented"],
      },
    ]),
  );
  assert.deepEqual(
    decodeUsageSummary({
      summary: { lifetimeTokens: 123, currentStreakDays: null },
      account: { email: "private@example.test" },
    }),
    { lifetimeTokens: 123 },
  );
});
test("fresh exhausted model-scoped quota filters only applicable profiles with usage routing enabled", () => {
  const row: ProviderInfo = {
    id: "claude",
    name: "Claude",
    installed: true,
    runnable: true,
    detail: "Host",
    checkedAt: new Date().toISOString(),
    windows: [
      { label: "General", usedPercent: 20 },
      { label: "Scoped", model: "test-large", usedPercent: 100 },
    ],
    models: ["test-large", "test-small"].map((id) => ({
      id,
      name: id,
      description: "",
      efforts: ["low", "high"],
      defaultEffort: "high",
    })),
  };
  assert.deepEqual(
    workerCandidates([row], "auto", Date.now(), {
      ...defaultRoutingPreferences,
      enabledModels: row.models.map((m) => ({ provider: row.id, model: m.id })),
      usageAware: true,
    }).map((c) => c.model),
    ["test-small", "test-small"],
  );
  assert.equal(
    workerCandidates([{ ...row, usageStale: true }], "auto", Date.now(), {
      ...defaultRoutingPreferences,
      enabledModels: row.models.map((m) => ({ provider: row.id, model: m.id })),
      usageAware: true,
    }).length,
    0,
  );
  assert.equal(workerCandidates([row]).length, 0);
  assert.equal(
    workerCandidates([row], "auto", Date.now(), {
      ...defaultRoutingPreferences,
      enabledModels: row.models.map((m) => ({ provider: row.id, model: m.id })),
    }).length,
    4,
  );
  assert.equal(workerCandidates([{ ...row, installed: false }]).length, 0);
  assert.equal(workerCandidates([row], "codex").length, 0);
  const now = Date.now();
  const previous = {
    ...row,
    checkedAt: new Date(now - 10000).toISOString(),
    windows: [
      { label: "Expired", usedPercent: 10, resetsAt: (now - 1) / 1000 },
      { label: "Current", usedPercent: 20, resetsAt: (now + 10000) / 1000 },
    ],
  };
  const failed = { ...row, windows: [] };
  retainUsage(failed, previous, now);
  assert.equal(failed.windows.length, 1);
  assert.equal(failed.usageStale, true);
  const tooOld = { ...row, windows: [] };
  retainUsage(tooOld, previous, now + 16 * 60000);
  assert.equal(tooOld.windows.length, 0);
});
test("relative and tilde paths resolve on the host and reserved directories are rejected", async () => {
  process.env.CROUTER_PROJECTS_DIR = temp;
  process.env.CROUTER_DATA_DIR = path.join(temp, "runtime");
  await mkdir(path.join(temp, "project"), { recursive: true });
  await mkdir(path.join(temp, "runtime"), { recursive: true });
  assert.equal(
    await resolveProjectPath("./project/../project"),
    path.join(temp, "project"),
  );
  assert.equal(
    await resolveProjectPath(path.join(temp, "project")),
    path.join(temp, "project"),
  );
  await assert.rejects(() => resolveProjectPath("~"), /specific project/);
  await assert.rejects(() => resolveProjectPath("/"), /specific project/);
  await assert.rejects(() => resolveProjectPath("runtime"), /specific project/);
  await assert.rejects(() => resolveProjectPath("nonexistent"), /inaccessible/);
});
test("saved model and effort flags survive resume and cannot inject CLI options", () => {
  const session = "11111111-1111-4111-8111-111111111111";
  for (const provider of ["codex", "claude"] as const)
    for (const thread of [undefined, session]) {
      const args = providerCommand(provider, thread, undefined, {
        model: "synthetic-model",
        effort: "high",
      }).args;
      assert.ok(args.includes("synthetic-model"));
      assert.ok(
        args.includes(
          provider === "codex" ? 'model_reasoning_effort="high"' : "high",
        ),
      );
      if (thread) assert.ok(args.includes(thread));
    }
  assert.throws(
    () => providerCommand("codex", undefined, undefined, { model: "--danger" }),
    /Invalid saved/,
  );
});
test("host discovery performs metadata-only handshakes and caches normalized account reads", async () => {
  await credentials();
  process.env.CROUTER_DEMO = "0";
  process.env.CROUTER_DATA_DIR = path.join(temp, "catalog");
  await mkdir(process.env.CROUTER_DATA_DIR, { recursive: true });
  const counter = path.join(temp, "handshakes");
  const codex = path.join(temp, "fake-codex");
  const claude = path.join(temp, "fake-claude");
  await writeFile(
    codex,
    `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('synthetic');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(!p.id)return;
const result=p.method==='model/list'?{data:[{model:'test-codex',displayName:'Test',description:'Synthetic',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}:p.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:20}}}:p.method==='account/usage/read'?{summary:{lifetimeTokens:1234}}:{};console.log(JSON.stringify({id:p.id,result}));});`,
    { mode: 0o700 },
  );
  await writeFile(
    claude,
    `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('synthetic');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.type!=='control_request'||p.request.subtype!=='initialize')process.exit(3);
require('node:fs').appendFileSync(${JSON.stringify(counter)},'initialize\\n');console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:p.request_id,response:{models:[{value:'default',resolvedModel:'test-claude',displayName:'Test Claude',supportedEffortLevels:['low','high']}]},account:{secret:'never-return'}}}));});`,
    { mode: 0o700 },
  );
  process.env.CODEX_BIN = codex;
  process.env.CLAUDE_BIN = claude;
  for (const k of ["GROK_BIN", "AGY_BIN", "MUSE_BIN"])
    process.env[k] = path.join(temp, "missing-client");
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return Response.json({ five_hour: { utilization: 2 } });
  };
  const models = await claudeModelCatalog();
  assert.equal(models[0].id, "test-claude");
  const [first, simultaneous] = await Promise.all([
    providerCatalog(),
    providerCatalog(),
  ]);
  assert.deepEqual(first, simultaneous);
  assert.equal(reads, 1);
  assert.equal(first[0].usageSummary?.lifetimeTokens, 1234);
  assert.equal(
    first.find((p) => p.id === "claude")?.models[0].id,
    "test-claude",
  );
  assert.ok(!JSON.stringify(first).includes(token));
  assert.ok(!JSON.stringify(first).includes("never-return"));
  first[0].windows[0].usedPercent = 99;
  assert.equal((await providerCatalog())[0].windows[0].usedPercent, 20);
  assert.equal(reads, 1);
  assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 2);
});
