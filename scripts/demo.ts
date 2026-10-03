// Deliberately synthetic. No JEV calls and no subscription CLI execution.
import { mkdir, cp, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, projects, addMessage } from "../lib/server/db";
import { dataDir } from "../lib/server/config";
import { operate } from "./project-state.mjs";
if (projects().length) {
  console.error(
    "Demo requires an empty registry. Use a separate CROUTER_DATA_DIR.",
  );
  process.exit(1);
}
const specs = [
  {
    name: "Atlas",
    aliases: ["atlas-web"],
    provider: "codex",
    tasks: [
      "Review authentication flow and outline edge cases",
      "Audit API error handling for consistent responses",
      "Plan a lighter onboarding experience",
    ],
  },
  {
    name: "Fieldnotes",
    aliases: ["notes-app"],
    provider: "claude",
    tasks: [
      "Review the Markdown editor accessibility",
      "Outline offline synchronization conflict handling",
    ],
  },
  {
    name: "Orbit",
    aliases: ["orbit-api"],
    provider: "codex",
    tasks: ["Review the queue retry strategy"],
  },
];
const ids = [];
for (const [index, spec] of specs.entries()) {
  const root = path.join(dataDir(), "demo", spec.name.toLowerCase());
  await mkdir(root, { recursive: true, mode: 0o700 });
  await cp(path.resolve("fixtures/project"), root, { recursive: true });
  const canonical = await realpath(root);
  const id = randomUUID();
  ids.push(id);
  db()
    .prepare(
      "INSERT INTO projects (id, name, path, aliases, createdAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      id,
      spec.name,
      canonical,
      JSON.stringify(spec.aliases),
      new Date(Date.now() + index).toISOString(),
    );
  for (const [i, text] of spec.tasks.entries()) {
    const result = await operate({
      root: canonical,
      operation: "create",
      text,
      provider: spec.provider,
    });
    if (i === 0)
      await operate({
        root: canonical,
        operation: "update",
        taskId: result.task.id,
        status: "done",
        threadId: randomUUID(),
        summary:
          "Synthetic review complete. A focused implementation plan is ready.",
        result:
          "Synthetic example: identify the behavior, propose a minimal change, and verify it with a focused test. No provider was called.",
      });
  }
}
addMessage("user", "What is the status of Atlas?");
addMessage(
  "assistant",
  "Atlas · 3 active tasks: 2 queued, 0 running, 1 done, 0 blocked.",
  { projectId: ids[0], intent: "status" },
);
addMessage(
  "user",
  "Create a task for Fieldnotes: review the Markdown editor accessibility.",
);
addMessage(
  "assistant",
  "Fieldnotes · Task queued for Claude. Open the task to inspect its details or start a read-only worker.",
  { projectId: ids[1], intent: "create_task" },
);
console.log(
  "Synthetic workspace created. Start with CROUTER_DEMO=1 npm run dev.",
);
