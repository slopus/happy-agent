import { afterEach, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const RELOAD_LOG = "$HOME/.happy/agent/reload.log";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

it("replaces its own daemon with a detached reload and keeps the session", async () => {
    const gym = await createGym({
        mode: "docker",
        environment: { HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON: "0" },
        inference(request, callIndex) {
            const context = JSON.stringify(request.context.messages);
            if (callIndex === 0) {
                return {
                    content: [
                        {
                            type: "toolCall",
                            id: "detached-reload",
                            name: "exec_command",
                            arguments: {
                                cmd: "node /app/happy-agent/dist/cli.js reload --detach",
                                yield_time_ms: 10_000,
                            },
                        },
                    ],
                };
            }
            if (callIndex === 1) {
                expect(context).toContain("Happy Agent will reload once this command exits.");
                return { content: [{ type: "text", text: "RELOAD_SCHEDULED" }] };
            }
            expect(callIndex).toBe(2);
            expect(context).toContain("Continue on the replacement daemon.");
            return { content: [{ type: "text", text: "REPLACEMENT_SESSION_USABLE" }] };
        },
    });
    running.add(gym);
    const originalPid = await readDaemonPid(gym);

    submit(gym, "Reload your own daemon.");
    // The worker logs this line only after the replacement daemon reports ready.
    let log = "";
    for (let attempt = 0; attempt < 600 && !log.includes("Daemon is running at"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        log = (await gym.runInContainer("bash", ["-c", `cat "${RELOAD_LOG}" 2>/dev/null || true`]))
            .stdout;
    }
    expect(log).toContain("Daemon is running at");
    expect(await readDaemonPid(gym)).not.toBe(originalPid);

    submit(gym, "/reload");
    await gym.terminal.waitUntil(
        (snapshot) =>
            snapshot.text.includes("RELOAD_SCHEDULED") &&
            snapshot.text.includes("Ask Happy Terminal to do anything"),
        "the reconnected TUI to show the scheduled reload",
        30_000,
    );
    submit(gym, "Continue on the replacement daemon.");
    await gym.terminal.waitForText("REPLACEMENT_SESSION_USABLE", 30_000);
}, 120_000);

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function readDaemonPid(gym: Gym): Promise<number> {
    const result = await gym.runInContainer("bash", ["-c", 'cat "$HOME/.happy/agent/daemon.pid"']);
    const pid = Number(result.stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The daemon PID is unavailable.");
    return pid;
}
