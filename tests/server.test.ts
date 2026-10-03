import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  registerProject,
  chat,
  previewAction,
  approveAction,
  runTask,
  recoverTask,
} from "../lib/server/service";
import { db, messages, withLease, projects } from "../lib/server/db";
import { taskDetail, orchestrate } from "../lib/server/orchestrator";
import { routingPayload, routeTurn } from "../lib/server/jev";
import { assertLocal, readBody } from "../lib/server/security";
import {
  childEnv,
  providerCommand,
  parseProviderEvent,
  runProvider,
} from "../lib/server/providers";
import { chatInput } from "../lib/server/schemas";
const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "crouter-server-")),
);
process.env.CROUTER_DATA_DIR = path.join(temp, "private");
process.env.CROUTER_ORIGIN = "http://127.0.0.1:3000";
const originalFetch = globalThis.fetch;
const testKey = ["unit", "test", "placeholder"].join("-");
after(async () => {
  globalThis.fetch = originalFetch;
  db().close();
  await rm(temp, { recursive: true, force: true });
});
async function folder(name: string) {
  const { mkdir } = await import("node:fs/promises");
  const root = path.join(temp, name);
  await mkdir(root);
  return root;
}
test("same-origin mutations, loopback host and bounded JSON are required", async () => {
  const good = new Request("http://127.0.0.1:3000/api/chat", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
      "x-crouter-request": "1",
    },
    body: JSON.stringify({ turn: "Atlas status", provider: "codex" }),
  });
  assert.doesNotThrow(() => assertLocal(good, true));
  assert.equal((await readBody(good, chatInput)).provider, "codex");
  assert.throws(
    () =>
      assertLocal(
        new Request("http://127.0.0.1:3000/api/chat", {
          headers: { host: "evil.example:3000" },
        }),
      ),
    /loopback/,
  );
  assert.throws(
    () =>
      assertLocal(
        new Request("http://127.0.0.1:3000/api/chat", {
          headers: { origin: "https://evil.example" },
        }),
        true,
      ),
    /Cross-origin/,
  );
  assert.throws(
    () => assertLocal(new Request("http://127.0.0.1:3000/api/chat"), true),
    /same-origin/,
  );
  await assert.rejects(
    () =>
      readBody(
        new Request("http://127.0.0.1:3000/api/chat", {
          method: "POST",
          body: "x".repeat(17000),
        }),
        chatInput,
      ),
    /too large/,
  );
});
test("JEV sees only the current turn and registry labels, and rejects unsafe decisions", async () => {
  const p = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic",
    aliases: ["synth"],
    path: "/absolute/private/folder",
    createdAt: new Date().toISOString(),
  };
  const payload = routingPayload("Synthetic status", [p]);
  assert.equal(payload.model, "jev-latest");
  assert.ok(!JSON.stringify(payload).includes(p.path));
  assert.ok(!JSON.stringify(payload).includes("history"));
  process.env.TYPESAFE_API_KEY = testKey;
  let sent = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.typesafe.ai/v1/systemone");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer unit-test-placeholder",
    );
    assert.equal(init?.redirect, "error");
    sent = String(init?.body);
    return Response.json({
      answers: {
        project: { type: "choice", choice: p.id, confidence: 0.99 },
        intent: { type: "choice", choice: "status", confidence: 0.98 },
      },
    });
  };
  assert.equal((await routeTurn("Synthetic status", [p])).intent, "status");
  assert.ok(sent.includes("Synthetic status"));
  globalThis.fetch = async () =>
    Response.json({
      answers: {
        project: { type: "choice", choice: "unknown", confidence: 1 },
        intent: { type: "choice", choice: "create_task", confidence: 1 },
      },
    });
  await assert.rejects(() => routeTurn("ambiguous", [p]), /uncertain/);
  globalThis.fetch = async () =>
    Response.json({
      answers: {
        project: { type: "choice", choice: p.id, confidence: 0.2 },
        intent: { type: "choice", choice: "create_task", confidence: 1 },
      },
    });
  await assert.rejects(() => routeTurn("low confidence", [p]), /uncertain/);
  globalThis.fetch = async () => Response.json({ result: "invalid" });
  await assert.rejects(() => routeTurn("bad schema", [p]), /invalid routing/);
  globalThis.fetch = async () => new Response("x".repeat(65537));
  await assert.rejects(() => routeTurn("oversized", [p]), /oversized/);
  delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(
    () => routeTurn("Synthetic status", [p]),
    /TYPESAFE_API_KEY/,
  );
  globalThis.fetch = originalFetch;
});
test("leases serialize writes and are released after errors", async () => {
  let release!: () => void;
  const first = withLease(
    "synthetic-lock",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(
    () => withLease("synthetic-lock", async () => {}),
    /in progress/,
  );
  release();
  await first;
  await assert.rejects(() =>
    withLease("synthetic-lock", async () => {
      throw new Error("synthetic");
    }),
  );
  assert.equal(await withLease("synthetic-lock", async () => 42), 42);
});
test("registry isolation, display-only chat, and single-use stale-target approvals", async () => {
  const a = (
      await registerProject("Atlas", await folder("atlas"), ["atlas-web"])
    ).project,
    b = (await registerProject("Orbit", await folder("orbit"), [])).project;
  assert.match(
    await readFile(path.join(a.path, ".gitignore"), "utf8"),
    /\.router-agent/,
  );
  const duplicate = await folder("duplicate");
  await assert.rejects(
    () => registerProject("Other", duplicate, ["Atlas"]),
    /unique/,
  );
  process.env.CROUTER_DEMO = "1";
  await chat("Create a task for Atlas: review synthetic API", "codex");
  assert.equal(
    (await orchestrate<{ tasks: unknown[] }>(b, { operation: "status" })).tasks
      .length,
    0,
  );
  const state = await orchestrate<{ tasks: { id: string }[] }>(a, {
    operation: "status",
  });
  const id = state.tasks[0].id;
  await assert.rejects(() => chat("do that again", "codex"), /explicitly/);
  assert.ok(messages().length >= 3);
  const action = { kind: "archive_task" as const, projectId: a.id, taskId: id };
  const stale = await previewAction(action);
  await orchestrate(a, { operation: "update", taskId: id, status: "blocked" });
  await assert.rejects(() => approveAction(stale.id, "CONFIRM"), /changed/);
  const approved = await previewAction(action);
  await assert.rejects(() => approveAction(approved.id, "no"), /confirmation/);
  await approveAction(approved.id, "CONFIRM");
  await assert.rejects(
    () => approveAction(approved.id, "CONFIRM"),
    /expired|used/,
  );
  assert.equal(
    (await orchestrate<{ tasks: unknown[] }>(a, { operation: "status" })).tasks
      .length,
    0,
  );
  const expired = await previewAction({ kind: "clear_history" });
  db().prepare("UPDATE approvals SET expires=0 WHERE id=?").run(expired.id);
  await assert.rejects(() => approveAction(expired.id, "CONFIRM"), /expired/);
  const remove = await previewAction({
    kind: "remove_project",
    projectId: b.id,
  });
  await approveAction(remove.id, "CONFIRM");
  assert.equal(projects().length, 1);
  assert.ok(
    await readFile(path.join(b.path, ".router-agent/tasks.md"), "utf8"),
  );
  delete process.env.CROUTER_DEMO;
});
test("provider commands use saved sessions and never inherit API keys or bypass permissions", () => {
  process.env.TYPESAFE_API_KEY = testKey;
  process.env.OPENAI_API_KEY = testKey;
  process.env.ANTHROPIC_API_KEY = testKey;
  const env = childEnv();
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const id = "11111111-1111-4111-8111-111111111111";
  for (const provider of ["codex", "claude"] as const) {
    const command = providerCommand(provider, id);
    assert.ok(command.args.includes(id));
    assert.ok(!command.args.some((a) => a.includes("dangerously")));
  }
  assert.ok(
    providerCommand("codex", id).args.includes('sandbox_mode="read-only"'),
  );
  assert.ok(providerCommand("claude", id).args.includes("Read,Glob,Grep"));
  assert.throws(() => providerCommand("codex", "--last"), /Invalid/);
  assert.equal(
    parseProviderEvent("codex", { type: "thread.started", thread_id: id })
      .threadId,
    id,
  );
  assert.equal(
    parseProviderEvent("claude", {
      type: "result",
      subtype: "success",
      session_id: id,
      result: "Synthetic result",
    }).text,
    "Synthetic result",
  );
  assert.equal(
    parseProviderEvent("claude", {
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
    }).failed,
    true,
  );
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});
test("a fake CLI records its session before completion, persists result, and resumes the same thread", async () => {
  const p = projects()[0];
  process.env.CROUTER_DEMO = "1";
  const created = await chat("Atlas task: synthetic worker plan", "codex");
  delete process.env.CROUTER_DEMO;
  const fake = path.join(temp, "fake-codex");
  await writeFile(
    fake,
    `#!/usr/bin/env node\nif(process.env.TYPESAFE_API_KEY||process.env.OPENAI_API_KEY)process.exit(1);\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'22222222-2222-4222-8222-222222222222'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic review result'}}));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`,
    { mode: 0o700 },
  );
  process.env.CODEX_BIN = fake;
  await runTask(p.id, created.task!.id);
  const task = await taskDetail(p, created.task!.id);
  assert.equal(task.status, "done");
  assert.equal(task.threadId, "22222222-2222-4222-8222-222222222222");
  assert.match(task.body, /Synthetic review result/);
  assert.ok(
    messages().some(
      (m) =>
        m.intent === "worker_completed" &&
        m.projectId === p.id &&
        m.content.includes(task.id),
    ),
  );
  await runTask(p.id, task.id);
  assert.equal((await taskDetail(p, task.id)).threadId, task.threadId);
  await orchestrate(p, {
    operation: "update",
    taskId: task.id,
    status: "running",
  });
  await recoverTask(p.id, task.id);
  assert.equal((await taskDetail(p, task.id)).status, "blocked");
  await writeFile(
    fake,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'33333333-3333-4333-8333-333333333333'}));\nconsole.log(JSON.stringify({type:'turn.failed'}));\nprocess.exitCode=1;\n`,
  );
  await assert.rejects(() => runTask(p.id, task.id), /did not finish/);
  const failed = await taskDetail(p, task.id);
  assert.equal(failed.status, "blocked");
  assert.equal(failed.threadId, "33333333-3333-4333-8333-333333333333");
  assert.ok(
    messages().some(
      (m) =>
        m.intent === "worker_failed" &&
        m.projectId === p.id &&
        m.content.includes(task.id),
    ),
  );
  delete process.env.CODEX_BIN;
});
test("Claude stream adapter observes session IDs and final JSON without exposing tool events", async () => {
  const root = await folder("claude-fixture"),
    fake = path.join(temp, "fake-claude");
  const threadId = "44444444-4444-4444-8444-444444444444";
  await writeFile(
    fake,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'${threadId}'}));\nconsole.log(JSON.stringify({type:'assistant',message:{content:[{text:'Synthetic tool detail'}]}}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',session_id:'${threadId}',result:'Synthetic final result'}));\n`,
    { mode: 0o700 },
  );
  process.env.CLAUDE_BIN = fake;
  let observed = "";
  const result = await runProvider(
    "claude",
    root,
    {
      id: "T-00000000",
      title: "Synthetic",
      provider: "claude",
      status: "queued",
      projectId: "synthetic",
      projectName: "Synthetic",
      body: "# Synthetic request",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    async (id) => {
      observed = id;
    },
  );
  assert.equal(observed, threadId);
  assert.equal(result.text, "Synthetic final result");
  delete process.env.CLAUDE_BIN;
});
test("Tailnet mode requires an exact origin AND an allowlisted Serve identity, including on GET", () => {
  process.env.CROUTER_TAILSCALE_ORIGIN = "https://device.example.ts.net";
  process.env.CROUTER_TAILSCALE_USERS = "synthetic-login";
  const headers = {
    host: "device.example.ts.net",
    origin: "https://device.example.ts.net",
    "tailscale-user-login": "synthetic-login",
    "x-crouter-request": "1",
    "content-type": "application/json",
  };
  assert.doesNotThrow(() =>
    assertLocal(
      new Request("https://device.example.ts.net/api/chat", {
        method: "POST",
        headers,
      }),
      true,
    ),
  );
  assert.throws(
    () => assertLocal(new Request("http://127.0.0.1:3000/api/snapshot")),
    /Serve identity/,
  );
  assert.throws(
    () =>
      assertLocal(
        new Request("https://device.example.ts.net/api/snapshot", {
          headers: { ...headers, "tailscale-user-login": "unapproved-login" },
        }),
      ),
    /Serve identity/,
  );
  assert.throws(
    () =>
      assertLocal(
        new Request("https://device.example.ts.net/api/chat", {
          method: "POST",
          headers: { ...headers, origin: "https://another.example.ts.net" },
        }),
        true,
      ),
    /Cross-origin/,
  );
  delete process.env.CROUTER_TAILSCALE_ORIGIN;
  delete process.env.CROUTER_TAILSCALE_USERS;
});
test("Grok ACP uses cached local auth, denies client tool requests, captures and resumes its own session", async () => {
  const root = await folder("grok-fixture"),
    fake = path.join(temp, "fake-grok");
  const id = "55555555-5555-4555-8555-555555555555";
  await writeFile(
    fake,
    `#!/usr/bin/env node
const readline=require('node:readline');
const send=p=>console.log(JSON.stringify({jsonrpc:'2.0',...p}));
let prompt;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const p=JSON.parse(line);
  if(p.id==='permission-check') {
    if(p.result?.outcome?.outcome!=='cancelled')process.exit(3);
    send({id:'tool-check',method:'fs/write_text_file',params:{path:'forbidden'}});return;
  }
  if(p.id==='tool-check') {
    if(p.error?.code!==-32601)process.exit(4);
    send({method:'session/update',params:{sessionId:'${id}',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Synthetic Grok review'}}}});
    send({id:prompt,result:{stopReason:'end_turn'}});return;
  }
  if(!p.method)return;
  let result={};
  if(p.method==='initialize')result={authMethods:[{id:'cached_token'}],agentCapabilities:{loadSession:true}};
  if(p.method==='authenticate'&&p.params.methodId!=='cached_token')process.exit(2);
  if(p.method==='session/new')result={sessionId:'${id}'};
  if(p.method==='session/prompt') {prompt=p.id;send({id:'permission-check',method:'session/request_permission',params:{}});return;}
  send({id:p.id,result});
});
`,
    { mode: 0o700 },
  );
  process.env.GROK_BIN = fake;
  let observed = "";
  const base = {
    id: "T-11111111",
    title: "Synthetic Grok",
    provider: "grok" as const,
    status: "queued" as const,
    projectId: "synthetic",
    projectName: "Synthetic",
    body: "# Synthetic request",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const result = await runProvider("grok", root, base, async (value) => {
    observed = value;
  });
  assert.equal(observed, id);
  assert.equal(result.text, "Synthetic Grok review");
  const resumed = await runProvider(
    "grok",
    root,
    { ...base, threadId: id },
    async () => {
      throw new Error("Should not create a new thread");
    },
  );
  assert.equal(resumed.threadId, id);
  const { grokArgs } = await import("../lib/server/grok");
  assert.ok(grokArgs.includes("read-only"));
  assert.ok(grokArgs.includes("Read,Grep"));
  assert.ok(!grokArgs.includes("--always-approve"));
  delete process.env.GROK_BIN;
});
test("Codex quota read uses official app-server RPC and returns only validated windows", async () => {
  const { decodeUsage, codexUsage } =
    await import("../lib/server/provider-catalog");
  assert.deepEqual(
    decodeUsage({ rateLimits: null, rateLimitsByLimitId: null }),
    [],
  );
  assert.equal(
    decodeUsage({
      rateLimits: { primary: { usedPercent: 25, resetsAt: 1800000000 } },
    })[0].usedPercent,
    25,
  );
  assert.throws(() =>
    decodeUsage({ rateLimits: { primary: { usedPercent: "bad" } } }),
  );
  const fake = path.join(temp, "fake-quota-codex");
  await writeFile(
    fake,
    `#!/usr/bin/env node\nconst readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(!p.id)return;const result=p.method==='account/rateLimits/read'?{rateLimitsByLimitId:{codex:{primary:{usedPercent:32,windowDurationMins:300,resetsAt:1800000000}}}}:{};console.log(JSON.stringify({id:p.id,result}));});\n`,
    { mode: 0o700 },
  );
  process.env.CODEX_BIN = fake;
  const windows = await codexUsage();
  assert.equal(windows[0].usedPercent, 32);
  assert.equal(windows[0].windowDurationMins, 300);
  delete process.env.CODEX_BIN;
});
test("Google and Muse adapters validate sessions, terminal status and their safe command flags", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  for (const provider of ["gemini", "agy", "muse"] as const) {
    const command = providerCommand(
      provider,
      id,
      "/private/tmp/synthetic-request.txt",
    );
    assert.ok(command.args.includes(id));
    assert.ok(
      !command.args.some(
        (v) =>
          v.includes("yolo") ||
          v.includes("disable-sandbox") ||
          v.includes("skip-permissions") ||
          v.includes("disable-approval"),
      ),
    );
  }
  assert.equal(
    parseProviderEvent("gemini", { type: "init", session_id: id }).threadId,
    id,
  );
  assert.equal(
    parseProviderEvent("gemini", {
      type: "message",
      role: "assistant",
      content: "chunk",
      delta: true,
    }).append,
    true,
  );
  assert.equal(
    parseProviderEvent("gemini", { type: "result", status: "error" }).failed,
    true,
  );
  assert.equal(
    parseProviderEvent("agy", { event: "init", conversation_id: id }).threadId,
    id,
  );
  assert.equal(
    parseProviderEvent("agy", {
      event: "result",
      result: {
        conversation_id: id,
        status: "SUCCESS",
        response: "Synthetic review",
      },
    }).completed,
    true,
  );
  assert.equal(
    parseProviderEvent("muse", {
      schema_version: 1,
      stream: { kind: "session", id },
      payload: {
        kind: "run_terminal",
        terminal: "completed",
        text: "Synthetic review",
      },
    }).text,
    "Synthetic review",
  );
  assert.equal(
    parseProviderEvent("muse", {
      schema_version: 1,
      stream: { kind: "task", id },
      payload: {
        kind: "run_terminal",
        terminal: "completed",
        text: "Child tool output",
      },
    }).text,
    undefined,
  );
  const { readOnlyProfile } = await import("../lib/server/local-worker");
  assert.throws(
    () => readOnlyProfile("/synthetic/root", ["/synthetic/root/cache"]),
    /overlaps/,
  );
  assert.match(
    readOnlyProfile("/synthetic/root", ["/synthetic/cache"]),
    /deny file-write/,
  );
});
test(
  "native macOS workers deny project writes while preserving Gemini, Antigravity and Muse session results",
  {
    skip:
      process.platform !== "darwin" ||
      process.env.CROUTER_TEST_NATIVE_SANDBOX !== "1",
  },
  async () => {
    const root = await folder("native-project");
    for (const provider of ["gemini", "agy", "muse"] as const) {
      const fake = path.join(temp, `fake-${provider}`),
        key = `${provider.toUpperCase()}_BIN`;
      const id = "77777777-7777-4777-8777-777777777777";
      const events =
        provider === "gemini"
          ? [
              { type: "init", session_id: id },
              {
                type: "message",
                role: "assistant",
                delta: true,
                content: "Synthetic ",
              },
              {
                type: "message",
                role: "assistant",
                delta: true,
                content: "review",
              },
              { type: "result", status: "success" },
            ]
          : provider === "agy"
            ? [
                { event: "init", conversation_id: id },
                {
                  event: "result",
                  result: {
                    conversation_id: id,
                    status: "SUCCESS",
                    response: "Synthetic review",
                  },
                },
              ]
            : [
                {
                  schema_version: 1,
                  stream: { kind: "session", id },
                  payload: {
                    kind: "run_terminal",
                    terminal: "completed",
                    text: "Synthetic review",
                  },
                },
              ];
      await writeFile(
        fake,
        `#!/usr/bin/env node\nconst fs=require('node:fs');let denied=false;try{fs.writeFileSync('forbidden.txt','bad');}catch{denied=true;}if(!denied)process.exit(9);for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`,
        { mode: 0o700 },
      );
      process.env[key] = fake;
      try {
        let observed = "";
        const task = {
          id: "T-77777777",
          title: "Synthetic",
          provider,
          status: "queued" as const,
          projectId: "synthetic",
          projectName: "Synthetic",
          body: "# Synthetic review",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const result = await runProvider(
          provider,
          root,
          task,
          async (value) => {
            observed = value;
          },
        );
        assert.equal(observed, id);
        assert.equal(result.text, "Synthetic review");
        assert.equal(result.threadId, id);
        await assert.rejects(
          () => readFile(path.join(root, "forbidden.txt")),
          /ENOENT/,
        );
      } finally {
        delete process.env[key];
      }
    }
  },
);
