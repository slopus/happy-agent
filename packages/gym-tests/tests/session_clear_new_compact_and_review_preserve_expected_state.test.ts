import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const COLS = 76;
const ROWS = 24;
const REVIEW_COMMAND = "/review focus on unsafe file writes";
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("session clear, new, compact, and review preserve expected state", () => {
    it("separates visible transcript state from model context and keeps review read only", async () => {
        const gym = await createGym({
            cols: COLS,
            files: {
                "tracked.txt": "original fixture content\n",
            },
            inference(request, callIndex) {
                const context = JSON.stringify(request.context.messages);
                const lastMessage = JSON.stringify(request.context.messages.at(-1));
                const providerSessionGeneration = request.providerSessionGeneration;

                if (callIndex === 0) {
                    expect(providerSessionGeneration).toBe(0);
                    expect(lastMessage).toContain("FIRST_CONTEXT_SENTINEL");
                    return {
                        content: [{ text: "FIRST_RESPONSE_SENTINEL", type: "text" }],
                        usage: {
                            cacheRead: 10,
                            cacheWrite: 5,
                            cost: {
                                cacheRead: 0,
                                cacheWrite: 0,
                                input: 0,
                                output: 0,
                                total: 0,
                            },
                            input: 120,
                            output: 30,
                            totalTokens: 165,
                        },
                    };
                }

                if (callIndex === 1) {
                    expect(providerSessionGeneration).toBe(0);
                    expect(lastMessage).toContain("SECOND_CONTEXT_CHECK");
                    expect(context).toContain("FIRST_CONTEXT_SENTINEL");
                    expect(context).toContain("FIRST_RESPONSE_SENTINEL");
                    return {
                        content: [{ text: "CLEAR_CONTEXT_PRESERVED", type: "text" }],
                        usage: {
                            cacheRead: 5,
                            cacheWrite: 0,
                            cost: {
                                cacheRead: 0,
                                cacheWrite: 0,
                                input: 0,
                                output: 0,
                                total: 0,
                            },
                            input: 80,
                            output: 20,
                            totalTokens: 105,
                        },
                    };
                }

                if (callIndex === 2) {
                    expect(providerSessionGeneration).toBe(1);
                    expect(lastMessage).toContain("POST_NEW_CONTEXT_CHECK");
                    expect(context).not.toContain("FIRST_CONTEXT_SENTINEL");
                    expect(context).not.toContain("FIRST_RESPONSE_SENTINEL");
                    expect(context).not.toContain("SECOND_CONTEXT_CHECK");
                    expect(context).not.toContain("CLEAR_CONTEXT_PRESERVED");
                    return {
                        content: [{ text: "NEW_CONTEXT_IS_CLEAN", type: "text" }],
                    };
                }

                if (callIndex === 3) {
                    expect(providerSessionGeneration).toBe(1);
                    expect(lastMessage).toContain(
                        "Review the current workspace changes and identify actionable issues.",
                    );
                    expect(lastMessage).toContain("Do not modify files or implement fixes.");
                    expect(lastMessage).toContain(
                        "The user asked you to focus especially on: focus on unsafe file writes",
                    );
                    expect(lastMessage).not.toContain(REVIEW_COMMAND);
                    expect(context).not.toContain("FIRST_CONTEXT_SENTINEL");
                    return {
                        content: [{ text: "REVIEW_COMPLETED_WITHOUT_CHANGES", type: "text" }],
                        delayMs: 300,
                    };
                }

                throw new Error(`Unexpected agent inference call ${String(callIndex)}.`);
            },
            rows: ROWS,
        });
        running.add(gym);
        const baseline = (await gym.terminal.snapshot()).scroll;

        submit(gym, "FIRST_CONTEXT_SENTINEL");
        const firstTurn = await gym.terminal.waitForText("FIRST_RESPONSE_SENTINEL", 30_000);
        assertHealthyTerminal(firstTurn, baseline);

        submit(gym, "/clear");
        const clearedTranscript = await gym.terminal.waitForText("Transcript cleared.", 30_000);
        assertHealthyTerminal(clearedTranscript, baseline);
        expect(clearedTranscript.text).not.toContain("FIRST_CONTEXT_SENTINEL");
        expect(clearedTranscript.text).not.toContain("FIRST_RESPONSE_SENTINEL");

        submit(gym, "SECOND_CONTEXT_CHECK");
        const contextPreserved = await gym.terminal.waitForText("CLEAR_CONTEXT_PRESERVED", 30_000);
        assertHealthyTerminal(contextPreserved, baseline);

        submit(gym, "/usage");
        const accumulatedUsage = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Input: 200") &&
                snapshot.text.includes("Output: 50") &&
                snapshot.text.includes("Cache read: 15") &&
                snapshot.text.includes("Cache write: 5") &&
                snapshot.text.includes("5-hour: unavailable") &&
                snapshot.text.includes("Session work: 235 used"),
            "the accumulated provider usage",
            30_000,
        );
        assertHealthyTerminal(accumulatedUsage, baseline);

        submit(gym, "/new");
        const reset = await gym.terminal.waitForText(
            "Session reset. Started a new session.",
            30_000,
        );
        assertHealthyTerminal(reset, baseline);
        expect(reset.text).not.toContain("SECOND_CONTEXT_CHECK");
        expect(reset.text).not.toContain("CLEAR_CONTEXT_PRESERVED");

        submit(gym, "/usage");
        const resetUsage = await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("Session work: 0 used"),
            "usage reset for the new session",
            30_000,
        );
        assertHealthyTerminal(resetUsage, baseline);
        expect(resetUsage.text).not.toContain("Context: unavailable");

        submit(gym, "/compact");
        const compact = await gym.terminal.waitForText(
            "There is not enough conversation history to compact yet.",
            30_000,
        );
        assertHealthyTerminal(compact, baseline);

        submit(gym, "POST_NEW_CONTEXT_CHECK");
        const continued = await gym.terminal.waitForText("NEW_CONTEXT_IS_CLEAN", 30_000);
        assertHealthyTerminal(continued, baseline);

        submit(gym, REVIEW_COMMAND);
        const visibleReviewCommand = await gym.terminal.waitForText(REVIEW_COMMAND, 30_000);
        assertHealthyTerminal(visibleReviewCommand, baseline);

        const review = await gym.terminal.waitForText("REVIEW_COMPLETED_WITHOUT_CHANGES", 30_000);
        assertHealthyTerminal(review, baseline);
        expect(review.text).toContain(REVIEW_COMMAND);
        expect(agentRequests(gym)).toHaveLength(4);
        await expect(gym.readFile("tracked.txt")).resolves.toBe("original fixture content\n");
    }, 120_000);
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

function assertHealthyTerminal(
    snapshot: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>,
    baseline: Awaited<ReturnType<Gym["terminal"]["snapshot"]>>["scroll"],
): void {
    expect(snapshot.rows).toHaveLength(ROWS);
    expect(snapshot.scroll.visibleRows).toBe(ROWS);
    expect(snapshot.scroll.atBottom).toBe(true);
    expect(snapshot.scroll.bottomDepartureCount).toBe(baseline.bottomDepartureCount);
    expect(snapshot.scroll.topArrivalCount).toBe(baseline.topArrivalCount);
    expect(snapshot.cursor.x).toBeLessThan(COLS);
    expect(snapshot.cursor.y).toBeLessThan(ROWS);
    expect(snapshot.text).toContain("gym off");
    expect(snapshot.text).toContain("/workspace");
    expect(snapshot.text).not.toContain("�");
}
