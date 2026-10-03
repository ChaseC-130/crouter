import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "./config";
import { AppError } from "./errors";
import type { Project, Message, ApprovalAction } from "../types";
let database: DatabaseSync | undefined;
export function db() {
  if (database) return database;
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const file = path.join(dataDir(), "router.sqlite");
  database = new DatabaseSync(file);
  chmodSync(file, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, path TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL, projectId TEXT, intent TEXT);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, action TEXT NOT NULL, expires INTEGER NOT NULL, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);`);
  return database;
}
export function projects(): Project[] {
  return (
    db()
      .prepare("SELECT * FROM projects ORDER BY createdAt")
      .all() as unknown as (Omit<Project, "aliases"> & { aliases: string })[]
  ).map((p) => ({ ...p, aliases: JSON.parse(p.aliases) }));
}
export function project(id: string) {
  const p = projects().find((p) => p.id === id);
  if (!p) throw new AppError("Project is no longer registered.", 404);
  return p;
}
export function messages(): Message[] {
  return db()
    .prepare(
      "SELECT * FROM messages WHERE id IN (SELECT id FROM messages ORDER BY createdAt DESC, rowid DESC LIMIT 200) ORDER BY createdAt, rowid",
    )
    .all() as unknown as Message[];
}
export function addMessage(
  role: Message["role"],
  content: string,
  route?: { projectId: string; intent: string },
) {
  db()
    .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      randomUUID(),
      role,
      content.slice(0, 12000),
      new Date().toISOString(),
      route?.projectId || null,
      route?.intent || null,
    );
  db().exec(
    "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY createdAt DESC, rowid DESC LIMIT 200)",
  );
}
export function saveApproval(
  id: string,
  action: ApprovalAction,
  expires: number,
  fingerprint: string,
) {
  db().prepare("DELETE FROM approvals WHERE expires < ?").run(Date.now());
  db()
    .prepare("INSERT INTO approvals VALUES (?, ?, ?, ?)")
    .run(id, JSON.stringify(action), expires, fingerprint);
}
export function takeApproval(id: string) {
  const row = db()
    .prepare("DELETE FROM approvals WHERE id = ? RETURNING *")
    .get(id) as
    { action: string; expires: number; fingerprint: string } | undefined;
  if (!row || row.expires < Date.now())
    throw new AppError(
      "This approval expired or was already used. Preview the action again.",
      409,
    );
  return { ...row, action: JSON.parse(row.action) as ApprovalAction };
}
export async function withLease<T>(
  key: string,
  fn: () => Promise<T>,
  ttl = 30000,
): Promise<T> {
  const owner = randomUUID();
  const acquired = db()
    .prepare(
      "INSERT INTO leases VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE leases.expires < ? RETURNING owner",
    )
    .get(key, owner, Date.now() + ttl, Date.now());
  if (!acquired)
    throw new AppError(
      "This project has another operation in progress. Retry in a moment.",
      409,
    );
  try {
    return await fn();
  } finally {
    db()
      .prepare("DELETE FROM leases WHERE key = ? AND owner = ?")
      .run(key, owner);
  }
}
export function hasLease(key: string) {
  return Boolean(
    db()
      .prepare("SELECT key FROM leases WHERE key=? AND expires>?")
      .get(key, Date.now()),
  );
}
