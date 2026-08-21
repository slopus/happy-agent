import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "CRASHED_DAEMON_RELEASED_SQLITE_OWNERSHIP";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("session database ownership after a daemon crash", () => {
    it("lets a replacement acquire the kernel lock without stale-file recovery", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { HAPPY_HOME_DIR: "/tmp/happy" },
            entrypoint: ["bash", "/workspace/replace-crashed-daemon.sh"],
            files: {
                "replace-crashed-daemon.sh": replaceCrashedDaemonScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Replacement daemon acquired SQLite ownership");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const replaceCrashedDaemonScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/happy-terminal/dist/main.js "$@"
}

read_daemon_pid() {
    pgrep -f '/app/happy-agent/dist/cli.js run$' | head -n 1
}

wait_for_exit() {
    local target_pid="$1"
    for _ in $(seq 1 200); do
        if ! kill -0 "$target_pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.05
    done
    echo "Daemon process $target_pid did not exit." >&2
    return 1
}

happy-terminal daemon start
crashed_pid="$(read_daemon_pid)"
kill -KILL "$crashed_pid"
wait_for_exit "$crashed_pid"

happy-terminal daemon start
replacement_pid="$(read_daemon_pid)"
if [[ "$replacement_pid" = "$crashed_pid" ]]; then
    echo "The crashed daemon was not replaced." >&2
    exit 1
fi
kill -0 "$replacement_pid"
happy-terminal daemon status

echo "Replacement daemon acquired SQLite ownership"
happy-terminal daemon stop
wait_for_exit "$replacement_pid"
echo ${COMPLETED_MARKER}
sleep 60
`;
