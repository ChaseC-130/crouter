import { z } from "zod";
import { validModel } from "../../scripts/worker-selection.mjs";
const modelRef = {
  provider: z.enum(["codex", "claude", "grok", "agy", "muse"]),
  model: z.string().refine(validModel),
};
const routingRules = {
  instructions: z.string().trim().max(2000).default(""),
  rules: z
    .array(
      z
        .object({ ...modelRef, when: z.string().trim().min(1).max(500) })
        .strict(),
    )
    .max(16)
    .default([]),
};
export const routingPreferencesSchema = z
  .object({
    enabledModels: z.array(z.object(modelRef).strict()).max(512),
    usageAware: z.boolean(),
    minRemainingPercent: z.number().int().min(0).max(100),
    ...routingRules,
  })
  .strict();
export const routingPreferenceInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("rules"), ...routingRules }).strict(),
  z
    .object({
      operation: z.literal("model"),
      ...modelRef,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("models"),
      models: z.array(z.object(modelRef).strict()).max(512),
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ operation: z.literal("usage"), enabled: z.boolean() }).strict(),
  z
    .object({
      operation: z.literal("reserve"),
      minRemainingPercent: z.number().int().min(0).max(100),
    })
    .strict(),
]);
const id = z.string().uuid();
const taskId = z.string().regex(/^T-[a-f0-9]{8}$/);
export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    path: z.string().trim().min(1).max(1024),
    aliases: z.array(z.string().trim().min(2).max(40)).max(8).default([]),
    description: z.string().trim().max(1500).default(""),
  })
  .strict();
export const projectUpdateInput = projectInput
  .omit({ path: true })
  .extend({ id });
export const chatInput = z
  .object({
    turn: z.string().trim().min(1).max(4000),
    projectId: id.optional(),
    provider: z
      .enum(["auto", "codex", "claude", "grok", "agy", "muse"])
      .default("auto"),
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
