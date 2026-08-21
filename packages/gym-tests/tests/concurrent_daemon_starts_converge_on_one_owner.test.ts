import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "CONCURRENT_DAEMON_STARTS_SHARED_ONE_OWNER";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("concurrent local daemon startup", () => {
    it("serializes every caller onto one daemon and one SQLite owner", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { HAPPY_HOME_DIR: "/tmp/happy" },
            entrypoint: ["bash", "/workspace/start-daemon-concurrently.sh"],
            files: {
                "start-daemon-concurrently.sh": startDaemonConcurrentlyScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("All concurrent clients reached one daemon");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const startDaemonConcurrentlyScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/happy-terminal/dist/main.js "$@"
}

barrier="/workspace/start-daemon-now"
client_pids=""

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

for index in $(seq 1 8); do
    (
        while [[ ! -e "$barrier" ]]; do
            sleep 0.01
        done
        happy-terminal daemon start >"/workspace/start-$index.log" 2>&1
    ) &
    client_pids="$client_pids $!"
done

touch "$barrier"
for client_pid in $client_pids; do
    wait "$client_pid"
done

for index in $(seq 1 8); do
    output="$(cat "/workspace/start-$index.log")"
    if [[ "$output" != *"Daemon is running"* ]]; then
        echo "Concurrent client $index did not reach the daemon:" >&2
        printf '%s\n' "$output" >&2
        exit 1
    fi
done

daemon_count="$(pgrep -fc '/app/happy-agent/dist/cli.js run$')"
if [[ "$daemon_count" != "1" ]]; then
    echo "Expected one ready daemon, found $daemon_count." >&2
    exit 1
fi

owner_pid="$(read_daemon_pid)"
kill -0 "$owner_pid"
happy-terminal daemon status
echo "All concurrent clients reached one daemon"
happy-terminal daemon stop
wait_for_exit "$owner_pid"
echo ${COMPLETED_MARKER}
sleep 60
`;
