import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("failed collaborator reporting", () => {
    it("returns a hard provider failure to the parent after the collaborator stops", async () => {
        let rootProviderSessionId: string | undefined;
        let rootCalls = 0;
        let childAgentId = "";
        const rootContexts: unknown[] = [];
        const gym = await createGym({
            inference: (request) => {
                rootProviderSessionId ??= request.options.sessionId;
                if (request.options.sessionId === rootProviderSessionId) {
                    rootContexts.push(request.context);
                    rootCalls += 1;
                    if (rootCalls === 1) {
                        return {
                            content: [
                                {
                                    arguments: {
                                        effort: "off",
                                        model: "openai/gym",
                                        text: "Try the delegated work.",
                                        title: "Failing collaborator",
                                    },
                                    callId: "failingchild",
                                    name: "create_agent",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    if (
                        !JSON.stringify(request.context).includes(
                            "The delegated provider failed hard.",
                        )
                    ) {
                        return {
                            content: [
                                {
                                    text: "The collaborator is running independently.",
                                    type: "text",
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                text: "The parent received the collaborator failure.",
                                type: "text",
                            },
                        ],
                    };
                }
                childAgentId = request.options.sessionId ?? "";
                return { body: "The delegated provider failed hard.", httpStatus: 500 };
            },
        });
        running.add(gym);

        gym.terminal.type("Delegate this work.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("The parent received the collaborator failure.", 30_000);
        expect(childAgentId).not.toBe("");
        expect(JSON.stringify(rootContexts.at(-1))).toContain(
            "The delegated provider failed hard.",
        );
    }, 45_000);
});
