import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";
import { libsqlEsmScript } from "./libsqlScript.js";

const running = new Set<Gym>();
const SCHEMA_MARKER = "DAEMON_CREATED_FRESH_SQLITE_SCHEMA";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon startup with no database", () => {
    it("atomically creates the strict init schema before becoming ready", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/start-with-fresh-database.sh"],
            files: {
                "start-with-fresh-database.sh": startWithFreshDatabaseScript,
                "verify-fresh-database.mjs": verifyFreshDatabaseScript,
            },
            inference: [],
            startupText: SCHEMA_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const started = await gym.terminal.snapshot();
        expect(started.text).toContain("Daemon is running");
        expect(started.text).toContain(SCHEMA_MARKER);
    }, 120_000);
});

const verifyFreshDatabaseScript = libsqlEsmScript(String.raw`
const database = await openDatabase("/home/rig/.happy/rig/sessions.sqlite", true);
try {
const expectedTables = [
    "durable_global_event_state",
    "durable_global_events",
    "durable_user_inputs",
    "durable_waits",
    "happy_outbox",
    "happy_sessions",
    "project_avatar_assets",
    "project_secret_attachments",
    "project_workspaces",
    "projects",
    "queued_runs",
    "scheduled_messages",
    "secret_environment_variables",
    "secret_registrations",
    "session_context_messages",
    "session_events",
    "session_messages",
    "session_turns",
    "sessions",
];
const actualTables = (await database.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
))
    .rows
    .map((row) => row.name);
if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new Error("Unexpected fresh schema tables: " + JSON.stringify(actualTables));
}

const sessionColumns = new Map(
    (await database.execute("PRAGMA table_info(sessions)")).rows.map((column) => [
        column.name,
        column,
    ]),
);
for (const name of ["project_id", "root_session_id"]) {
    if (sessionColumns.get(name)?.notnull !== 1) {
        throw new Error("Expected strict sessions column: " + name);
    }
}
if (sessionColumns.has("context_messages_json")) {
    throw new Error("The obsolete context_messages_json column was recreated.");
}
if (actualTables.includes("session_database_migrations")) {
    throw new Error("The obsolete migration progress table was recreated.");
}

const version = (await database.execute("PRAGMA user_version")).rows[0].user_version;
if (version !== 4) throw new Error("Expected schema version 4, received " + String(version));
} finally {
    await database.close();
}
`);

const startWithFreshDatabaseScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

test ! -e /home/rig/.happy/rig/sessions.sqlite
node /app/packages/rig/dist/main.js daemon start
node /app/packages/rig/dist/main.js daemon status
node /workspace/verify-fresh-database.mjs
echo ${SCHEMA_MARKER}
sleep 60
`;
