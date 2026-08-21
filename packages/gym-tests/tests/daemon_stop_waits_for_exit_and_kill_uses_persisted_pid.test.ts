import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "DAEMON_STOP_AND_KILL_LIFECYCLE_COMPLETE";

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("daemon stop and forced termination", () => {
    it("waits for graceful exit and can kill the persisted daemon PID", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { HAPPY_HOME_DIR: "/tmp/happy" },
            entrypoint: ["bash", "/workspace/exercise-daemon-lifecycle.sh"],
            files: {
                "exercise-daemon-lifecycle.sh": exerciseDaemonLifecycleScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 60_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Graceful stop waited for process exit");
        expect(screen.text).toContain("Persisted daemon PID matched the live process");
        expect(screen.text).toContain("Shutdown steps were logged");
        expect(screen.text).toContain("Forced daemon kill completed");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const exerciseDaemonLifecycleScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/happy-terminal/dist/main.js "$@"
}

find_daemon_pid() {
    pgrep -f '/app/happy-agent/dist/cli.js run$' | head -n 1
}

pid_file="/tmp/happy/agent/daemon.pid"
observation_log="/tmp/happy/agent/observation/agent.log"

happy-terminal daemon start
graceful_pid="$(find_daemon_pid)"
test -n "$graceful_pid"

happy-terminal daemon stop
if kill -0 "$graceful_pid" 2>/dev/null; then
    echo "Graceful stop returned before daemon process $graceful_pid exited." >&2
    exit 1
fi
test ! -e "$pid_file"
echo "Graceful stop waited for process exit"

grep -q "daemon:shutdown:start pid=$graceful_pid" "$observation_log"
grep -q "daemon:shutdown:step:start pid=$graceful_pid step=agent-system" "$observation_log"
echo "Shutdown steps were logged"

happy-terminal daemon start
persisted_pid="$(tr -d '[:space:]' < "$pid_file")"
live_pid="$(find_daemon_pid)"
if [[ "$persisted_pid" != "$live_pid" ]]; then
    echo "Persisted PID $persisted_pid did not match live daemon PID $live_pid." >&2
    exit 1
fi
echo "Persisted daemon PID matched the live process"

happy-terminal daemon kill
if kill -0 "$persisted_pid" 2>/dev/null; then
    echo "Daemon process $persisted_pid survived the kill command." >&2
    exit 1
fi
test ! -e "$pid_file"
happy-terminal daemon status
echo "Forced daemon kill completed"

echo ${COMPLETED_MARKER}
sleep 60
`;
