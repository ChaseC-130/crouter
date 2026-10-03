import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  stat,
  readFile,
  mkdir,
  writeFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { db } from "../lib/server/db";
import {
  routingPreferences,
  routingPreferencesFile,
  updateRoutingPreferences,
} from "../lib/server/routing-preferences";
import { defaultRoutingPreferences } from "../lib/routing-policy";
import { workerCandidates } from "../lib/server/provider-catalog";
import { routingPayload } from "../lib/server/routing";
import { POST } from "../app/api/routing-preferences/route";
import type { ProviderInfo, RoutingPreferences } from "../lib/types";
const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "crouter-preferences-")),
);
process.env.CROUTER_DATA_DIR = path.join(temp, "private");
process.env.CROUTER_ORIGIN = "http://127.0.0.1:3000";
delete process.env.CROUTER_TAILSCALE_ORIGIN;
delete process.env.CROUTER_DEMO;
const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  db().exec("DELETE FROM preferences");
  await rm(routingPreferencesFile(), { force: true });
});
after(async () => {
  db().close();
  await rm(temp, { recursive: true, force: true });
});
const now = Date.now();
function row(windows: ProviderInfo["windows"]): ProviderInfo {
  return {
    id: "codex",
    name: "Synthetic CLI",
    installed: true,
    runnable: true,
    detail: "Host",
    windows,
    checkedAt: new Date(now).toISOString(),
    models: ["test-heavy", "test-light"].map((id) => ({
      id,
      name: id,
      description: "Synthetic",
      efforts: ["low", "high"],
      defaultEffort: "low",
    })),
  };
}
const selectedPreferences: RoutingPreferences = {
  ...defaultRoutingPreferences,
  enabledModels: ["codex", "claude"].flatMap((provider) =>
    ["test-heavy", "test-light"].map((model) => ({
      provider: provider as "codex" | "claude",
      model,
    })),
  ),
};
const usageOn: RoutingPreferences = {
  ...selectedPreferences,
  usageAware: true,
};
test("local preference changes persist and preserve independent provider/model choices", async () => {
  assert.deepEqual(routingPreferences(), defaultRoutingPreferences);
  updateRoutingPreferences({
    operation: "model",
    provider: "codex",
    model: "test-heavy",
    enabled: false,
  });
  updateRoutingPreferences({
    operation: "model",
    provider: "claude",
    model: "test-heavy",
    enabled: false,
  });
  updateRoutingPreferences({ operation: "usage", enabled: true });
  updateRoutingPreferences({ operation: "reserve", minRemainingPercent: 35 });
  updateRoutingPreferences({
    operation: "model",
    provider: "codex",
    model: "test-heavy",
    enabled: true,
  });
  const expected = {
    ...defaultRoutingPreferences,
    enabledModels: [{ provider: "codex", model: "test-heavy" }],
    usageAware: true,
    minRemainingPercent: 35,
  };
  assert.deepEqual(routingPreferences(), expected);
  assert.throws(() =>
    updateRoutingPreferences({
      operation: "reserve",
      minRemainingPercent: 101,
    }),
  );
  assert.throws(() =>
    updateRoutingPreferences({
      operation: "model",
      provider: "codex",
      model: "--bad-option",
      enabled: false,
    }),
  );
  assert.deepEqual(routingPreferences(), expected);
  const file = routingPreferencesFile();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), expected);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test("usage opt-in enforces the reserve in both 5-hour and weekly windows, for every effort", () => {
  const windows = [
    { label: "5 hours", windowDurationMins: 300, usedPercent: 80 },
    { label: "Weekly", windowDurationMins: 10080, usedPercent: 80 },
  ];
  assert.equal(
    workerCandidates([row(windows)], "auto", now, usageOn).length,
    4,
  );
  for (const index of [0, 1]) {
    const low = structuredClone(windows);
    low[index].usedPercent = 81;
    assert.equal(workerCandidates([row(low)], "auto", now, usageOn).length, 0);
    const off = workerCandidates([row(low)], "auto", now, selectedPreferences);
    assert.equal(off.length, 4);
    assert.ok(off.every((c) => c.windows.length === 0));
  }
  assert.equal(
    workerCandidates([row(windows)], "auto", now, {
      ...usageOn,
      minRemainingPercent: 25,
    }).length,
    0,
  );
  assert.equal(
    workerCandidates(
      [row([{ label: "Exhausted", usedPercent: 100 }])],
      "auto",
      now,
      { ...usageOn, minRemainingPercent: 0 },
    ).length,
    0,
  );
});
test("unknown, stale, expired and unrelated model quotas cannot qualify when usage-aware routing is on", () => {
  const fresh = row([
    { label: "Remaining", usedPercent: 10, resetsAt: (now + 60000) / 1000 },
  ]);
  for (const value of [
    { ...fresh, usageStale: true },
    { ...fresh, usageError: "Unavailable" },
    { ...fresh, checkedAt: undefined },
    { ...fresh, checkedAt: new Date(now - 121000).toISOString() },
    { ...fresh, windows: [] },
    {
      ...fresh,
      windows: [
        { label: "Expired", usedPercent: 1, resetsAt: (now - 1) / 1000 },
      ],
    },
    {
      ...fresh,
      windows: [{ label: "Other model", usedPercent: 1, model: "unrelated" }],
    },
  ])
    assert.equal(workerCandidates([value], "auto", now, usageOn).length, 0);
  const scoped = row([
    { label: "5 hours", usedPercent: 10 },
    { label: "Weekly", usedPercent: 10 },
    { label: "Heavy weekly", usedPercent: 95, model: "test-heavy" },
  ]);
  assert.deepEqual(
    workerCandidates([scoped], "auto", now, usageOn).map((c) => c.model),
    ["test-light", "test-light"],
  );
});
test("model switches remove every effort and remain scoped to their CLI, even with provider overrides", () => {
  const source = row([{ label: "Remaining", usedPercent: 1 }]);
  const preferences: RoutingPreferences = {
    ...selectedPreferences,
    enabledModels: selectedPreferences.enabledModels.filter(
      (m) => m.provider !== "codex" || m.model !== "test-heavy",
    ),
  };
  assert.deepEqual(
    workerCandidates([source], "codex", now, preferences).map((c) => c.model),
    ["test-light", "test-light"],
  );
  assert.equal(
    workerCandidates([{ ...source, id: "claude" }], "claude", now, preferences)
      .length,
    4,
  );
  assert.equal(
    workerCandidates([source], "auto", now, {
      ...preferences,
      enabledModels: [],
    }).length,
    0,
  );
});
test("quota metadata is omitted from classifier payloads unless the user opts in", () => {
  const candidates = workerCandidates(
    [row([{ label: "Remaining", usedPercent: 10 }])],
    "auto",
    now,
    usageOn,
  );
  const registry = [{ id: "project", name: "Synthetic", aliases: [] }];
  const off = routingPayload(
    "Synthetic task",
    registry,
    "jev-latest",
    candidates,
  );
  assert.ok(!JSON.stringify(off).includes('"usedPercent"'));
  assert.ok(!JSON.stringify(off).includes('"usageStale"'));
  const on = routingPayload(
    "Synthetic task",
    registry,
    "jev-latest",
    candidates,
    true,
  );
  assert.equal(JSON.parse(on.state).workers[0].windows[0].usedPercent, 10);
});
test("preference writes require the existing same-origin mutation safeguards", async () => {
  const request = (origin: string, body: unknown) =>
    new Request("http://127.0.0.1:3000/api/routing-preferences", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-crouter-request": "1",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await POST(
        request("https://other.example", { operation: "usage", enabled: true }),
      )
    ).status,
    403,
  );
  assert.equal(routingPreferences().usageAware, false);
  assert.equal(
    (
      await POST(
        request("http://127.0.0.1:3000", {
          operation: "reserve",
          minRemainingPercent: -1,
        }),
      )
    ).status,
    400,
  );
  const response = await POST(
    request("http://127.0.0.1:3000", { operation: "usage", enabled: true }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).preferences.usageAware, true);
});
test("a model disabled while the classifier is running never becomes a project task", async () => {
  const fake = path.join(temp, "fake-codex");
  await writeFile(
    fake,
    `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('synthetic');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(!p.id)return;const result=p.method==='model/list'?{data:[{model:'test-heavy',displayName:'Heavy',description:'Synthetic',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}:{};console.log(JSON.stringify({id:p.id,result}));});`,
    { mode: 0o700 },
  );
  process.env.CODEX_BIN = fake;
  for (const key of ["CLAUDE_BIN", "GROK_BIN", "AGY_BIN", "MUSE_BIN"])
    process.env[key] = path.join(temp, "missing");
  process.env.CROUTER_ROUTER = "jev";
  process.env.TYPESAFE_API_KEY = ["synthetic", "routing", "placeholder"].join(
    "-",
  );
  const root = path.join(temp, "project");
  await mkdir(root);
  const { registerProject, chat } = await import("../lib/server/service");
  const { orchestrate } = await import("../lib/server/orchestrator");
  const project = (await registerProject("Synthetic", root, [])).project;
  updateRoutingPreferences({
    operation: "model",
    provider: "codex",
    model: "test-heavy",
    enabled: true,
  });
  globalThis.fetch = async (_url, init) => {
    const state = JSON.parse(JSON.parse(String(init?.body)).state);
    updateRoutingPreferences({
      operation: "model",
      provider: "codex",
      model: "test-heavy",
      enabled: false,
    });
    return Response.json({
      answers: {
        project: { type: "choice", choice: project.id, confidence: 1 },
        intent: { type: "choice", choice: "create_task", confidence: 1 },
        worker: { type: "choice", choice: state.workers[0].id, confidence: 1 },
      },
    });
  };
  await assert.rejects(
    () => chat("Create a task for Synthetic: large architecture review"),
    /preferences or usage eligibility changed/,
  );
  assert.equal(
    (await orchestrate(project, { operation: "status" })).tasks!.length,
    0,
  );
});

test("models require opt-in, bulk selections are scoped and new discoveries stay unselected", () => {
  const source = row([]);
  assert.equal(workerCandidates([source]).length, 0);
  updateRoutingPreferences({
    operation: "models",
    models: [
      { provider: "codex", model: "test-heavy" },
      { provider: "claude", model: "test-heavy" },
    ],
    enabled: true,
  });
  assert.equal(
    workerCandidates([source], "auto", now, routingPreferences()).length,
    2,
  );
  updateRoutingPreferences({
    operation: "models",
    models: [{ provider: "codex", model: "test-heavy" }],
    enabled: false,
  });
  assert.deepEqual(routingPreferences().enabledModels, [
    { provider: "claude", model: "test-heavy" },
  ]);
  assert.equal(
    workerCandidates([source], "codex", now, routingPreferences()).length,
    0,
  );
});
test("legacy exclusions migrate to no selections while preserving quota preferences", () => {
  db()
    .prepare("INSERT INTO preferences VALUES (?, ?)")
    .run(
      "routing",
      JSON.stringify({
        disabledModels: [{ provider: "gemini", model: "default" }],
        usageAware: true,
        minRemainingPercent: 35,
      }),
    );
  assert.deepEqual(routingPreferences(), {
    ...defaultRoutingPreferences,
    enabledModels: [],
    usageAware: true,
    minRemainingPercent: 35,
  });
  updateRoutingPreferences({
    operation: "model",
    provider: "agy",
    model: "test-heavy",
    enabled: true,
  });
  assert.deepEqual(routingPreferences().enabledModels, [
    { provider: "agy", model: "test-heavy" },
  ]);
});

test("file and UI rules share one source, preserving unrelated settings and rejecting invalid files", async () => {
  const file = routingPreferencesFile();
  const rules = [
    {
      provider: "codex" as const,
      model: "test-light",
      when: "Small fixes and documentation",
    },
  ];
  updateRoutingPreferences({
    operation: "rules",
    instructions: "Prefer low effort for simple tasks",
    rules,
  });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.rules, rules);
  await writeFile(
    file,
    JSON.stringify({ ...saved, usageAware: true, minRemainingPercent: 40 }),
  );
  assert.equal(routingPreferences().usageAware, true);
  updateRoutingPreferences({
    operation: "model",
    provider: "codex",
    model: "test-light",
    enabled: true,
  });
  assert.equal(routingPreferences().minRemainingPercent, 40);
  assert.deepEqual(routingPreferences().rules, rules);
  assert.throws(() =>
    updateRoutingPreferences({
      operation: "rules",
      instructions: "x".repeat(2001),
      rules,
    }),
  );
  await writeFile(file, "{invalid");
  assert.throws(() => routingPreferences(), /routing.json/);
  assert.throws(
    () => updateRoutingPreferences({ operation: "usage", enabled: false }),
    /routing.json/,
  );
  assert.equal(await readFile(file, "utf8"), "{invalid");
  await rm(file);
  const target = path.join(temp, "external.json");
  await writeFile(target, JSON.stringify(saved));
  await symlink(target, file);
  assert.throws(() => routingPreferences(), /routing.json/);
  assert.throws(
    () => updateRoutingPreferences({ operation: "usage", enabled: false }),
    /routing.json/,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), saved);
});
