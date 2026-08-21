import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { libsqlEsmScript } from "./libsqlScript.js";

const running = new Set<Gym>();
const RESTARTED_MARKER = "DAEMON_STARTED_WITH_UNREADABLE_EVENT_PAYLOAD";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon startup with persisted event history", () => {
    it("opens the socket without parsing persisted event payloads", async () => {
        const gym = await createGym({
            environment: {
                HAPPY_TERMINAL_SERVER_DIRECTORY: "/home/happy-terminal/.local/state/rig",
                HAPPY_TERMINAL_SERVER_SOCKET_PATH: "/tmp/rig-unreadable-event.sock",
            },
            mode: "docker",
            entrypoint: ["bash", "/workspace/restart-with-unreadable-event.sh"],
            files: {
                "corrupt-persisted-event.mjs": corruptPersistedEventScript,
                "restart-with-unreadable-event.sh": restartWithUnreadableEventScript,
            },
            inference: [],
        });
        running.add(gym);

        await gym.terminal.waitForText("Ask Happy Terminal to do anything", 30_000);
        gym.terminal.press("ctrlD");

        const restarted = await gym.terminal.waitForText(RESTARTED_MARKER, 30_000);
        expect(restarted.text).toContain("Daemon is running");
        expect(restarted.text).not.toContain("Unexpected end of JSON input");
    }, 120_000);
});

const corruptPersistedEventScript = libsqlEsmScript(String.raw`
const database = await openDatabase("/home/happy-terminal/.local/state/rig/sessions.sqlite");
try {
const event = (
    await database.execute("SELECT seq FROM session_events ORDER BY seq LIMIT 1")
).rows[0];
if (event === undefined) throw new Error("Expected a persisted session event.");
await database.execute({
    sql: "UPDATE session_events SET data_json = ? WHERE seq = ?",
    args: ["{", event.seq],
});
} finally {
    await database.close();
}
`);

const restartWithUnreadableEventScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

node /app/packages/happy-terminal/dist/main.js
node /app/packages/happy-terminal/dist/main.js daemon stop
while node /app/packages/happy-terminal/dist/main.js daemon status | grep -q 'Daemon is running'; do
    sleep 0.05
done
node /workspace/corrupt-persisted-event.mjs
node /app/packages/happy-terminal/dist/main.js daemon start
node /app/packages/happy-terminal/dist/main.js daemon status
echo ${RESTARTED_MARKER}
`;
