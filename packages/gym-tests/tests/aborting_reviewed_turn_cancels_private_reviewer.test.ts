import { afterEach, describe, expect, it, vi } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("aborting a turn under automatic permission review", () => {
    it("cancels the private reviewer so the next reviewed turn can start immediately", async () => {
        let mainCallCount = 0;
        let reviewCount = 0;
        const gym = await createGym({
            inference(request) {
                if (isReviewRequest(request)) {
                    reviewCount += 1;
                    return {
                        content: [{ text: allowedReview(), type: "text" }],
                        ...(reviewCount === 1 ? { delayMs: 60_000 } : {}),
                    };
                }

                mainCallCount += 1;
                if (mainCallCount === 3) {
                    return {
                        content: [{ text: "SECOND_REVIEW_COMPLETED", type: "text" }],
                    };
                }
                const second = mainCallCount === 2;
                return {
                    content: [
                        {
                            arguments: {
                                cmd: second ? "printf second-review" : "printf first-review",
                                justification: "Exercise automatic permission review.",
                                sandbox_permissions: "require_escalated",
                            },
                            callId: second ? "second-reviewed-call" : "first-reviewed-call",
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                };
            },
            permissionMode: "auto",
        });
        running.add(gym);

        submit(gym, "FIRST_REVIEW: start an action that I will abort.");
        await vi.waitFor(() => expect(reviewRequests(gym)).toHaveLength(1), { timeout: 15_000 });

        submit(gym, "/abort");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("Session interrupted") &&
                snapshot.text.includes("Ask Happy Terminal to do anything"),
            "the reviewed turn to be aborted",
            30_000,
        );

        submit(gym, "SECOND_REVIEW: run the next reviewed action.");
        const completed = await gym.terminal.waitForText("SECOND_REVIEW_COMPLETED", 30_000);

        expect(completed.text).toContain("second-review");
        expect(reviewRequests(gym)).toHaveLength(2);
    }, 60_000);
});

function allowedReview(): string {
    return [
        "<review>",
        "<risk_level>low</risk_level>",
        "<user_authorization>high</user_authorization>",
        "<outcome>allow</outcome>",
        "<rationale>The user explicitly requested this harmless test command.</rationale>",
        "</review>",
    ].join("\n");
}

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function reviewRequests(gym: Gym) {
    return gym.inference.requests.filter(isReviewRequest);
}

function isReviewRequest(request: {
    readonly context: { readonly systemPrompt?: string };
}): boolean {
    return (
        request.context.systemPrompt?.includes(
            "You are judging one planned coding-agent action.",
        ) === true
    );
}
