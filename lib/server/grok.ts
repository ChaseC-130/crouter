import "server-only";
import { z } from "zod";
import { JsonLineClient } from "./jsonline-client";
import { childEnv, workerPrompt } from "./providers";
import { workerTimeout } from "./config";
import { AppError } from "./errors";
import type { TaskDetail } from "../types";
const initSchema = z.object({
  authMethods: z.array(z.object({ id: z.string() })).default([]),
  agentCapabilities: z
    .object({ loadSession: z.boolean().optional() })
    .optional(),
});
const sessionSchema = z.object({
  sessionId: z.string().regex(/^[a-f0-9-]{36}$/i),
});
const updateSchema = z.object({
  sessionUpdate: z.literal("agent_message_chunk"),
  content: z.object({ type: z.literal("text"), text: z.string() }),
});
export const grokArgs = [
  "--sandbox",
  "read-only",
  "--permission-mode",
  "dontAsk",
  "--tools",
  "Read,Grep",
  "--deny",
  "Bash",
  "--deny",
  "Edit",
  "--deny",
  "MCPTool",
  "--disable-web-search",
  "--no-subagents",
  "agent",
  "--no-leader",
  "stdio",
];
export async function runGrok(
  root: string,
  task: TaskDetail,
  onThread: (id: string) => Promise<void>,
) {
  let text = "",
    activeId = task.threadId;
  const client = new JsonLineClient(
    process.env.GROK_BIN || "grok",
    [
      ...(task.model && task.model !== "default"
        ? ["--model", task.model]
        : []),
      ...grokArgs,
    ],
    childEnv(),
    root,
    (packet) => {
      if (
        packet.method !== "session/update" ||
        packet.params?.sessionId !== activeId
      )
        return;
      const parsed = updateSchema.safeParse(packet.params?.update);
      if (parsed.success) text = (text + parsed.data.content.text).slice(-3500);
    },
    "acp",
  );
  const lifetime = setTimeout(() => client.close(), workerTimeout());
  try {
    const init = initSchema.parse(
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "crouter", version: "0.1.0" },
      }),
    );
    if (!init.authMethods.some((m) => m.id === "cached_token"))
      throw new AppError(
        "Grok’s existing host account is unavailable through its local adapter.",
        503,
      );
    await client.request("authenticate", {
      methodId: "cached_token",
      _meta: { headless: true },
    });
    if (task.threadId) {
      if (!init.agentCapabilities?.loadSession)
        throw new AppError(
          "This Grok CLI does not support ACP session resume. Update it or use the recorded ID in its interactive CLI.",
          503,
        );
      await client.request("session/load", {
        sessionId: task.threadId,
        cwd: root,
        mcpServers: [],
      });
    } else {
      const session = sessionSchema.parse(
        await client.request("session/new", { cwd: root, mcpServers: [] }),
      );
      activeId = session.sessionId;
      await onThread(activeId);
    }
    const result = z.object({ stopReason: z.string() }).parse(
      await client.request(
        "session/prompt",
        {
          sessionId: activeId,
          prompt: [{ type: "text", text: workerPrompt(task) }],
        },
        workerTimeout(),
      ),
    );
    if (result.stopReason !== "end_turn" || !text || !activeId)
      throw new AppError(
        "Grok did not complete this worker turn. The captured session ID is retained.",
        503,
      );
    return { threadId: activeId, text };
  } finally {
    clearTimeout(lifetime);
    client.close();
  }
}
