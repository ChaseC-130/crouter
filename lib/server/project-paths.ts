import "server-only";
import path from "node:path";
import os from "node:os";
import { realpath, lstat } from "node:fs/promises";
import { dataDir } from "./config";
import { AppError } from "./errors";
export function projectPathBase() {
  return path.resolve(process.env.CROUTER_PROJECTS_DIR || process.cwd());
}
export async function resolveProjectPath(requested: string) {
  const value = requested.trim();
  if (
    !value ||
    value.length > 1024 ||
    value.includes("\0") ||
    (value.startsWith("~") && value !== "~" && !value.startsWith("~/"))
  )
    throw new AppError(
      "Use a relative, absolute, or ~/ project path on this host.",
    );
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith("~/")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  let root: string;
  try {
    root = await realpath(path.resolve(projectPathBase(), expanded));
    if (!(await lstat(root)).isDirectory()) throw new Error();
  } catch {
    throw new AppError(
      "Project directory does not exist or is inaccessible on this host.",
    );
  }
  const reserved = await Promise.all(
    [os.homedir(), dataDir()].map((p) =>
      realpath(p).catch(() => path.resolve(p)),
    ),
  );
  if (
    [path.parse(root).root, ...reserved].includes(root) ||
    root.startsWith(reserved[1] + path.sep)
  )
    throw new AppError(
      "Choose a specific project folder, not a home, filesystem root, or runtime data directory.",
    );
  return root;
}
