import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "SECOND_DAEMON_COULD_NOT_REPLACE_SQLITE_OWNER";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("exclusive daemon ownership of the session database", () => {
    it("rejects a second daemon before it can replace the live socket or open SQLite", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { HAPPY_HOME_DIR: "/tmp/happy" },
            entrypoint: ["bash", "/workspace/verify-exclusive-daemon.sh"],
            files: {
                "verify-exclusive-daemon.sh": verifyExclusiveDaemonScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Daemon is running");
        expect(screen.text).toContain("Second daemon was rejected");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const verifyExclusiveDaemonScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/rig/dist/main.js "$@"
}

contender_log="/workspace/second-daemon.log"

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
    echo "Process $target_pid did not exit." >&2
    return 1
}

if ! rig daemon start; then
    cat /tmp/happy/agent/daemon.log >&2 || true
    exit 1
fi
owner_pid="$(read_daemon_pid)"
kill -0 "$owner_pid"

node /app/happy-agent/dist/cli.js run >"$contender_log" 2>&1 &
contender_pid=$!

for _ in $(seq 1 200); do
    if ! kill -0 "$contender_pid" 2>/dev/null; then
        break
    fi
    sleep 0.05
done

if kill -0 "$contender_pid" 2>/dev/null; then
    echo "The second daemon remained alive while the first owned the database." >&2
    cat "$contender_log" >&2
    exit 1
fi

test "$(read_daemon_pid)" = "$owner_pid"
kill -0 "$owner_pid"
status="$(rig daemon status)"
printf '%s\n' "$status"
if [[ "$status" != *"Daemon is running"* ]]; then
    echo "The original daemon stopped responding after the rejected start." >&2
    exit 1
fi

echo "Second daemon was rejected"
rig daemon stop
wait_for_exit "$owner_pid"
echo ${COMPLETED_MARKER}
sleep 60
`;
