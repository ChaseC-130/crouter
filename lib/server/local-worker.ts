import "server-only";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors";
import type { Provider, TaskDetail } from "../types";
import { childEnv, workerPrompt } from "./providers";
type LocalProvider = Extract<Provider, "gemini" | "agy" | "muse">;

export function localCommand(
  provider: LocalProvider,
  threadId?: string,
  promptFile?: string,
) {
  if (provider === "gemini")
    return {
      bin: process.env.GEMINI_BIN || "gemini",
      args: [
        "--prompt",
        "Review the worker request supplied on stdin.",
        "--output-format",
        "stream-json",
        "--approval-mode",
        "plan",
        "--extensions",
        "none",
        ...(threadId ? ["--resume", threadId] : []),
      ],
    };
  if (provider === "agy")
    return {
      bin: process.env.AGY_BIN || "agy",
      args: [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--sandbox",
        "--disable-slash-commands",
        ...(threadId ? ["--conversation", threadId] : []),
      ],
    };
  if (!promptFile)
    throw new AppError("Muse needs a private regular prompt file.");
  return {
    bin: process.env.MUSE_BIN || "muse",
    args: [
      "exec",
      "--json",
      "--prompt-file",
      promptFile,
      "--session-id",
      threadId || randomUUID(),
      "--disable-write",
      "--disable-shell",
      "--disable-web-tools",
      "--no-foreign-personal-context",
      "--approval-mode",
      "untrusted",
      "--approval-judge",
      "off",
    ],
  };
}

export function readOnlyProfile(root: string, writable: string[]) {
  for (const folder of writable)
    if (
      folder === root ||
      folder.startsWith(root + path.sep) ||
      root.startsWith(folder + path.sep)
    )
      throw new AppError(
        "Project overlaps provider storage or the worker temporary directory. Use a dedicated project folder.",
      );
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (literal "/dev/null") (subpath "/dev/fd") ${writable.map((folder) => `(subpath ${JSON.stringify(folder)})`).join(" ")})\n(deny file-write* (subpath ${JSON.stringify(root)}))`;
}

export async function prepareLocalWorker(
  provider: LocalProvider,
  root: string,
  task: TaskDetail,
) {
  // Plan prompts alone cannot enforce read-only access. No unsandboxed fallback.
  if (process.platform !== "darwin")
    throw new AppError(
      "Gemini, Antigravity and Muse web workers currently require macOS sandbox-exec. Core Codex/Claude/Grok adapters support Linux.",
      503,
    );
  const temp = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "crouter-worker-")),
  );
  try {
    const prompt = workerPrompt(task),
      env = childEnv();
    env.TMPDIR = temp;
    const promptFile = path.join(temp, "request.txt");
    if (provider === "muse") {
      await writeFile(promptFile, prompt, { mode: 0o600 });
      env.MUSE_NO_AUTO_UPDATE = "1";
    }
    const storage =
      provider === "muse"
        ? [
            path.join(os.homedir(), ".local/share/muse"),
            path.join(os.homedir(), ".config/muse"),
          ]
        : [path.join(os.homedir(), ".gemini")];
    const profile = readOnlyProfile(root, [temp, ...storage]);
    const command = localCommand(provider, task.threadId, promptFile);
    return {
      command: {
        bin: "/usr/bin/sandbox-exec",
        args: ["-p", profile, command.bin, ...command.args],
      },
      env,
      stdin:
        provider === "agy"
          ? JSON.stringify({ event: "user", message: { content: prompt } }) +
            "\n"
          : provider === "muse"
            ? ""
            : prompt,
      cleanup: () => rm(temp, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export function parseLocalEvent(
  provider: LocalProvider,
  event: Record<string, unknown>,
) {
  let threadId: unknown,
    text: unknown,
    append = false,
    failed = false,
    completed = false;
  if (provider === "gemini") {
    if (event.type === "init") threadId = event.session_id;
    if (event.type === "message" && event.role === "assistant") {
      text = event.content;
      append = event.delta === true;
    }
    if (event.type === "result") {
      completed = event.status === "success";
      failed = !completed;
    }
    if (event.type === "error") failed = true;
  } else if (provider === "agy") {
    if (event.event === "init") threadId = event.conversation_id;
    if (event.event === "result") {
      const result = event.result as
        | { conversation_id?: string; status?: string; response?: string }
        | undefined;
      threadId = result?.conversation_id;
      text = result?.response;
      completed = result?.status === "SUCCESS";
      failed = !completed;
    }
  } else {
    const stream = event.stream as { kind?: string; id?: string } | undefined;
    if (event.schema_version === 1 && stream?.kind === "session") {
      threadId = stream.id;
      const payload = event.payload as
        { kind?: string; terminal?: string; text?: string } | undefined;
      if (payload?.kind === "run_terminal") {
        text = payload.text;
        completed = payload.terminal === "completed";
        failed = !completed;
      }
    }
  }
  return {
    threadId:
      typeof threadId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        threadId,
      )
        ? threadId
        : undefined,
    text: typeof text === "string" ? text : undefined,
    append,
    failed,
    completed,
  };
}
