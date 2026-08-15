import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startStateChangeServer } from "./change-events";
import { readState, updateState } from "./store";

let directory = "";

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ants-sqlite-test-"));
  process.env.ANTS_NEST_HOME = directory;
});

afterEach(async () => {
  delete process.env.ANTS_NEST_HOME;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("SQLite state store", () => {
  it("persists tunnel state in WAL mode and emits a local change event", async () => {
    let changes = 0;
    const stopEvents = await startStateChangeServer(() => { changes += 1; });
    await updateState((state) => {
      state.profiles.push({
        id: "profile-1",
        name: "Dashboard",
        description: "Internal dashboard preview",
        kind: "quick",
        origin: "http://localhost:3000",
        createdAt: new Date().toISOString(),
      });
      state.sessions.push({ profileId: "profile-1", status: "stopped" });
    });

    expect((await readState()).profiles[0]?.description).toBe("Internal dashboard preview");
    expect(changes).toBe(1);
    await expect(fs.stat(path.join(directory, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(path.join(directory, "state.sqlite"))).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(path.join(directory, "state.sqlite"));
    expect((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    database.close();
    await stopEvents();
  });
});
