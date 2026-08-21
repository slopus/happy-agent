import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("bang-prefixed shell commands", () => {
    it("highlights shell mode and runs the command without model inference", async () => {
        const gym = await createGym({});
        running.add(gym);

        gym.terminal.type("  !");

        const emptyShellMode = await gym.terminal.waitForText("Shell mode");
        expect(emptyShellMode.rows.some((row) => row.trimStart().startsWith("! "))).toBe(true);

        gym.terminal.press("backspace");

        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                !snapshot.text.includes("Shell mode"),
            "backspace at the empty shell prompt to return to the normal composer",
        );

        gym.terminal.type("!echo direct-output > result.txt && cat result.txt");

        const shellMode = await gym.terminal.waitForText("Shell mode");
        expect(
            shellMode.rows.some((row) =>
                row.trimStart().startsWith("! echo direct-output > result.txt && cat result.txt"),
            ),
        ).toBe(true);
        expect(shellMode.text).not.toContain("!echo direct-output > result.txt && cat result.txt");

        gym.terminal.press("enter");

        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Ran echo direct-output > result.txt && cat result.txt") &&
                snapshot.text.includes("direct-output") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the direct shell command to finish and return to the idle composer",
            30_000,
        );

        expect(completed.text).toContain("Ran echo direct-output > result.txt && cat result.txt");
        await expect(gym.readFile("result.txt")).resolves.toBe("direct-output\n");
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(0);
    });

    it("queues the shell command until an active agent response finishes", async () => {
        const gym = await createGym({
            inference: [
                {
                    content: [{ text: "Agent finished.", type: "text" }],
                    delayMs: 1_000,
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Keep working briefly.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Working");

        gym.terminal.type("!echo queued-output > queued.txt && cat queued.txt");
        gym.terminal.press("enter");

        const queued = await gym.terminal.waitForText("queued-output > queued.txt");
        expect(queued.text).toContain("queued");
        await expect(gym.readFile("queued.txt")).rejects.toThrow();

        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Agent finished.") &&
                snapshot.text.includes("Ran echo queued-output > queued.txt && cat queued.txt") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the queued direct shell command to run after the agent response",
            30_000,
        );

        expect(completed.text).toContain("queued-output");
        await expect(gym.readFile("queued.txt")).resolves.toBe("queued-output\n");
    });

    it("adds the completed command to the next model turn without querying immediately", async () => {
        const gym = await createGym({
            inference(request) {
                const context = JSON.stringify(request.context.messages);
                expect(context).toContain("<user_shell_command>");
                expect(context).toContain("echo context-output");
                expect(context).toContain("context-output");
                expect(context).toContain("What did the shell command do?");
                return {
                    content: [{ text: "The shell command printed context-output.", type: "text" }],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("!echo context-output");
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Ran echo context-output") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the direct shell command to finish",
            30_000,
        );
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(0);

        gym.terminal.type("What did the shell command do?");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("The shell command printed context-output.", 30_000);
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(1);
    });

    it("backgrounds a long command and opens a scrollable full-screen log viewer", async () => {
        const gym = await createGym({
            cols: 84,
            inference(request) {
                const context = JSON.stringify(request.context.messages);
                expect(context).toContain("<user_shell_command>");
                expect(context).toContain("BANG_LOG_080");
                return {
                    content: [
                        {
                            text: "The stopped background command is present in message history.",
                            type: "text",
                        },
                    ],
                };
            },
            mode: "docker",
            rows: 24,
        });
        running.add(gym);

        gym.terminal.type(
            "!for i in $(seq 1 80); do printf 'BANG_LOG_%03d\\n' \"$i\"; done; sleep 60",
        );
        gym.terminal.press("enter");

        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Running for i in") &&
                snapshot.text.includes("Ctrl+B to background"),
            "the foreground shell command to offer backgrounding",
            30_000,
        );
        gym.terminal.write("\x02");

        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("1 background terminal running · /ps to view") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the shell command to move to the background",
            30_000,
        );
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(0);

        gym.terminal.type("/ps");
        gym.terminal.press("enter");

        const viewer = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Background terminal") &&
                snapshot.text.includes("Running") &&
                snapshot.text.includes("BANG_LOG_080") &&
                snapshot.text.includes("PgUp/PgDn scroll") &&
                !snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the full-screen background terminal viewer",
            30_000,
        );
        expect(viewer.rows).toHaveLength(24);
        expect(viewer.text).not.toContain("BANG_LOG_001");

        gym.terminal.write("\x1b[5~");
        const scrolled = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("BANG_LOG_050"),
            "the background terminal logs to scroll upward",
            30_000,
        );
        expect(scrolled.text).not.toContain("BANG_LOG_080");

        gym.terminal.type("x");
        await gym.terminal.waitForText("Stopped", 30_000);
        gym.terminal.press("escape");

        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                !snapshot.text.includes("background terminal running"),
            "the composer to return after stopping the background terminal",
            30_000,
        );

        gym.terminal.type("Is the background command in history?");
        gym.terminal.press("enter");
        await gym.terminal.waitForText(
            "The stopped background command is present in message history.",
            30_000,
        );
        expect(
            gym.inference.requests.filter(
                (request) => !request.options.sessionId?.endsWith(":title"),
            ),
        ).toHaveLength(1);
    }, 90_000);
});
