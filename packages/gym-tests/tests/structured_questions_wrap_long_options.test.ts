import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const COLS = 72;
const ROWS = 28;
const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("structured questions wrap long options", () => {
    it("shows every word of long labels and descriptions instead of cutting them off", async () => {
        const gym = await createGym({
            cols: COLS,
            inference: [
                {
                    content: [
                        {
                            arguments: {
                                questions: [
                                    {
                                        header: "Skew policy",
                                        id: "skew",
                                        options: [
                                            {
                                                description:
                                                    "Keep instant renderer deploys and ship a runtime capability check.",
                                                label: "Detect and gate (keep live renderer deploys)",
                                            },
                                            {
                                                description:
                                                    "Pages serves versioned bundles and the shell pins one.",
                                                label: "Eliminate skew (pin renderer to shell release)",
                                            },
                                        ],
                                        question: "How should the version gap be handled?",
                                    },
                                ],
                            },
                            id: "wrap-question",
                            name: "request_user_input",
                            type: "toolCall",
                        },
                    ],
                },
                { content: [{ text: "Recorded the skew policy.", type: "text" }] },
            ],
            rows: ROWS,
        });
        running.add(gym);

        gym.terminal.type("Decide the skew policy.");
        gym.terminal.press("enter");

        const question = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("How should the version gap be handled?") &&
                snapshot.text.includes("Eliminate skew"),
            "the structured question with long options",
            30_000,
        );

        // Every word of both the label and the description survives, wrapped
        // across lines rather than truncated at a fixed column.
        expect(question.text).toContain("deploys)");
        expect(question.text).toContain("shell release)");
        expect(question.text).toContain("check.");
        expect(question.text).toContain("and the shell pins one.");
        expect(question.text).not.toContain("…");
        expect(question.rows).toHaveLength(ROWS);
        expect(question.scroll.atBottom).toBe(true);

        gym.terminal.press("down");
        gym.terminal.press("enter");

        await gym.terminal.waitUntil(
            (snapshot) => snapshot.text.includes("Recorded the skew policy."),
            "the recorded answer",
            30_000,
        );

        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(requests[1]?.context.messages.at(-1)?.content).toEqual([
            {
                text: '{"answers":{"skew":{"answers":["Eliminate skew (pin renderer to shell release)"]}}}',
                type: "text",
            },
        ]);
    });
});
