import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "DAEMON_STARTUP_ERROR_STATUS_AND_RELOAD_COMPLETE";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon startup failure handling", () => {
    it("fails readably on a broken database and recovers once it is repaired", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/exercise-daemon-startup-error.sh"],
            files: {
                "exercise-daemon-startup-error.sh": exerciseDaemonStartupErrorScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 60_000,
        });
        running.add(gym);

        const started = await gym.terminal.snapshot();
        expect(started.text).toContain("START_FAILED_AS_EXPECTED");
        expect(started.text).toContain("Daemon is not running");
        expect(started.text).toContain("Daemon is running");
        expect(started.text).toContain("Daemon is stopping");
        expect(started.text).toContain(COMPLETED_MARKER);
    }, 180_000);
});

const exerciseDaemonStartupErrorScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/happy-terminal/dist/main.js "$@"
}

# A file that is not a SQLite database keeps the daemon from starting.
mkdir -p /home/happy-terminal/.happy/agent
printf 'not a SQLite database' > /home/happy-terminal/.happy/agent/agent.sqlite

if happy-terminal daemon start; then
    echo "Expected daemon start to fail." >&2
    exit 1
fi
echo START_FAILED_AS_EXPECTED

happy-terminal daemon status

# Repairing the database lets the same command start the daemon.
rm /home/happy-terminal/.happy/agent/agent.sqlite
happy-terminal daemon start
happy-terminal daemon status

happy-terminal daemon stop
for _ in $(seq 1 200); do
    if ! happy-terminal daemon status | grep -q "Daemon is running"; then
        break
    fi
    sleep 0.05
done
happy-terminal daemon status

echo ${COMPLETED_MARKER}
sleep 60
`;
