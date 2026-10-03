import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  operate,
  boundedRead,
  MAX_TASKS,
  decodeTasks,
} from "../scripts/project-state.mjs";
async function fixture() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "crouter-state-")));
}
test("a fresh orchestrator operation persists a resumable task and archives without deleting its Markdown", async () => {
  const root = await fixture();
  try {
    await operate({ root, operation: "initialize" });
    const created = await operate({
      root,
      operation: "create",
      text: "Review synthetic API edge cases",
      provider: "codex",
      model: "synthetic-model",
      effort: "high",
    });
    const id = created.task.id,
      threadId = "11111111-1111-4111-8111-111111111111";
    await operate({
      root,
      operation: "update",
      taskId: id,
      status: "done",
      threadId,
      result: "A concise synthetic plan.",
    });
    const state = await operate({ root, operation: "status" });
    assert.equal(state.tasks![0].threadId, threadId);
    assert.equal(state.tasks![0].model, "synthetic-model");
    assert.equal(state.tasks![0].effort, "high");
    const detail = await operate({ root, operation: "detail", taskId: id });
    assert.match(detail.body!, /synthetic plan/);
    await operate({ root, operation: "archive", taskId: id });
    assert.equal(
      (await operate({ root, operation: "status" })).tasks!.length,
      0,
    );
    const { readdir } = await import("node:fs/promises");
    assert.equal(
      (await readdir(path.join(root, ".router-agent/archive"))).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("project state cannot escape via symlinks, traversal, or oversized state", async () => {
  const root = await fixture(),
    outside = await fixture();
  try {
    await symlink(outside, path.join(root, ".router-agent"));
    await assert.rejects(
      () => operate({ root, operation: "initialize" }),
      /symlinks/,
    );
    await rm(path.join(root, ".router-agent"));
    await operate({ root, operation: "initialize" });
    await assert.rejects(
      () => operate({ root, operation: "detail", taskId: "../../outside" }),
      /Invalid task/,
    );
    const file = path.join(root, ".router-agent/agents.md");
    await writeFile(file, "a".repeat(8193));
    await assert.rejects(
      () => operate({ root, operation: "status" }),
      /budget/,
    );
    await writeFile(file, "safe");
    await rm(file);
    await symlink(path.join(outside, "secret"), file);
    await writeFile(path.join(outside, "secret"), "synthetic private content");
    await assert.rejects(() => boundedRead(file));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test("active-task budgets and running-task archive policy are enforced", async () => {
  const root = await fixture();
  try {
    await operate({ root, operation: "initialize" });
    let id = "";
    for (let i = 0; i < MAX_TASKS; i++)
      id = (
        await operate({
          root,
          operation: "create",
          text: `Synthetic ${i}`,
          provider: "claude",
        })
      ).task.id;
    await assert.rejects(
      () =>
        operate({
          root,
          operation: "create",
          text: "Overflow",
          provider: "claude",
        }),
      /40 active tasks/,
    );
    await operate({ root, operation: "update", taskId: id, status: "running" });
    await assert.rejects(
      () => operate({ root, operation: "archive", taskId: id }),
      /running/,
    );
    assert.ok(
      Buffer.byteLength(
        await readFile(path.join(root, ".router-agent/tasks.md"), "utf8"),
      ) < 32768,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("unknown operation does not mutate project state", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "unrelated"));
    await operate({ root, operation: "initialize" });
    const before = await readFile(
      path.join(root, ".router-agent/tasks.md"),
      "utf8",
    );
    await assert.rejects(() =>
      operate({ root, operation: "destroy", taskId: "T-00000000" }),
    );
    assert.equal(
      await readFile(path.join(root, ".router-agent/tasks.md"), "utf8"),
      before,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired Gemini tasks remain readable without reusing sessions in agy", () => {
  const legacy = {
    id: "T-77777777",
    provider: "gemini",
    title: "Synthetic",
    model: "legacy-model",
    effort: "high",
    status: "running",
    threadId: "77777777-7777-4777-8777-777777777777",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const [task] = decodeTasks(
    "# Tasks\n\n```json\n" + JSON.stringify([legacy]) + "\n```\n",
  );
  assert.equal(task.provider, "agy");
  assert.equal(task.threadId, undefined);
  assert.equal(task.model, "default");
  assert.equal(task.effort, "default");
  assert.equal(task.status, "blocked");
});
