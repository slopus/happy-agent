import { afterEach, describe, expect, it, vi } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("context notes in the terminal", () => {
    it("does not infer while idle and survives reload before the next action", async () => {
        const gym = await createGym({
            inference(request) {
                const messages = request.context.messages;
                expect(messages.at(-2)).toMatchObject({
                    contextOnly: true,
                    role: "user",
                });
                expect(JSON.stringify(messages.at(-2))).toContain(
                    "Background context only. This is not a request.",
                );
                expect(JSON.stringify(messages.at(-2))).toContain("Use the blue database.");
                expect(JSON.stringify(messages.at(-1))).toContain("Check the migration now.");
                return { content: [{ text: "CONTEXT_AFTER_RELOAD_OK", type: "text" }] };
            },
        });
        running.add(gym);

        const baseline = await gym.terminal.snapshot();
        submit(gym, "/context Use the blue database.");
        const noted = await gym.terminal.waitForText("Use the blue database.");
        expect(noted.text).toContain("context · Use the blue database.");
        expect(noted.text).not.toContain("Working for");
        expect(noted.scroll.bottomDepartureCount).toBe(baseline.scroll.bottomDepartureCount);
        await vi.waitFor(() => {
            expect(agentRequests(gym)).toHaveLength(0);
        });

        const beforeReload = noted.outputRevision;
        submit(gym, "/reload");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.outputRevision > beforeReload &&
                snapshot.text.includes("Use the blue database."),
            "the durable context note after reload",
            30_000,
        );
        expect(agentRequests(gym)).toHaveLength(0);

        submit(gym, "Check the migration now.");
        await gym.terminal.waitForText("CONTEXT_AFTER_RELOAD_OK", 30_000);
        expect(agentRequests(gym)).toHaveLength(1);
    }, 60_000);

    it("does not steer an active run and reaches the following action in order", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: "FIRST_RUN_FINISHED", type: "text" }],
                        delayMs: 1_000,
                    };
                }
                const serialized = JSON.stringify(request.context.messages);
                expect(serialized).toContain("Context added during the first run.");
                expect(serialized).toContain("Run the follow-up.");
                expect(serialized.indexOf("Context added during the first run.")).toBeLessThan(
                    serialized.indexOf("Run the follow-up."),
                );
                return { content: [{ text: "FOLLOW_UP_CONTEXT_OK", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Start the first run.");
        await vi.waitFor(() => expect(agentRequests(gym)).toHaveLength(1));
        submit(gym, "/context Context added during the first run.");
        const during = await gym.terminal.waitForText("Context added during the first run.");
        expect(during.text).toContain("context · Context added during the first run.");
        await gym.terminal.waitForText("FIRST_RUN_FINISHED", 30_000);
        expect(agentRequests(gym)).toHaveLength(1);

        submit(gym, "Run the follow-up.");
        const finished = await gym.terminal.waitForText("FOLLOW_UP_CONTEXT_OK", 30_000);
        expect(finished.text).toContain("FIRST_RUN_FINISHED");
        expect(agentRequests(gym)).toHaveLength(2);
    }, 60_000);

    it("places pending context immediately before an actionable steer", async () => {
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: "STALE_UNSTEERED_REPLY", type: "text" }],
                        delayMs: 5_000,
                    };
                }
                const serialized = JSON.stringify(request.context.messages);
                expect(serialized).toContain("Steering background context.");
                expect(serialized).toContain("Apply the steering now.");
                expect(serialized.indexOf("Steering background context.")).toBeLessThan(
                    serialized.indexOf("Apply the steering now."),
                );
                return { content: [{ text: "CONTEXT_BEFORE_STEER_OK", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Begin a steerable response.");
        await vi.waitFor(() => expect(agentRequests(gym)).toHaveLength(1));
        submit(gym, "/context Steering background context.");
        await gym.terminal.waitForText("Steering background context.");
        submit(gym, "Apply the steering now.");

        await gym.terminal.waitForText("CONTEXT_BEFORE_STEER_OK", 30_000);
        expect(agentRequests(gym)).toHaveLength(2);
    }, 60_000);

    it("keeps unapplied context pending after a hard abort", async () => {
        const note = "Context that must survive the abort.";
        const gym = await createGym({
            inference(request, callIndex) {
                if (callIndex === 0) {
                    return {
                        content: [{ text: "ABORTED_RESPONSE_MUST_NOT_WIN", type: "text" }],
                        delayMs: 60_000,
                    };
                }
                const userMessages = request.context.messages.filter(
                    (message) => message.role === "user",
                );
                const serialized = userMessages.map((message) => JSON.stringify(message));
                expect(serialized.filter((message) => message.includes(note))).toHaveLength(1);
                expect(serialized.at(-1)).toContain("Use the retained context now.");
                return { content: [{ text: "CONTEXT_SURVIVED_ABORT", type: "text" }] };
            },
        });
        running.add(gym);

        submit(gym, "Begin work that will be aborted.");
        await vi.waitFor(() => expect(agentRequests(gym)).toHaveLength(1));
        submit(gym, `/context ${note}`);
        await gym.terminal.waitForText(note);
        submit(gym, "Steer before the abort.");
        await gym.terminal.waitForText("Steer before the abort.");
        submit(gym, "/abort");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the hard abort to settle without applying context",
            30_000,
        );

        submit(gym, "Use the retained context now.");
        await gym.terminal.waitForText("CONTEXT_SURVIVED_ABORT", 30_000);
        expect(agentRequests(gym)).toHaveLength(2);
    }, 60_000);
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
