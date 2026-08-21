import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("TUI reload after daemon failure", () => {
    it("starts a replacement daemon and resumes the same session", async () => {
        const gym = await createGym({
            environment: { HAPPY_TERMINAL_GYM_IN_PROCESS_DAEMON: "0" },
            inference(request, callIndex) {
                const context = JSON.stringify(request.context.messages);
                if (callIndex === 0) {
                    expect(context).toContain("Complete a turn before the daemon crashes.");
                    return { content: [{ text: "BEFORE_DAEMON_CRASH", type: "text" }] };
                }
                expect(callIndex).toBe(1);
                expect(context).toContain("BEFORE_DAEMON_CRASH");
                expect(context).toContain("Continue after reconnecting this TUI.");
                return { content: [{ text: "AFTER_TUI_RELOAD", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Complete a turn before the daemon crashes.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("BEFORE_DAEMON_CRASH") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the initial turn to finish",
            30_000,
        );
        const originalPid = await stopDaemon(gym);

        submit(gym, "/reload");
        const reloaded = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Resumed") &&
                snapshot.text.includes("BEFORE_DAEMON_CRASH") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the TUI to reload the persisted session",
            30_000,
        );
        expect(reloaded.text).not.toContain("connect ENOENT");
        expect(await readDaemonPid(gym)).not.toBe(originalPid);

        submit(gym, "Continue after reconnecting this TUI.");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("AFTER_TUI_RELOAD") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the reloaded TUI to complete another turn",
            30_000,
        );
        expect(completed.text).not.toContain("connect ENOENT");
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function stopDaemon(gym: Gym): Promise<number> {
    const result = await gym.runInContainer("node", [
        "--input-type=module",
        "--eval",
        `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const lockPath = join(process.env.HOME, ".happy", "agent", "agent.lock");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
process.kill(lock.pid, "SIGKILL");
for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
        process.kill(lock.pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
        break;
    }
}
console.log(lock.pid);
`,
    ]);
    return Number(result.stdout.trim());
}

async function readDaemonPid(gym: Gym): Promise<number> {
    const result = await gym.runInContainer("node", [
        "--input-type=module",
        "--eval",
        `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const lockPath = join(process.env.HOME, ".happy", "agent", "agent.lock");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
console.log(lock.pid);
`,
    ]);
    return Number(result.stdout.trim());
}
