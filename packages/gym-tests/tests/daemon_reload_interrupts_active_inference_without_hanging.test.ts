import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();
const COMPLETED_MARKER = "ACTIVE_INFERENCE_AGENT_REPLACEMENT_COMPLETE";

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("Happy Agent replacement during inference", () => {
    it("interrupts the active run and starts the replacement daemon without hanging", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { HAPPY_HOME_DIR: "/tmp/happy" },
            entrypoint: ["bash", "/workspace/replace-agent-during-inference.sh"],
            files: {
                "replace-agent-during-inference.sh": replaceAgentDuringInferenceScript,
            },
            inference: [
                {
                    content: [{ text: "This response should be interrupted.", type: "text" }],
                    completionDelayMs: 120_000,
                },
                {
                    content: [{ text: "The replacement daemon is responsive.", type: "text" }],
                },
            ],
            startupText: COMPLETED_MARKER,
            timeoutMs: 50_000,
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Active inference reached the daemon");
        expect(screen.text).toContain("Replacement daemon has a new PID");
        expect(screen.text).toContain("The replacement daemon is responsive.");
        expect(screen.text).toContain(COMPLETED_MARKER);
    }, 120_000);
});

const replaceAgentDuringInferenceScript = String.raw`#!/usr/bin/env bash
set -euo pipefail

rig() {
    node /app/packages/rig/dist/main.js "$@"
}

active_log="/workspace/active-inference.log"
touch "$active_log"
rig exec --stream-json "Keep this inference active while the Happy Agent is replaced." \
    >"$active_log" 2>&1 &
active_client_pid="$!"

if ! timeout 20 grep -m 1 '"type":"run.started"' < <(tail -n +1 -F "$active_log") >/dev/null; then
    echo "The active inference never reached the daemon." >&2
    exit 1
fi
echo "Active inference reached the daemon"

old_daemon_pid="$(tr -d '[:space:]' < /tmp/happy/agent/daemon.pid)"
rig daemon reload
new_daemon_pid="$(tr -d '[:space:]' < /tmp/happy/agent/daemon.pid)"

if [[ "$new_daemon_pid" = "$old_daemon_pid" ]]; then
    echo "The replacement reused daemon PID $old_daemon_pid." >&2
    exit 1
fi
if kill -0 "$old_daemon_pid" 2>/dev/null; then
    echo "The old daemon process $old_daemon_pid is still alive." >&2
    exit 1
fi
kill -0 "$new_daemon_pid"
echo "Replacement daemon has a new PID"

if ! timeout 20 tail --pid="$active_client_pid" -f /dev/null; then
    echo "The client following the interrupted inference did not settle." >&2
    exit 1
fi

rig exec --json "Prove the replacement daemon can run inference." | tee /workspace/replacement.json
grep -q "The replacement daemon is responsive." /workspace/replacement.json
rig daemon stop

echo ${COMPLETED_MARKER}
sleep 60
`;
