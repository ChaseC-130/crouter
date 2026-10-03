// Scan exact Git index contents before publication; never print matched secret values.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import path from "node:path";
const ignored = new Set([
  "node_modules",
  ".next",
  ".crouter",
  ".git",
  "coverage",
  "playwright-report",
  "test-results",
]);
function walk(dir = ".") {
  return readdirSync(dir).flatMap((name) => {
    if (
      ignored.has(name) ||
      (name.startsWith(".env") && name !== ".env.example") ||
      name.endsWith(".tsbuildinfo")
    )
      return [];
    const file = path.join(dir, name);
    return lstatSync(file).isDirectory() ? walk(file) : [file];
  });
}
let files,
  index = true;
try {
  files = execFileSync("git", ["ls-files", "--cached", "-z"], {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .split("\0")
    .filter(Boolean);
} catch {
  index = false;
  files = walk();
}
if (!files.length) {
  index = false;
  files = walk();
}
const issues = [];
const syntheticState = new Set([
  "fixtures/project/.router-agent/tasks.md",
  "fixtures/project/.router-agent/agents.md",
  "fixtures/project/.router-agent/decisions.md",
]);
const rules = [
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API-key-shaped value"],
  [/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/, "GitHub-token-shaped value"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/\bAKIA[A-Z0-9]{16}\b/, "AWS-key-shaped value"],
  [/\/Users\/[a-zA-Z][a-zA-Z0-9._-]+\//, "personal macOS path"],
  [/\/home\/[a-zA-Z][a-zA-Z0-9._-]+\//, "personal Linux path"],
  [
    /(?:TYPESAFE_API_KEY|CLOUDFLARE_(?:API|AUTH)_TOKEN)[\t ]*=[\t ]*["']?(?![\s"'$#])[A-Za-z0-9_-]{12,}/,
    "configured routing key",
  ],
];
for (const name of files) {
  if (
    !syntheticState.has(name) &&
    /(^|\/)(?:\.router-agent|\.crouter|\.codex|\.claude|\.gemini|\.muse|\.grok|private)(\/|$)|(?:\.sqlite(?:-wal|-shm)?|\.db|\.pem|\.key|\.log)$|(^|\/)\.env(?!\.example$)|(^|\/)(?:auth|credentials)\.json$/.test(
      name,
    )
  )
    issues.push(`${name}: private runtime file`);
  let content;
  try {
    content = index
      ? execFileSync("git", ["show", `:${name}`], {
          maxBuffer: 10000000,
          stdio: ["ignore", "pipe", "ignore"],
        })
      : readFileSync(name);
  } catch {
    issues.push(`${name}: cannot inspect content`);
    continue;
  }
  if (content.includes(0)) continue;
  for (const [pattern, label] of rules)
    if (pattern.test(content.toString())) issues.push(`${name}: ${label}`);
}
if (issues.length) {
  console.error(
    "Privacy check failed (values withheld):\n" + issues.join("\n"),
  );
  process.exitCode = 1;
} else
  console.log(
    `Privacy check passed for ${files.length} ${index ? "Git index" : "publishable workspace"} files. Review screenshots, fixtures, and Git history separately.`,
  );
