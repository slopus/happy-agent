import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { libsqlEsmScript } from "./libsqlScript.js";

const running = new Set<Gym>();
const SCHEMA_MARKER = "DAEMON_CREATED_FRESH_SQLITE_SCHEMA";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon startup with no database", () => {
    it("creates the module storage schema before becoming ready", async () => {
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
const database = await openDatabase("/home/happy-terminal/.happy/agent/agent.sqlite", true);
try {
const actualTables = (await database.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
))
    .rows
    .map((row) => row.name);
// The schema is owned by the modules, so its exact table set grows with them. The daemon is
// only ready once the storage foundation and its migration ledger exist.
for (const required of ["happy_agent_migrations", "happy_agent_records", "happy_agent_values"]) {
    if (!actualTables.includes(required)) {
        throw new Error("Missing module storage table: " + required + " in " + JSON.stringify(actualTables));
    }
}
for (const obsolete of ["sessions", "session_messages", "happy_sessions"]) {
    if (actualTables.includes(obsolete)) {
        throw new Error("The obsolete pre-daemon table was recreated: " + obsolete);
    }
}
} finally {
    await database.close();
}
`);

const startWithFreshDatabaseScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

test ! -e /home/happy-terminal/.happy/agent/agent.sqlite
node /app/packages/happy-terminal/dist/main.js daemon start
node /app/packages/happy-terminal/dist/main.js daemon status
node /workspace/verify-fresh-database.mjs
echo ${SCHEMA_MARKER}
sleep 60
`;
