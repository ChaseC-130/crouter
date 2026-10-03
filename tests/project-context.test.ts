import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db, projects } from "../lib/server/db";
import { registerProject, updateProjectDetails } from "../lib/server/service";
import { PATCH } from "../app/api/projects/route";
import { projectInput, chatInput } from "../lib/server/schemas";

const temp = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "crouter-context-")),
);
process.env.CROUTER_DATA_DIR = path.join(temp, "private");
process.env.CROUTER_ORIGIN = "http://127.0.0.1:3000";
delete process.env.CROUTER_TAILSCALE_ORIGIN;
await mkdir(process.env.CROUTER_DATA_DIR);
const legacy = new DatabaseSync(
  path.join(process.env.CROUTER_DATA_DIR, "router.sqlite"),
);
legacy.exec(
  "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, path TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL, createdAt TEXT NOT NULL)",
);
const oldId = "11111111-1111-4111-8111-111111111111";
legacy
  .prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)")
  .run(
    oldId,
    "Legacy",
    path.join(temp, "legacy"),
    '["old"]',
    new Date().toISOString(),
  );
legacy.close();
after(async () => {
  db().close();
  await rm(temp, { recursive: true, force: true });
});

test("existing registries migrate without losing projects or aliases", () => {
  const [project] = projects();
  assert.equal(project.id, oldId);
  assert.deepEqual(project.aliases, ["old"]);
  assert.equal(project.description, "");
});
test("project context persists and edits preserve project path and agent state", async () => {
  const root = path.join(temp, "game");
  await mkdir(root);
  const description =
    "A strategy game with unit tiers, combat roles, upgrades and balance audits.";
  const { project } = await registerProject(
    "Tactics",
    root,
    ["units"],
    description,
  );
  assert.equal(project.description, description);
  const state = path.join(root, ".router-agent/tasks.md");
  const before = await readFile(state, "utf8");
  const updated = await updateProjectDetails(
    project.id,
    "Tactics Arena",
    ["arena"],
    description + " Keep units distinct within tiers.",
  );
  assert.equal(updated.project.id, project.id);
  assert.equal(updated.project.path, root);
  assert.equal(updated.project.name, "Tactics Arena");
  assert.deepEqual(updated.project.aliases, ["arena"]);
  assert.equal(await readFile(state, "utf8"), before);
  assert.equal(
    db().prepare("SELECT description FROM projects WHERE id=?").get(project.id)
      ?.description,
    updated.project.description,
  );
  await assert.rejects(
    () => updateProjectDetails(project.id, "Another", ["old"], "Other"),
    /unique/,
  );
  assert.equal(
    projects().find((p) => p.id === project.id)?.name,
    "Tactics Arena",
  );
});
test("project updates require same-origin safeguards and validate the context boundary", async () => {
  const request = (origin: string, body: unknown) =>
    new Request("http://127.0.0.1:3000/api/projects", {
      method: "PATCH",
      headers: {
        origin,
        "content-type": "application/json",
        "x-crouter-request": "1",
      },
      body: JSON.stringify(body),
    });
  const input = {
    id: oldId,
    name: "Legacy",
    aliases: ["old"],
    description: "A legacy service with billing reports.",
  };
  assert.equal(
    (await PATCH(request("https://other.example", input))).status,
    403,
  );
  assert.equal(
    (
      await PATCH(
        request("http://127.0.0.1:3000", {
          ...input,
          description: "x".repeat(1501),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await PATCH(
        request("http://127.0.0.1:3000", { ...input, path: "/another/path" }),
      )
    ).status,
    400,
  );
  const response = await PATCH(request("http://127.0.0.1:3000", input));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project.description, input.description);
  assert.equal(
    projectInput.parse({ name: "New", path: rootPath(), aliases: [] })
      .description,
    "",
  );
  assert.equal(
    chatInput.parse({ turn: "Audit unit balance", projectId: oldId }).projectId,
    oldId,
  );
  assert.throws(() => chatInput.parse({ turn: "Audit", projectId: "unknown" }));
});
function rootPath() {
  return path.join(temp, "game");
}
