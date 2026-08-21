import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("rapid double Escape while inference is running", () => {
    it("clears the draft and continues pending steering once", async () => {
        const pendingMessage = "Apply this direction before continuing.";
        const draft = "Keep this unsent draft during continuation.";
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: "UNREACHABLE_INITIAL_RESPONSE", type: "text" }],
                        delayMs: 60_000,
                    };
                }

                expect(callIndex).toBe(1);
                const userTexts = request.context.messages.flatMap((message) =>
                    message.role === "user" ? [messageText(message.content)] : [],
                );
                expect(userTexts.filter((text) => text === pendingMessage)).toHaveLength(1);
                return {
                    content: [{ text: "UNREACHABLE_CONTINUED_RESPONSE", type: "text" }],
                    delayMs: 60_000,
                };
            },
            rows: 38,
        });
        running.add(gym);

        submit(gym, "Start inference and wait for steering.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        submit(gym, pendingMessage);
        await gym.terminal.waitForText("Messages to be submitted after next tool call", 30_000);
        gym.terminal.type(draft);
        await waitForComposer(gym, draft);

        gym.terminal.write("\x1b\x1b");

        const continued = await gym.terminal.waitUntil(
            (snapshot) =>
                agentRequests(gym).length === 2 &&
                snapshot.text.includes("esc to interrupt") &&
                !snapshot.text.includes("Messages to be submitted after next tool call") &&
                composerText(snapshot) === "Ask Happy Terminal to do anything",
            "the first Escape to clear the draft and the second to continue pending steering",
            30_000,
        );
        expect(continued.text).not.toContain("Session interrupted");
        await screenshot(gym, "rapid-double-escape-pending-continued.png");

        gym.terminal.press("escape");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                !snapshot.text.includes("esc to interrupt") &&
                composerText(snapshot) === "Ask Happy Terminal to do anything",
            "a later Escape without pending steering to stop",
            30_000,
        );
        expect(agentRequests(gym)).toHaveLength(2);
    }, 120_000);

    it("clears the draft before stopping without pending steering", async () => {
        const draft = "Keep this draft when both Escapes interrupt.";
        const gym = await createGym({
            inference: [
                {
                    content: [{ text: "UNREACHABLE_DELAYED_RESPONSE", type: "text" }],
                    delayMs: 60_000,
                },
            ],
            rows: 34,
        });
        running.add(gym);

        submit(gym, "Start inference with no pending steering.");
        await gym.terminal.waitForText("esc to interrupt", 30_000);
        gym.terminal.type(draft);
        await waitForComposer(gym, draft);

        gym.terminal.press("escape");
        gym.terminal.press("escape");

        const stopped = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                !snapshot.text.includes("esc to interrupt") &&
                composerText(snapshot) === "Ask Happy Terminal to do anything",
            "the first Escape to clear the draft and the second to stop",
            30_000,
        );
        expect(stopped.text).not.toContain("Messages to be submitted after next tool call");
        expect(agentRequests(gym)).toHaveLength(1);
        await screenshot(gym, "rapid-double-escape-no-pending-stopped.png");
    }, 90_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function agentRequests(gym: Gym) {
    return gym.inference.requests.filter(
        (request) => !request.options.sessionId?.endsWith(":title"),
    );
}

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (block): block is { text: string } =>
                typeof block === "object" &&
                block !== null &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
}

async function waitForComposer(gym: Gym, text: string) {
    return gym.terminal.waitUntil(
        (snapshot) => composerText(snapshot) === text,
        `composer text ${JSON.stringify(text)}`,
        30_000,
    );
}

function composerText(snapshot: { rows: readonly string[] }): string | undefined {
    const footer = snapshot.rows.findIndex((row) => row.includes("gym off · /workspace"));
    const row = footer >= 2 ? snapshot.rows[footer - 2] : undefined;
    return row?.replace(/^\s*›\s?/u, "").trimEnd();
}

async function screenshot(gym: Gym, name: string): Promise<void> {
    const directory = process.env.HAPPY_TERMINAL_GYM_SCREENSHOT_DIR;
    if (directory === undefined) return;
    await gym.terminal.screenshot(resolve(directory, name));
}
