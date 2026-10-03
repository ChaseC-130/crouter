import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  routeTurn,
  routingPayload,
  routingStatus,
} from "../lib/server/routing";
import type { Project, WorkerCandidate } from "../lib/types";
import { defaultRoutingPreferences } from "../lib/routing-policy";

const originalFetch = globalThis.fetch;
const envKeys = [
  "CROUTER_ROUTER",
  "CROUTER_DEMO",
  "TYPESAFE_API_KEY",
  "JEV_MODEL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLEF_MODEL",
];
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Synthetic",
  aliases: ["synth"],
  path: "/absolute/private/folder",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const token = ["synthetic", "cloudflare", "placeholder"].join("-");
const account = "a".repeat(32);
test("JEV and Clef choose only an advertised model/effort profile, with no project paths or history", async () => {
  const candidates: WorkerCandidate[] = [
    {
      id: "W-0",
      provider: "codex",
      model: "synthetic-model",
      effort: "high",
      description: "Synthetic host model",
      windows: [{ label: "Primary", usedPercent: 30 }],
      usageStale: false,
    },
  ];
  for (const backend of ["jev", "clef"] as const) {
    configureClef();
    process.env.CROUTER_ROUTER = backend;
    process.env.TYPESAFE_API_KEY = token;
    let workerChoice = "W-0",
      confidence = 0.96,
      intent = "create_task";
    globalThis.fetch = async (_, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(payload.questions), [
        "project",
        "intent",
        "worker",
      ]);
      const workers = JSON.parse(payload.state).workers;
      assert.deepEqual(
        workers.map((worker: WorkerCandidate & { usageBalance?: unknown }) => {
          const copy = { ...worker };
          delete copy.usageBalance;
          return copy;
        }),
        candidates,
      );
      assert.equal(workers[0].usageBalance.preferred, true);
      assert.ok(!JSON.stringify(payload).includes(project.path));
      assert.ok(!JSON.stringify(payload).includes(token));
      const result = {
        answers: {
          project: { type: "choice", choice: project.id, confidence: 1 },
          intent: { type: "choice", choice: intent, confidence: 1 },
          worker: { type: "choice", choice: workerChoice, confidence },
        },
      };
      return Response.json(
        backend === "jev" ? result : { success: true, result },
      );
    };
    assert.deepEqual(
      (await routeTurn("Synthetic: review API", [project], candidates, true))
        .worker,
      { provider: "codex", model: "synthetic-model", effort: "high" },
    );
    workerChoice = "invented";
    await assert.rejects(
      () => routeTurn("Synthetic task", [project], candidates, true),
      /valid model/,
    );
    workerChoice = "W-0";
    confidence = 0.2;
    assert.equal(
      (await routeTurn("Synthetic task", [project], candidates, true))
        .workerConfidence,
      0.2,
    );
    confidence = 0;
    await assert.rejects(
      () => routeTurn("Synthetic task", [project], candidates, true),
      /valid model/,
    );
    intent = "status";
    assert.equal(
      (await routeTurn("Synthetic status", [project], candidates, true)).worker,
      undefined,
    );
  }
});
function configureClef() {
  for (const key of envKeys) delete process.env[key];
  process.env.CROUTER_ROUTER = "clef";
  process.env.CLOUDFLARE_API_TOKEN = token;
  process.env.CLOUDFLARE_ACCOUNT_ID = account;
}

test("both classifiers receive owner rules only for eligible worker choices", async () => {
  const candidates: WorkerCandidate[] = [
    {
      id: "W-0",
      provider: "codex",
      model: "synthetic-model",
      effort: "low",
      description: "Synthetic",
      windows: [],
      usageStale: false,
    },
  ];
  const preferences = {
    ...defaultRoutingPreferences,
    instructions: "Use low effort for simple work",
    rules: [
      {
        provider: "codex" as const,
        model: "synthetic-model",
        when: "Small UI fixes",
      },
      {
        provider: "claude" as const,
        model: "disabled-model",
        when: "Other tasks",
      },
    ],
  };
  for (const backend of ["jev", "clef"] as const) {
    configureClef();
    process.env.CROUTER_ROUTER = backend;
    process.env.TYPESAFE_API_KEY = token;
    globalThis.fetch = async (_, init) => {
      const payload = JSON.parse(String(init?.body));
      assert.ok(
        payload.questions.worker.instructions.includes("Small UI fixes"),
      );
      assert.ok(
        payload.questions.worker.instructions.includes(
          preferences.instructions,
        ),
      );
      assert.ok(
        !payload.questions.project.instructions.includes("Small UI fixes"),
      );
      assert.ok(!JSON.stringify(payload).includes("disabled-model"));
      assert.ok(!JSON.stringify(payload).includes("usageBalance"));
      const result = {
        answers: {
          project: { type: "choice", choice: project.id, confidence: 1 },
          intent: { type: "choice", choice: "create_task", confidence: 1 },
          worker: { type: "choice", choice: "W-0", confidence: 1 },
        },
      };
      return Response.json(
        backend === "jev" ? result : { success: true, result },
      );
    };
    assert.equal(
      (
        await routeTurn(
          "Synthetic: UI fix",
          [project],
          candidates,
          false,
          preferences,
        )
      ).worker?.model,
      "synthetic-model",
    );
  }
});
function decision(
  projectChoice = project.id,
  intent = "status",
  confidence = 0.98,
) {
  return {
    model: "clef",
    answers: {
      project: { type: "choice", choice: projectChoice, confidence },
      intent: { type: "choice", choice: intent, confidence },
    },
  };
}
test("Clef and Clef-flash use Workers AI with only the current turn and registry labels", async () => {
  configureClef();
  process.env.TYPESAFE_API_KEY = ["unused", "jev", "placeholder"].join("-");
  for (const model of ["clef", "clef-flash"]) {
    process.env.CLEF_MODEL = model;
    globalThis.fetch = async (input, init) => {
      assert.equal(
        input,
        `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`,
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${token}`,
      );
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, model);
      assert.deepEqual(JSON.parse(payload.state), {
        turn: "Synthetic status",
        projects: [
          { id: project.id, name: project.name, aliases: project.aliases },
        ],
      });
      assert.ok(!JSON.stringify(payload).includes(project.path));
      assert.ok(!JSON.stringify(payload).includes(token));
      assert.equal(payload.questions.project.type, "choice");
      assert.deepEqual(Object.keys(payload.questions.intent.criteria), [
        "status",
        "create_task",
        "unknown",
      ]);
      return Response.json({
        success: true,
        result: decision(),
        errors: [],
        messages: [],
      });
    };
    assert.deepEqual(await routeTurn("Synthetic status", [project]), {
      projectId: project.id,
      intent: "status",
      confidence: 0.98,
    });
  }
});
test("Clef fails closed for unsafe decisions and unsuccessful or malformed API envelopes", async () => {
  configureClef();
  for (const result of [
    decision("unknown"),
    decision("unregistered"),
    decision(project.id, "remove_project"),
    decision(project.id, "unknown"),
    decision(project.id, "status", 0.74),
  ]) {
    globalThis.fetch = async () => Response.json({ success: true, result });
    await assert.rejects(
      () => routeTurn("Synthetic status", [project]),
      /uncertain/,
    );
  }
  for (const envelope of [
    { success: false, result: decision(), errors: [{ message: token }] },
    { result: decision() },
    { success: true, result: { answers: "invalid" } },
    { success: true, result: decision(project.id, "status", 2) },
    decision(),
  ]) {
    globalThis.fetch = async () => Response.json(envelope);
    await assert.rejects(
      () => routeTurn("Synthetic status", [project]),
      /invalid routing decision/,
    );
  }
  globalThis.fetch = async () => new Response("x".repeat(65537));
  await assert.rejects(
    () => routeTurn("Synthetic status", [project]),
    /oversized/,
  );
});
test("Clef credentials and selectors are validated before any request; failures never fall back to JEV", async () => {
  configureClef();
  process.env.TYPESAFE_API_KEY = ["unused", "jev", "placeholder"].join("-");
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(token, { status: 401 });
  };
  delete process.env.CLOUDFLARE_API_TOKEN;
  assert.equal(routingStatus().routingConfigured, false);
  await assert.rejects(
    () => routeTurn("Synthetic status", [project]),
    /CLOUDFLARE_API_TOKEN/,
  );
  process.env.CLOUDFLARE_API_TOKEN = token;
  for (const invalid of ["", "../another-account", "a".repeat(31)]) {
    process.env.CLOUDFLARE_ACCOUNT_ID = invalid;
    await assert.rejects(
      () => routeTurn("Synthetic status", [project]),
      /CLOUDFLARE_ACCOUNT_ID/,
    );
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = account;
  process.env.CLEF_MODEL = "../../other-model";
  await assert.rejects(
    () => routeTurn("Synthetic status", [project]),
    /CLEF_MODEL/,
  );
  process.env.CLEF_MODEL = "clef";
  process.env.CROUTER_ROUTER = "unknown";
  assert.deepEqual(routingStatus(), {
    routingProvider: null,
    routingConfigured: false,
  });
  await assert.rejects(
    () => routeTurn("Synthetic status", [project]),
    /CROUTER_ROUTER/,
  );
  assert.equal(requests, 0);
  process.env.CROUTER_ROUTER = "clef";
  await assert.rejects(
    () => routeTurn("Synthetic status", [project]),
    (error: Error) =>
      error.message.includes("Clef rejected routing (HTTP 401)") &&
      !error.message.includes(token),
  );
  assert.equal(requests, 1);
  globalThis.fetch = async () => {
    throw new Error(token);
  };
  await assert.rejects(
    () => routeTurn("Synthetic status", [project]),
    /Clef is unavailable/,
  );
});
test("routing status exposes only provider and readiness; JEV remains the default", () => {
  configureClef();
  assert.deepEqual(routingStatus(), {
    routingProvider: "clef",
    routingConfigured: true,
  });
  delete process.env.CROUTER_ROUTER;
  delete process.env.TYPESAFE_API_KEY;
  assert.deepEqual(routingStatus(), {
    routingProvider: "jev",
    routingConfigured: false,
  });
  assert.equal(
    routingPayload("Synthetic status", [project]).model,
    "jev-latest",
  );
  process.env.TYPESAFE_API_KEY = ["synthetic", "jev", "placeholder"].join("-");
  assert.deepEqual(routingStatus(), {
    routingProvider: "jev",
    routingConfigured: true,
  });
});

const auditRequest =
  "Lets do a heuristic balance audit of units and report back suggested balance changes we should make. Units within the same tier should not be duplicates of one another, and upgraded units shouldn't be better versions of their native tier peers.";
const game: Project = {
  ...project,
  name: "Tactics",
  description:
    "Strategy game: unit tiers, upgrades, combat roles, game balance and heuristic balance audits.",
};
const billing: Project = {
  ...project,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Billing",
  description: "Invoicing, payment processing and financial reporting.",
};
test("unnamed natural work requests route using bounded project context without paths or history", async () => {
  configureClef();
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const state = JSON.parse(payload.state);
    assert.equal(state.turn, auditRequest);
    assert.deepEqual(
      state.projects,
      [game, billing].map(({ id, name, aliases, description }) => ({
        id,
        name,
        aliases,
        description,
      })),
    );
    assert.ok(
      payload.questions.project.criteria[game.id].includes(game.description),
    );
    assert.ok(!JSON.stringify(payload).includes(project.path));
    assert.ok(!JSON.stringify(payload).includes(project.createdAt));
    return Response.json({
      success: true,
      result: decision(game.id, "create_task"),
    });
  };
  assert.equal(
    (await routeTurn(auditRequest, [game, billing])).projectId,
    game.id,
  );
  const long = routingPayload(auditRequest, [
    { ...game, description: "x".repeat(2000) },
  ]);
  assert.equal(JSON.parse(long.state).projects[0].description.length, 1500);
});
test("an explicit project selection resolves uncertain project classification without relaxing intent validation", async () => {
  configureClef();
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(JSON.parse(payload.state).selectedProjectId, game.id);
    return Response.json({
      success: true,
      result: {
        answers: {
          project: { type: "choice", choice: "unknown", confidence: 0 },
          intent: { type: "choice", choice: "create_task", confidence: 0.98 },
        },
      },
    });
  };
  assert.deepEqual(
    await routeTurn(
      auditRequest,
      [game, billing],
      undefined,
      false,
      undefined,
      game.id,
    ),
    { projectId: game.id, intent: "create_task", confidence: 0.98 },
  );
  globalThis.fetch = async () =>
    Response.json({ success: true, result: decision("unknown", "unknown") });
  await assert.rejects(
    () =>
      routeTurn(
        auditRequest,
        [game, billing],
        undefined,
        false,
        undefined,
        game.id,
      ),
    /uncertain about the request/,
  );
  globalThis.fetch = async () => {
    throw new Error("Must not request classifier for a removed project");
  };
  await assert.rejects(
    () =>
      routeTurn(auditRequest, [game], undefined, false, undefined, billing.id),
    /no longer registered/,
  );
});
test("uncertainty identifies whether project context or task intent needs clarification", async () => {
  configureClef();
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      result: decision("unknown", "create_task"),
    });
  await assert.rejects(
    () => routeTurn(auditRequest, [game, billing]),
    /add its description/,
  );
  globalThis.fetch = async () =>
    Response.json({ success: true, result: decision(game.id, "unknown") });
  await assert.rejects(
    () => routeTurn(auditRequest, [game, billing]),
    /Describe the work/,
  );
});
test("single-project demo and explicit targets accept natural task requests without a project name", async () => {
  process.env.CROUTER_DEMO = "1";
  assert.equal((await routeTurn(auditRequest, [game])).projectId, game.id);
  assert.equal(
    (
      await routeTurn(
        auditRequest,
        [game, billing],
        undefined,
        false,
        undefined,
        game.id,
      )
    ).intent,
    "create_task",
  );
  await assert.rejects(
    () => routeTurn(auditRequest, [game, billing]),
    /explicitly/,
  );
});
