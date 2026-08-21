import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "DAEMON_CRASH_STACK_WRITTEN_TO_LOG";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon crash diagnostics", () => {
    it("writes an uncaught exception stack to its private daemon log", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/crash-daemon-and-check-report.sh"],
            files: {
                "crash-daemon-and-check-report.sh": crashDaemonAndCheckReportScript,
                "crash-daemon-preload.cjs": crashDaemonPreloadScript,
            },
            inference: [],
            startupText: COMPLETED_MARKER,
            timeoutMs: 30_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Daemon log contains the uncaught exception stack");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const crashDaemonAndCheckReportScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/rig/dist/main.js "$@"
}

export RIG_CRASH_TEST_SECRET="must-not-appear-in-report"
export NODE_OPTIONS="$NODE_OPTIONS --require=/workspace/crash-daemon-preload.cjs"
daemon_log="/home/rig/.happy/agent/daemon.log"

wait_for_exit() {
    local target_pid="$1"
    for _ in $(seq 1 200); do
        if ! kill -0 "$target_pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.05
    done
    echo "Daemon process $target_pid did not exit after its uncaught exception." >&2
    return 1
}

rig daemon start
daemon_pid="$(pgrep -f '/app/happy-agent/dist/cli.js run$' | head -n 1)"
test -n "$daemon_pid"
touch /workspace/trigger-daemon-crash
wait_for_exit "$daemon_pid"
grep -q "daemon uncaught crash marker" "$daemon_log"
if grep -q "$RIG_CRASH_TEST_SECRET" "$daemon_log"; then
    echo "The daemon log persisted an environment secret." >&2
    exit 1
fi
permissions="$(stat -c '%a' "$daemon_log")"
if [[ "$permissions" != "600" ]]; then
    echo "The daemon log has permissions $permissions instead of 600." >&2
    exit 1
fi

echo "Daemon log contains the uncaught exception stack"
echo ${COMPLETED_MARKER}
sleep 60
`;

const crashDaemonPreloadScript = String.raw`
if (process.argv[1]?.endsWith("/happy-agent/dist/cli.js") === true && process.argv.includes("run")) {
    const { existsSync } = require("node:fs");
    const timer = setInterval(() => {
        if (!existsSync("/workspace/trigger-daemon-crash")) return;
        clearInterval(timer);
        setImmediate(() => {
            throw new Error("daemon uncaught crash marker");
        });
    }, 20);
}
`;
