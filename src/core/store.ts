import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { paths } from "./paths";
import { notifyStateChanged } from "./change-events";
import { tunnelProfileSchema, tunnelSessionSchema, type TunnelProfile, type TunnelSession } from "../shared/types";

const stateSchema = z.object({
  version: z.literal(1),
  profiles: z.array(tunnelProfileSchema),
  sessions: z.array(tunnelSessionSchema),
});
export type State = z.infer<typeof stateSchema>;

type SqlValue = string | number | bigint | null;
type Row = Record<string, SqlValue>;
type Database = import("node:sqlite").DatabaseSync;
type Statement = import("node:sqlite").StatementSync;
const { DatabaseSync } = createRequire(__filename)("node:sqlite") as typeof import("node:sqlite");

async function openDatabase() {
  await fs.mkdir(path.dirname(paths.database()), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(paths.database());
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS tunnel_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('quick', 'named')),
      origin TEXT NOT NULL,
      hostname TEXT,
      tunnel_name TEXT,
      tunnel_id TEXT,
      dns_record_id TEXT,
      token_file TEXT,
      expires_in_seconds INTEGER,
      fixed_expires_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS tunnel_sessions (
      profile_id TEXT PRIMARY KEY REFERENCES tunnel_profiles(id) ON DELETE CASCADE,
      pid INTEGER,
      status TEXT NOT NULL CHECK (status IN ('starting', 'online', 'stopped', 'failed')),
      public_url TEXT,
      started_at TEXT,
      stopped_at TEXT,
      expires_at TEXT,
      error TEXT,
      log_path TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS tunnel_profiles_created_at ON tunnel_profiles(created_at DESC);
    CREATE INDEX IF NOT EXISTS tunnel_sessions_status ON tunnel_sessions(status);
  `);
  const profileColumns = database.prepare("PRAGMA table_info(tunnel_profiles)").all() as Array<{ name: string }>;
  if (!profileColumns.some((column) => column.name === "dns_record_id")) database.exec("ALTER TABLE tunnel_profiles ADD COLUMN dns_record_id TEXT");
  await fs.chmod(paths.database(), 0o600);
  return database;
}

function optionalString(row: Row, column: string) {
  const value = row[column];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(row: Row, column: string) {
  const value = row[column];
  return typeof value === "number" ? value : undefined;
}

function stateFromDatabase(database: Database): State {
  const profileRows = database.prepare("SELECT * FROM tunnel_profiles ORDER BY created_at").all() as Row[];
  const sessionRows = database.prepare("SELECT * FROM tunnel_sessions").all() as Row[];
  return stateSchema.parse({
    version: 1,
    profiles: profileRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      kind: String(row.kind),
      origin: String(row.origin),
      ...(optionalString(row, "hostname") ? { hostname: optionalString(row, "hostname") } : {}),
      ...(optionalString(row, "tunnel_name") ? { tunnelName: optionalString(row, "tunnel_name") } : {}),
      ...(optionalString(row, "tunnel_id") ? { tunnelId: optionalString(row, "tunnel_id") } : {}),
      ...(optionalString(row, "dns_record_id") ? { dnsRecordId: optionalString(row, "dns_record_id") } : {}),
      ...(optionalString(row, "token_file") ? { tokenFile: optionalString(row, "token_file") } : {}),
      ...(optionalNumber(row, "expires_in_seconds") ? { expiresInSeconds: optionalNumber(row, "expires_in_seconds") } : {}),
      ...(optionalString(row, "fixed_expires_at") ? { fixedExpiresAt: optionalString(row, "fixed_expires_at") } : {}),
      createdAt: String(row.created_at),
    })),
    sessions: sessionRows.map((row) => ({
      profileId: String(row.profile_id),
      status: String(row.status),
      ...(optionalNumber(row, "pid") ? { pid: optionalNumber(row, "pid") } : {}),
      ...(optionalString(row, "public_url") ? { publicUrl: optionalString(row, "public_url") } : {}),
      ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at") } : {}),
      ...(optionalString(row, "stopped_at") ? { stoppedAt: optionalString(row, "stopped_at") } : {}),
      ...(optionalString(row, "expires_at") ? { expiresAt: optionalString(row, "expires_at") } : {}),
      ...(optionalString(row, "error") ? { error: optionalString(row, "error") } : {}),
      ...(optionalString(row, "log_path") ? { logPath: optionalString(row, "log_path") } : {}),
    })),
  });
}

function insertProfiles(statement: Statement, profiles: TunnelProfile[]) {
  for (const profile of profiles) statement.run(
    profile.id, profile.name, profile.description, profile.kind, profile.origin,
    profile.hostname ?? null, profile.tunnelName ?? null, profile.tunnelId ?? null,
    profile.dnsRecordId ?? null, profile.tokenFile ?? null, profile.expiresInSeconds ?? null, profile.fixedExpiresAt ?? null,
    profile.createdAt,
  );
}

function insertSessions(statement: Statement, sessions: TunnelSession[]) {
  for (const session of sessions) statement.run(
    session.profileId, session.pid ?? null, session.status, session.publicUrl ?? null,
    session.startedAt ?? null, session.stoppedAt ?? null, session.expiresAt ?? null,
    session.error ?? null, session.logPath ?? null,
  );
}

function replaceState(database: Database, input: State) {
  const state = stateSchema.parse(input);
  database.exec("DELETE FROM tunnel_sessions; DELETE FROM tunnel_profiles;");
  insertProfiles(database.prepare(`INSERT INTO tunnel_profiles (
    id, name, description, kind, origin, hostname, tunnel_name, tunnel_id, dns_record_id, token_file,
    expires_in_seconds, fixed_expires_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), state.profiles);
  insertSessions(database.prepare(`INSERT INTO tunnel_sessions (
    profile_id, pid, status, public_url, started_at, stopped_at, expires_at, error, log_path
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`), state.sessions);
}

export async function readState(): Promise<State> {
  const database = await openDatabase();
  try {
    return stateFromDatabase(database);
  } finally {
    database.close();
  }
}

export async function updateState<T>(update: (state: State) => T): Promise<T> {
  const database = await openDatabase();
  database.exec("BEGIN IMMEDIATE");
  let result!: T;
  let changed = false;
  try {
    const state = stateFromDatabase(database);
    const before = JSON.stringify(state);
    result = update(state);
    if (result instanceof Promise) throw new Error("SQLite state updates must be synchronous");
    changed = JSON.stringify(state) !== before;
    if (changed) replaceState(database, state);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  if (changed) await notifyStateChanged();
  return result;
}

export function putProfile(state: State, profile: TunnelProfile, session: TunnelSession) {
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  state.sessions = state.sessions.filter((item) => item.profileId !== profile.id);
  state.profiles.push(profile);
  state.sessions.push(session);
}
