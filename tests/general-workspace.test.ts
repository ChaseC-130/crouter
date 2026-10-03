import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  lstat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  chat,
  runTask,
  snapshot,
  previewAction,
  updateProjectDetails,
} from "../lib/server/service";
import { db, project, projects } from "../lib/server/db";
import {
  generalWorkspace,
  generalTaskDirectory,
} from "../lib/server/general-workspace";
import { GENERAL_WORKSPACE_ID } from "../lib/workspaces";
import { taskDetail } from "../lib/server/orchestrator";
import { routeTurn, routingPayload } from "../lib/server/routing";

const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "crouter-general-test-")),
);
process.env.CROUTER_DATA_DIR = temp;
const originalFetch = globalThis.fetch;
let scratchBase: string | undefined;
after(async () => {
  globalThis.fetch = originalFetch;
  db().close();
  await rm(temp, { recursive: true, force: true });
  if (scratchBase) await rm(scratchBase, { recursive: true, force: true });
});

test("generic turns work with an empty project registry and retain task state", async () => {
  process.env.CROUTER_DEMO = "1";
  const initial = await snapshot();
  assert.equal(projects().length, 0);
  assert.deepEqual(
    initial.projects.map((p) => p.kind),
    ["general"],
  );
  assert.equal(initial.warnings.length, 0);
  const result = await chat("Explain how rainbows form", "codex");
  assert.equal(result.route.projectId, GENERAL_WORKSPACE_ID);
  assert.ok(result.task);
  const root = await generalTaskDirectory(result.task.id);
  scratchBase = path.dirname(root);
  assert.ok(!root.startsWith(temp + path.sep));
  assert.ok(!root.startsWith(process.cwd() + path.sep));
  assert.equal((await lstat(root)).mode & 0o077, 0);
  assert.equal(await generalTaskDirectory(result.task.id), root);
  const other = await generalTaskDirectory("T-abcdef12");
  assert.notEqual(other, root);
  await assert.rejects(() => generalTaskDirectory("../../escape"));
  const escaped = path.join(scratchBase, "T-abcdef13");
  await symlink(temp, escaped);
  await assert.rejects(() => generalTaskDirectory("T-abcdef13"), /symlinks/);

  // Exercise the real worker path with a synthetic CLI, not a provider account.
  delete process.env.CROUTER_DEMO;
  const thread = "11111111-1111-4111-8111-111111111111";
  const bin = path.join(temp, "fake-codex");
  await writeFile(
    bin,
    `#!/usr/bin/env node
console.log(JSON.stringify({type:'thread.started',thread_id:'${thread}'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.cwd()}}));
console.log(JSON.stringify({type:'turn.completed'}));`,
    { mode: 0o700 },
  );
  process.env.CODEX_BIN = bin;
  await runTask(GENERAL_WORKSPACE_ID, result.task.id);
  const detail = await taskDetail(
    project(GENERAL_WORKSPACE_ID),
    result.task.id,
  );
  assert.equal(detail.status, "done");
  assert.equal(detail.threadId, thread);
  assert.equal(detail.summary, root);
  assert.match(
    await readFile(path.join(temp, "general/.router-agent/tasks.md"), "utf8"),
    new RegExp(result.task.id),
  );
  const refreshed = await snapshot();
  assert.equal(refreshed.tasks[0].projectName, "General");
  assert.equal(refreshed.tasks[0].threadId, thread);
  await assert.rejects(
    () =>
      previewAction({
        kind: "remove_project",
        projectId: GENERAL_WORKSPACE_ID,
      }),
    /cannot be removed/,
  );
  await assert.rejects(
    () => updateProjectDetails(GENERAL_WORKSPACE_ID, "Other", [], ""),
    /cannot be edited/,
  );
});

test("General is an explicit classifier choice; ambiguous projects still fail", async () => {
  const general = generalWorkspace();
  const registered = {
    ...general,
    kind: undefined,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Game",
    description: "Strategy game unit balancing",
  };
  process.env.TYPESAFE_API_KEY = "synthetic-routing-placeholder";
  process.env.CROUTER_ROUTER = "jev";
  const payload = routingPayload("Write a birthday poem", [
    registered,
    general,
  ]);
  assert.ok(payload.questions.project.criteria[GENERAL_WORKSPACE_ID]);
  assert.ok(!JSON.stringify(payload).includes(temp));
  globalThis.fetch = async () =>
    Response.json({
      answers: {
        project: {
          type: "choice",
          choice: GENERAL_WORKSPACE_ID,
          confidence: 1,
        },
        intent: { type: "choice", choice: "create_task", confidence: 1 },
      },
    });
  assert.equal(
    (await routeTurn("Write a birthday poem", [registered, general])).projectId,
    GENERAL_WORKSPACE_ID,
  );
  assert.equal(
    (
      await routeTurn(
        "Explain unit balancing",
        [registered, general],
        undefined,
        false,
        undefined,
        registered.id,
      )
    ).projectId,
    registered.id,
  );
  globalThis.fetch = async () =>
    Response.json({
      answers: {
        project: { type: "choice", choice: "unknown", confidence: 1 },
        intent: { type: "choice", choice: "create_task", confidence: 1 },
      },
    });
  await assert.rejects(
    () => routeTurn("Fix that project", [registered, general]),
    /uncertain/,
  );
});
