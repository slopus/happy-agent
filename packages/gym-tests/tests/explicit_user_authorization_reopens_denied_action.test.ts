import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
const approval =
    "I understand this overwrites approved.txt. I explicitly authorize that exact write; submit it for a fresh review.";

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("explicit user authorization after a denial", () => {
    it.each(["allow", "deny"] as const)(
        "submits the same action to a fresh review and honors a second %s",
        async (secondOutcome) => {
            let mainCalls = 0;
            let reviews = 0;
            const gym = await createGym({
                mode: "docker",
                permissionMode: "auto",
                files: { "approved.txt": "original\n" },
                inference(request) {
                    if (isReviewRequest(request)) {
                        reviews += 1;
                        const outcome = reviews === 1 ? "deny" : secondOutcome;
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: [
                                        "<review>",
                                        "<risk_level>high</risk_level>",
                                        `<user_authorization>${reviews === 1 ? "low" : "high"}</user_authorization>`,
                                        `<outcome>${outcome}</outcome>`,
                                        "<rationale>This overwrites approved.txt; explicit authorization is required and policy still applies.</rationale>",
                                        "</review>",
                                    ].join("\n"),
                                },
                            ],
                        };
                    }
                    mainCalls += 1;
                    if (mainCalls === 1 || mainCalls === 3) {
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    callId: `write-${mainCalls}`,
                                    name: "exec_command",
                                    arguments: {
                                        cmd: "printf 'approved\\n' > approved.txt",
                                        sandbox_permissions: "require_escalated",
                                        justification:
                                            "Write the exact file requested by the user.",
                                    },
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text:
                                    mainCalls === 2
                                        ? "WRITE_REFUSED: This overwrites approved.txt. I have stopped."
                                        : "FRESH_REVIEW_FINISHED",
                            },
                        ],
                    };
                },
            });
            running.add(gym);

            submit(gym, "Prepare the file.");
            await gym.terminal.waitForText("WRITE_REFUSED", 30_000);
            await expect(gym.readFile("approved.txt")).resolves.toBe("original\n");
            expect(reviews).toBe(1);

            const requests = gym.inference.requests.filter(
                (request) =>
                    !isReviewRequest(request) && !request.options.sessionId?.endsWith(":title"),
            );
            const refusalContext = JSON.stringify(requests.at(-1)?.context);
            expect(refusalContext).toContain(
                "submit the exact action once for a fresh Auto review",
            );
            expect(refusalContext).toContain("Do not bypass review");
            expect(refusalContext).not.toContain("a reviewer's explicit denial is final");

            submit(gym, approval);
            await gym.terminal.waitForText("FRESH_REVIEW_FINISHED", 30_000);

            expect(reviews).toBe(2);
            const secondReview = gym.inference.requests.filter(isReviewRequest)[1];
            expect(JSON.stringify(secondReview?.context)).toContain(approval);
            await expect(gym.readFile("approved.txt")).resolves.toBe(
                secondOutcome === "allow" ? "approved\n" : "original\n",
            );
        },
        60_000,
    );
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
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
