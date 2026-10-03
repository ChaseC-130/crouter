import "server-only";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  mkdirSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { db } from "./db";
import { dataDir } from "./config";
import {
  applyRoutingPreference,
  defaultRoutingPreferences,
} from "../routing-policy";
import { routingPreferenceInput, routingPreferencesSchema } from "./schemas";
import { AppError } from "./errors";
import type { RoutingPreferences } from "../types";

const maxBytes = 65536;
export function routingPreferencesFile() {
  return path.join(dataDir(), "routing.json");
}
function readPreferencesFile(): RoutingPreferences | undefined {
  let fd: number;
  try {
    fd = openSync(
      routingPreferencesFile(),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Invalid routing file");
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > maxBytes) throw new Error("Routing file too large");
    return routingPreferencesSchema.parse(
      JSON.parse(buffer.subarray(0, bytes).toString("utf8")),
    );
  } finally {
    closeSync(fd);
  }
}
function writePreferencesFile(preferences: RoutingPreferences) {
  const text = `${JSON.stringify(preferences, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error("Routing file too large");
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const file = routingPreferencesFile(),
    temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}
export function routingPreferences(): RoutingPreferences {
  try {
    const file = readPreferencesFile();
    if (file) return file;
    const row = db()
      .prepare("SELECT value FROM preferences WHERE key=?")
      .get("routing") as { value: string } | undefined;
    if (!row) return structuredClone(defaultRoutingPreferences);
    const value = JSON.parse(row.value);
    // Old exclusion lists implied every model was selected. Move to explicit opt-in.
    if (value.disabledModels && !value.enabledModels) {
      delete value.disabledModels;
      value.enabledModels = [];
    }
    const preferences = routingPreferencesSchema.parse(value);
    writePreferencesFile(preferences);
    return preferences;
  } catch {
    throw new AppError(
      "Local routing preferences could not be read. Check routing.json in the private data directory.",
      503,
    );
  }
}
export function updateRoutingPreferences(
  input: z.infer<typeof routingPreferenceInput>,
): RoutingPreferences {
  const parsed = routingPreferenceInput.parse(input);
  // Serialize UI writes across server processes as well as this process.
  db().exec("BEGIN IMMEDIATE");
  try {
    const preferences = routingPreferencesSchema.parse(
      applyRoutingPreference(routingPreferences(), parsed),
    );
    writePreferencesFile(preferences);
    db().exec("COMMIT");
    return preferences;
  } catch (error) {
    db().exec("ROLLBACK");
    if (error instanceof AppError) throw error;
    throw new AppError(
      "Local routing preferences could not be saved to routing.json.",
      503,
    );
  }
}
