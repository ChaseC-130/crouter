import "server-only";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import { directory } from "../../scripts/project-state.mjs";
import { dataDir } from "./config";
import { GENERAL_WORKSPACE_ID } from "../workspaces";
import type { Project } from "../types";

export function generalWorkspace(): Project {
  return {
    id: GENERAL_WORKSPACE_ID,
    kind: "general",
    name: "General",
    aliases: [],
    description:
      "Generic questions, writing, research and other work unrelated to a registered project. Workers start in an isolated scratch folder with no project context.",
    path: path.join(dataDir(), "general"),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export async function generalTaskDirectory(taskId: string) {
  if (!/^T-[a-f0-9]{8}$/.test(taskId)) throw new Error("Invalid task ID");
  // Keep workers outside the app checkout so CLIs cannot inherit its project instructions.
  // A stable per-installation root also preserves the cwd on session resume.
  const key = createHash("sha256").update(dataDir()).digest("hex").slice(0, 24);
  const base = await directory(
    await realpath(os.tmpdir()),
    `crouter-general-${key}`,
    true,
  );
  const stat = await lstat(base);
  if (
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("General workspace must be private to this user");
  return directory(base, taskId, true);
}
