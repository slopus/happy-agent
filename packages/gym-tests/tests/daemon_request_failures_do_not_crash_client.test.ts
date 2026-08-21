import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("daemon request failures do not crash the client", () => {
    it("keeps the reasoning menu usable when an effort update cannot reach the daemon", async () => {
        const gym = await createGym({ mode: "docker", inference: [] });
        running.add(gym);
        await disconnectDaemonSocket(gym);

        gym.terminal.type("/effort");
        gym.terminal.press("enter");
        await waitForLiveTerminal(gym, gym.terminal.waitForText("Choose Reasoning"));
        gym.terminal.press("down");
        gym.terminal.press("enter");
        await waitForLiveTerminal(
            gym,
            gym.terminal.waitUntil(
                (snapshot) =>
                    !snapshot.text.includes("Choose Reasoning") &&
                    snapshot.text.includes("gym low · /workspace"),
                "the optimistic effort selection",
            ),
        );

        gym.terminal.type("/effort");
        gym.terminal.press("enter");
        const reopened = await waitForLiveTerminal(
            gym,
            gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("Choose Reasoning") && snapshot.text.includes("→ Low"),
                "the reasoning menu after the failed daemon request",
            ),
        );
        expect(reopened.text).toContain("Current level.");
    }, 60_000);

    it("finishes the active run when its abort request cannot reach the daemon", async () => {
        const gym = await createGym({
            mode: "docker",
            inference: [
                {
                    content: [{ text: "THE_CLIENT_SURVIVED_THE_FAILED_ABORT", type: "text" }],
                    delayMs: 3_000,
                },
            ],
        });
        running.add(gym);

        submit(gym, "Start a response while I disconnect the daemon socket.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        await disconnectDaemonSocket(gym);
        gym.terminal.press("escape");

        const completed = await waitForLiveTerminal(
            gym,
            gym.terminal.waitUntil(
                (snapshot) =>
                    snapshot.text.includes("THE_CLIENT_SURVIVED_THE_FAILED_ABORT") &&
                    snapshot.text.includes("Ask Happy Terminal to do anything"),
                "the active run to finish after its abort request failed",
                30_000,
            ),
        );
        expect(completed.text).not.toContain("UnhandledPromiseRejection");
    }, 60_000);
});

async function disconnectDaemonSocket(gym: Gym): Promise<void> {
    await gym.runInContainer("node", [
        "-e",
        'require("node:fs").unlinkSync("/tmp/rig-" + process.getuid() + "/server.sock")',
    ]);
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function waitForLiveTerminal<T>(gym: Gym, observation: Promise<T>): Promise<T> {
    return Promise.race([
        observation,
        gym.exit().then(({ exitCode, signal }) => {
            throw new Error(
                `Happy Terminal exited while handling a failed daemon request (code ${exitCode}, signal ${String(signal)}).`,
            );
        }),
    ]);
}
