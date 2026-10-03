import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
export const MAX_TASKS = 40;
const maxState = 32768;
const taskId = /^T-[a-f0-9]{8}$/;
const threadId = /^[a-f0-9-]{36}$/i;
export async function rootDir(root) {
  if (
    !path.isAbsolute(root) ||
    (await realpath(root)) !== root ||
    !(await lstat(root)).isDirectory()
  )
    throw new Error(
      "Project path changed. Register its canonical directory again.",
    );
  return root;
}
export async function directory(root, relative, create = false) {
  await rootDir(root);
  let current = root;
  for (const part of relative.split("/")) {
    if (!part || part === "..") throw new Error("Invalid state path.");
    current = path.join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
    const s = await lstat(current);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new Error("Agent state directories must not be symlinks.");
  }
  return current;
}
export async function boundedRead(file, max = maxState) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error(
        "State file exceeds its small-file budget. Archive old tasks or shorten the file.",
      );
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    if (bytesRead > max) throw new Error("State file is too large.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function atomicWrite(file, text, max = maxState) {
  if (Buffer.byteLength(text) > max)
    throw new Error("State file budget exceeded. Archive old tasks first.");
  try {
    const s = await lstat(file);
    if (s.isSymbolicLink() || !s.isFile())
      throw new Error("State files must be regular files.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await rename(temp, file);
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw e;
  }
}
export function encodeTasks(tasks) {
  return `# Tasks\n\nActive task index. Thread IDs stay local. Archive finished tasks to keep this file small.\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`;
}
export function taskFingerprint(task, body) {
  const metadata = {
    id: task.id,
    title: task.title,
    provider: task.provider,
    status: task.status,
    threadId: task.threadId || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    summary: task.summary || "",
  };
  return createHash("sha256")
    .update(JSON.stringify({ metadata, body }))
    .digest("hex");
}
export function decodeTasks(text) {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error("tasks.md needs its JSON index block.");
  const tasks = JSON.parse(match[1]);
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS)
    throw new Error("Too many active tasks.");
  const seen = new Set();
  for (const t of tasks) {
    if (
      !taskId.test(t.id) ||
      seen.has(t.id) ||
      typeof t.title !== "string" ||
      t.title.length > 160 ||
      !["codex", "claude", "grok", "gemini", "agy", "muse"].includes(
        t.provider,
      ) ||
      !["queued", "running", "done", "blocked"].includes(t.status) ||
      !Number.isFinite(Date.parse(t.createdAt)) ||
      !Number.isFinite(Date.parse(t.updatedAt)) ||
      (t.threadId && !threadId.test(t.threadId)) ||
      (t.summary && (typeof t.summary !== "string" || t.summary.length > 600))
    )
      throw new Error("Invalid task index. Restore a valid tasks.md.");
    seen.add(t.id);
  }
  return tasks;
}
export async function readState(root) {
  const dir = await directory(root, ".router-agent");
  const [index, decisions, agents] = await Promise.all([
    boundedRead(path.join(dir, "tasks.md")),
    boundedRead(path.join(dir, "decisions.md"), 8192),
    boundedRead(path.join(dir, "agents.md"), 8192),
  ]);
  return { dir, tasks: decodeTasks(index), decisions, agents };
}
export async function recordDecision(state, message) {
  const entry = `- ${new Date().toISOString()}: ${message}\n`;
  const lines = (state.decisions + "\n" + entry)
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(-24);
  await atomicWrite(
    path.join(state.dir, "decisions.md"),
    "# Decisions\n\n" + lines.join("\n") + "\n",
    8192,
  );
}
export async function initialize(root) {
  const dir = await directory(root, ".router-agent", true);
  await directory(root, ".router-agent/tasks", true);
  const seeds = {
    "tasks.md": encodeTasks([]),
    "decisions.md":
      "# Decisions\n\n- Worker runs are read-only; repository edits require a separate interactive CLI session.\n",
    "agents.md":
      "# Agents\n\nWorkers use official locally authenticated CLIs through provider adapters.\nEach task stores its own provider and resumable thread ID in tasks.md.\nOrchestrators are fresh bounded processes, not persistent model sessions.\nNever store credentials or chat transcripts here.\n",
  };
  for (const [name, value] of Object.entries(seeds)) {
    try {
      await boundedRead(path.join(dir, name));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await atomicWrite(path.join(dir, name), value);
    }
  }
  await readState(root);
}
export async function operate(input) {
  const { root, operation } = input;
  if (operation === "initialize") {
    await initialize(root);
    return { message: "Project registered." };
  }
  const state = await readState(root);
  if (operation === "status")
    return {
      tasks: state.tasks,
      message: state.tasks.length
        ? `${state.tasks.length} active tasks: ${["queued", "running", "done", "blocked"].map((s) => `${state.tasks.filter((t) => t.status === s).length} ${s}`).join(", ")}.`
        : "No tasks yet. Name this project and describe a task in chat.",
    };
  if (operation === "create") {
    if (state.tasks.length >= MAX_TASKS)
      throw new Error(
        "This project has 40 active tasks. Archive finished tasks first.",
      );
    if (
      typeof input.text !== "string" ||
      input.text.length > 4000 ||
      !["codex", "claude", "grok", "gemini", "agy", "muse"].includes(
        input.provider,
      )
    )
      throw new Error("Invalid task.");
    const now = new Date().toISOString();
    const task = {
      id: `T-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      title: input.text.replace(/\s+/g, " ").slice(0, 160),
      provider: input.provider,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    const dir = await directory(root, ".router-agent/tasks");
    await atomicWrite(
      path.join(dir, `${task.id}.md`),
      `# ${task.title.replace(/[\r\n]/g, " ")}\n\n## Request\n\n${input.text}\n\n## Result\n\nNot started.\n`,
      8192,
    );
    state.tasks.unshift(task);
    await atomicWrite(
      path.join(state.dir, "tasks.md"),
      encodeTasks(state.tasks),
    );
    await recordDecision(state, `Created ${task.id} for ${task.provider}.`);
    return {
      task,
      message: `Created ${task.id}. It is queued for ${task.provider}; open the task to start a read-only worker.`,
    };
  }
  if (!taskId.test(input.taskId)) throw new Error("Invalid task ID.");
  const task = state.tasks.find((t) => t.id === input.taskId);
  if (!task) throw new Error("Task not found.");
  const dir = await directory(root, ".router-agent/tasks");
  const file = path.join(dir, `${task.id}.md`);
  const body = await boundedRead(file, 8192);
  if (operation === "detail") return { task, body };
  if (operation === "update") {
    if (
      input.status &&
      !["queued", "running", "done", "blocked"].includes(input.status)
    )
      throw new Error("Invalid status.");
    if (input.threadId && !threadId.test(input.threadId))
      throw new Error("Invalid thread ID.");
    if (input.status) task.status = input.status;
    if (input.threadId) task.threadId = input.threadId;
    if (input.summary) task.summary = String(input.summary).slice(0, 600);
    task.updatedAt = new Date().toISOString();
    if (input.result)
      await atomicWrite(
        file,
        body.split("\n## Result\n")[0] +
          `\n## Result\n\n${String(input.result).slice(0, 3500)}\n`,
        8192,
      );
    await atomicWrite(
      path.join(state.dir, "tasks.md"),
      encodeTasks(state.tasks),
    );
    return { task };
  }
  if (operation === "archive") {
    if (
      input.expectedFingerprint &&
      taskFingerprint(task, body) !== input.expectedFingerprint
    )
      throw new Error("The task changed since preview. Preview it again.");
    if (task.status === "running")
      throw new Error("A running task cannot be archived.");
    const archive = await directory(root, ".router-agent/archive", true);
    await rename(file, path.join(archive, `${task.id}-${Date.now()}.md`));
    await atomicWrite(
      path.join(state.dir, "tasks.md"),
      encodeTasks(state.tasks.filter((t) => t.id !== task.id)),
    );
    await recordDecision(state, `Archived ${task.id}.`);
    return {
      message: `Archived ${task.id}. Its Markdown is retained locally.`,
    };
  }
  throw new Error("Unsupported project operation.");
}
