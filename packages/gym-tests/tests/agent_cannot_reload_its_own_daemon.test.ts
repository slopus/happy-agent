import { expect, it } from "vitest";

import { createGym } from "@slopus/happy-terminal-gym";

it("rejects a foreground self-reload and keeps the session usable", async () => {
    const gym = await createGym({
        mode: "docker",
        inference(request, callIndex) {
            if (callIndex === 0) {
                return {
                    content: [
                        {
                            type: "toolCall",
                            id: "self-reload",
                            name: "exec_command",
                            arguments: {
                                cmd: "node /app/happy-agent/dist/cli.js reload",
                                yield_time_ms: 10_000,
                            },
                        },
                    ],
                };
            }
            if (callIndex === 1) {
                expect(JSON.stringify(request.context.messages)).toContain(
                    "Cannot reload Happy Agent from a process owned by that daemon.",
                );
                return { content: [{ type: "text", text: "SELF_RELOAD_REJECTED" }] };
            }
            expect(callIndex).toBe(2);
            return { content: [{ type: "text", text: "SESSION_STILL_USABLE" }] };
        },
    });
    try {
        gym.terminal.type("Try a foreground reload of this daemon.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SELF_RELOAD_REJECTED", 30_000);
        gym.terminal.type("Continue this session.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SESSION_STILL_USABLE", 30_000);
    } finally {
        await gym.dispose();
    }
}, 90_000);

it("lets an independent caller replace the daemon and wait for readiness", async () => {
    const script = String.raw`
set -euo pipefail
agent() { node /app/happy-agent/dist/cli.js "$@"; }
agent start
old_pid="$(cat /tmp/happy/agent/daemon.pid)"
agent reload
new_pid="$(cat /tmp/happy/agent/daemon.pid)"
test "$old_pid" != "$new_pid"
if kill -0 "$old_pid" 2>/dev/null; then exit 1; fi
kill -0 "$new_pid"
agent status
agent stop
echo EXTERNAL_RELOAD_READY
exec sleep 60
`;
    const gym = await createGym({
        mode: "docker",
        environment: { HAPPY_HOME_DIR: "/tmp/happy" },
        entrypoint: ["bash", "-c", script],
        startupText: "EXTERNAL_RELOAD_READY",
        timeoutMs: 30_000,
        inference: [],
    });
    try {
        expect((await gym.terminal.snapshot()).text).toContain("EXTERNAL_RELOAD_READY");
    } finally {
        await gym.dispose();
    }
}, 60_000);
