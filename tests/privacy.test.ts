import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const scanner = path.resolve("scripts/privacy-check.mjs");
test("privacy scan checks staged blobs, withholds values, and inspects fixtures", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "crouter-privacy-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  const scan = () =>
    execFileSync(process.execPath, [scanner], { cwd, stdio: "pipe" });
  const fabricatedKey = "sk-" + "SYNTHETIC".repeat(4);
  const rejection = () =>
    assert.throws(scan, (error: unknown) => {
      const stderr = (error as { stderr: Buffer }).stderr.toString();
      return (
        stderr.includes("API-key-shaped value") &&
        !stderr.includes(fabricatedKey)
      );
    });
  try {
    git("init", "--quiet");
    await writeFile(path.join(cwd, "source.txt"), fabricatedKey);
    git("add", "source.txt");
    await writeFile(path.join(cwd, "source.txt"), "sanitized working copy\n");
    rejection();
    git("add", "source.txt");
    assert.match(scan().toString(), /Git index files/);
    await mkdir(path.join(cwd, "fixtures"));
    await writeFile(path.join(cwd, "fixtures", "sample.txt"), fabricatedKey);
    git("add", "fixtures/sample.txt");
    rejection();
    await writeFile(path.join(cwd, "fixtures", "sample.txt"), "synthetic\n");
    await writeFile(
      path.join(cwd, "fixtures", "private.sqlite"),
      Buffer.from([0, 1]),
    );
    git("add", "fixtures");
    assert.throws(scan, (error: unknown) =>
      (error as { stderr: Buffer }).stderr
        .toString()
        .includes("private runtime file"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
