import { z } from "zod";
const id = z.string().uuid();
const taskId = z.string().regex(/^T-[a-f0-9]{8}$/);
export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    path: z.string().trim().min(1).max(1024),
    aliases: z.array(z.string().trim().min(2).max(40)).max(8).default([]),
  })
  .strict();
export const chatInput = z
  .object({
    turn: z.string().trim().min(1).max(4000),
    provider: z.enum(["codex", "claude", "grok", "gemini", "agy", "muse"]),
  })
  .strict();
export const taskInput = z
  .object({ projectId: id, taskId, operation: z.enum(["run", "recover"]) })
  .strict();
export const actionInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archive_task"), projectId: id, taskId }).strict(),
  z.object({ kind: z.literal("remove_project"), projectId: id }).strict(),
  z.object({ kind: z.literal("clear_history") }).strict(),
]);
export const approvalInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("preview"), action: actionInput }).strict(),
  z
    .object({
      operation: z.literal("confirm"),
      id,
      confirmation: z.literal("CONFIRM"),
    })
    .strict(),
]);
export const detailInput = z.object({ projectId: id, taskId });
