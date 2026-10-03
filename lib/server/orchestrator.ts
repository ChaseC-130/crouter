import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import type { TaskDetail, Task, Project, Provider, Effort } from "../types";
import { withLease } from "./db";
import { AppError } from "./errors";
import { childEnv } from "./providers";
type Operation =
  | { operation: "initialize" | "status" }
  | {
      operation: "create";
      text: string;
      provider: Provider;
      model?: string;
      effort?: Effort;
    }
  | {
      operation: "detail" | "archive";
      taskId: string;
      expectedFingerprint?: string;
    }
  | {
      operation: "update";
      taskId: string;
      status?: Task["status"];
      threadId?: string;
      summary?: string;
      result?: string;
    };
export async function orchestrate<
  T = { message: string; task?: Task; tasks?: Task[] },
>(p: Project, input: Operation): Promise<T> {
  return withLease(
    `state:${p.id}`,
    () =>
      new Promise<T>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(process.cwd(), "scripts/orchestrator.mjs")],
          { stdio: ["pipe", "pipe", "ignore"], env: childEnv() },
        );
        let output = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new AppError("Project orchestrator timed out.", 503));
        }, 10000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.length > 100000) {
            child.kill("SIGKILL");
            reject(new AppError("Project state output exceeded its budget."));
          }
        });
        child.on("error", () => {
          clearTimeout(timer);
          reject(new AppError("Could not start project orchestrator.", 503));
        });
        child.on("close", () => {
          clearTimeout(timer);
          try {
            const data = JSON.parse(output);
            if (!data.ok) reject(new AppError(data.error));
            else resolve(data.result as T);
          } catch {
            reject(new AppError("Project state could not be read.", 503));
          }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ root: p.path, ...input }));
      }),
  );
}
export function taskDetail(p: Project, taskId: string) {
  return orchestrate<{ task: Task; body: string }>(p, {
    operation: "detail",
    taskId,
  }).then(
    ({ task, body }) =>
      ({ ...task, body, projectId: p.id, projectName: p.name }) as TaskDetail,
  );
}
