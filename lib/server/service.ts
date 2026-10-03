import "server-only";
import { realpath, lstat, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  db,
  projects,
  project,
  messages,
  addMessage,
  withLease,
  hasLease,
  saveApproval,
  takeApproval,
} from "./db";
import { orchestrate, taskDetail } from "./orchestrator";
import { runProvider, available, childEnv } from "./providers";
import { routeTurn } from "./jev";
import { AppError } from "./errors";
import { isDemo, workerTimeout, dataDir } from "./config";
import type {
  Project,
  Task,
  Snapshot,
  Provider,
  ApprovalAction,
  Approval,
} from "../types";
const exec = promisify(execFile);
export async function registerProject(
  name: string,
  requestedPath: string,
  aliases: string[],
) {
  return withLease("registry", async () => {
    const registry = projects();
    if (registry.length >= 20)
      throw new AppError("The registry is limited to 20 projects.");
    const labels = [name, ...aliases].map((v) => v.toLowerCase());
    if (
      new Set(labels).size !== labels.length ||
      registry.some((p) =>
        [p.name, ...p.aliases].some((label) =>
          labels.includes(label.toLowerCase()),
        ),
      )
    )
      throw new AppError("Project names and aliases must be unique.");
    if (!path.isAbsolute(requestedPath))
      throw new AppError(
        "Use an absolute path to an existing project directory.",
      );
    let root: string;
    try {
      root = await realpath(requestedPath);
      if (!(await lstat(root)).isDirectory()) throw new Error();
    } catch {
      throw new AppError(
        "Project directory does not exist or is inaccessible.",
      );
    }
    if ([path.parse(root).root, os.homedir(), dataDir()].includes(root))
      throw new AppError(
        "Choose a specific project folder, not a home, filesystem root, or runtime data directory.",
      );
    if (registry.some((p) => p.path === root))
      throw new AppError("This path is already registered.");
    // Exclude private state in every project, including when registered from a parent Git repository.
    try {
      const result = await exec("git", ["ls-files", "--", ".router-agent"], {
        cwd: root,
        env: childEnv(),
        timeout: 3000,
        maxBuffer: 100000,
      });
      if (result.stdout.trim())
        throw new AppError(
          "Agent state is already tracked by Git. Untrack .router-agent before registering this project.",
        );
    } catch (e) {
      if (e instanceof AppError) throw e;
      // A missing repository is expected; timeout, missing Git, and permission errors fail closed.
      const stderr = (e as { stderr?: string }).stderr || "";
      if (!stderr.includes("not a git repository"))
        throw new AppError(
          "Unable to verify Git exclusion for this project. Install Git and check directory permissions.",
        );
    }
    const ignore = path.join(root, ".gitignore");
    let existing = "";
    try {
      const s = await lstat(ignore);
      if (s.isSymbolicLink() || !s.isFile() || s.size > 65536)
        throw new AppError("Project .gitignore must be a small regular file.");
      existing = await readFile(ignore, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const { atomicWrite } = await import("../../scripts/project-state.mjs");
    if (!existing.split(/\r?\n/).includes("/.router-agent/"))
      await atomicWrite(
        ignore,
        `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}\n# Private crouter agent state\n/.router-agent/\n`,
        65536,
      );
    const p: Project = {
      id: randomUUID(),
      name,
      path: root,
      aliases,
      createdAt: new Date().toISOString(),
    };
    await orchestrate(p, { operation: "initialize" });
    db()
      .prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.path, JSON.stringify(p.aliases), p.createdAt);
    return { project: p };
  });
}
export async function snapshot(): Promise<Snapshot> {
  const registry = projects(),
    warnings: string[] = [];
  const lists = await Promise.all(
    registry.map(async (p) => {
      try {
        const result = await orchestrate<{ tasks: Task[] }>(p, {
          operation: "status",
        });
        return result.tasks.map((task) => ({
          ...task,
          projectId: p.id,
          projectName: p.name,
        }));
      } catch {
        warnings.push(`${p.name}: unable to read bounded project state.`);
        return [];
      }
    }),
  );
  const [codex, claude, grok, gemini, agy, muse] = isDemo()
    ? [false, false, false, false, false, false]
    : await Promise.all([
        available("codex"),
        available("claude"),
        available("grok"),
        available("gemini"),
        available("agy"),
        available("muse"),
      ]);
  return {
    projects: registry,
    tasks: lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    messages: messages(),
    warnings,
    config: {
      jevConfigured: Boolean(process.env.TYPESAFE_API_KEY),
      demo: isDemo(),
      codex,
      claude,
      grok,
      gemini,
      agy,
      muse,
    },
  };
}
export async function chat(turn: string, provider: Provider) {
  // Display history is deliberately never read here.
  addMessage("user", turn);
  try {
    const route = await routeTurn(turn, projects());
    const p = project(route.projectId);
    const result = await orchestrate<{ message: string; task?: Task }>(
      p,
      route.intent === "status"
        ? { operation: "status" }
        : { operation: "create", text: turn, provider },
    );
    const content = `${p.name} · ${result.message}`;
    addMessage("assistant", content, route);
    return { route, content, task: result.task };
  } catch (error) {
    const { safeError } = await import("./errors");
    addMessage("assistant", safeError(error));
    throw error;
  }
}
export async function runTask(projectId: string, taskId: string) {
  const p = project(projectId);
  return withLease(
    `worker:${p.id}:${taskId}`,
    async () => {
      const task = await withLease(`lifecycle:${p.id}`, async () => {
        project(p.id);
        const detail = await taskDetail(p, taskId);
        if (detail.status === "running")
          throw new AppError(
            "This task is marked running. Recover it after an interrupted run before retrying.",
            409,
          );
        await orchestrate(p, {
          operation: "update",
          taskId,
          status: "running",
          summary: "Read-only worker in progress.",
        });
        return detail;
      });
      try {
        const result = isDemo()
          ? {
              threadId: task.threadId || randomUUID(),
              text: "Synthetic demo result: inspect the relevant files, outline the change, and verify the behavior with a focused test. No provider CLI was run and no repository files were edited.",
            }
          : await runProvider(task.provider, p.path, task, async (threadId) => {
              await orchestrate(p, { operation: "update", taskId, threadId });
            });
        await orchestrate(p, {
          operation: "update",
          taskId,
          status: "done",
          threadId: result.threadId,
          summary: result.text.slice(0, 600),
          result: result.text,
        });
        addMessage(
          "assistant",
          `${p.name} · ${task.provider} finished ${task.id}. ${result.text.slice(0, 600)}`,
          { projectId: p.id, intent: "worker_completed" },
        );
        return {
          message:
            "Worker finished. Its session ID is saved in project Markdown.",
        };
      } catch (error) {
        const { safeError } = await import("./errors");
        await orchestrate(p, {
          operation: "update",
          taskId,
          status: "blocked",
          summary: safeError(error),
          result: safeError(error),
        });
        addMessage(
          "assistant",
          `${p.name} · ${task.provider} stopped on ${task.id}. ${safeError(error)}`,
          { projectId: p.id, intent: "worker_failed" },
        );
        throw error;
      }
    },
    workerTimeout() + 15000,
  );
}
export async function recoverTask(projectId: string, taskId: string) {
  const p = project(projectId);
  if (hasLease(`worker:${p.id}:${taskId}`))
    throw new AppError(
      "The worker lease is still active. Wait for its timeout before recovery.",
      409,
    );
  const task = await taskDetail(p, taskId);
  if (task.status !== "running")
    throw new AppError("Only an interrupted running task can be recovered.");
  await orchestrate(p, {
    operation: "update",
    taskId,
    status: "blocked",
    summary:
      "Interrupted worker recovered. Inspect the saved session before resuming.",
  });
  return { message: "Task recovered; any saved session ID was retained." };
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function actionState(action: ApprovalAction) {
  if (action.kind === "clear_history")
    return {
      fingerprint: digest(messages()),
      description:
        "Clear the local chat display history. Project state and provider sessions will be retained.",
    };
  const p = project(action.projectId);
  if (action.kind === "remove_project") {
    const active = db()
      .prepare("SELECT key FROM leases WHERE key LIKE ? AND expires>?")
      .get(`worker:${p.id}:%`, Date.now());
    if (active)
      throw new AppError(
        "Wait for running workers before removing this project.",
        409,
      );
    return {
      fingerprint: digest(p),
      description: `Remove ${p.name} from the registry. Its folder, Markdown state, and CLI sessions will be retained.`,
    };
  }
  const task = await taskDetail(p, action.taskId);
  if (task.status === "running" || hasLease(`worker:${p.id}:${task.id}`))
    throw new AppError("A running task cannot be archived.", 409);
  const { taskFingerprint } = await import("../../scripts/project-state.mjs");
  return {
    fingerprint: taskFingerprint(task, task.body),
    description: `Archive ${task.id} from ${p.name}. Its task Markdown will move to the local archive and leave the active dashboard.`,
  };
}
export async function previewAction(action: ApprovalAction): Promise<Approval> {
  const state = await actionState(action);
  const id = randomUUID(),
    expires = Date.now() + 60000;
  saveApproval(id, action, expires, state.fingerprint);
  return {
    id,
    description: state.description,
    expiresAt: new Date(expires).toISOString(),
    confirmation: "CONFIRM",
  };
}
export async function approveAction(id: string, confirmation: string) {
  if (confirmation !== "CONFIRM")
    throw new AppError("Explicit confirmation is required.");
  const saved = takeApproval(id),
    action = saved.action;
  return withLease(
    action.kind === "clear_history"
      ? "history"
      : `lifecycle:${action.projectId}`,
    async () => {
      const current = await actionState(action);
      if (current.fingerprint !== saved.fingerprint)
        throw new AppError(
          "The target changed since preview. Preview it again.",
          409,
        );
      if (action.kind === "clear_history") db().exec("DELETE FROM messages");
      else if (action.kind === "remove_project")
        db().prepare("DELETE FROM projects WHERE id=?").run(action.projectId);
      else
        await orchestrate(project(action.projectId), {
          operation: "archive",
          taskId: action.taskId,
          expectedFingerprint: saved.fingerprint,
        });
      return { message: "Approved action completed." };
    },
  );
}
