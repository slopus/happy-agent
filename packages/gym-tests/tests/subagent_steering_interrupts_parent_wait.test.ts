import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("subagent steering during a parent wait", () => {
    it("interrupts the parent's active wait and continues with the child message", async () => {
        let parentAgentId = "";
        let rootProviderSessionId: string | undefined;
        let rootCalls = 0;
        let childCalls = 0;
        let releaseChild = (): void => undefined;
        const childMayReply = new Promise<void>((resolve) => {
            releaseChild = resolve;
        });
        const gym = await createGym({
            inference: async (request) => {
                rootProviderSessionId ??= request.options.sessionId;
                if (request.options.sessionId === rootProviderSessionId) {
                    parentAgentId = request.options.sessionId ?? "";
                    rootCalls += 1;
                    if (rootCalls === 1) {
                        return {
                            content: [
                                {
                                    arguments: {
                                        effort: "off",
                                        model: "openai/gym",
                                        text: "Wait until you are allowed to send me the steering message.",
                                        title: "Delayed steering collaborator",
                                    },
                                    callId: "waitingparentchild",
                                    name: "create_agent",
                                    type: "tool_call",
                                },
                                {
                                    arguments: { duration: "10 minutes" },
                                    callId: "parentlongwait",
                                    name: "wait",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }

                    expect(JSON.stringify(request.context)).toContain("CHILD_STEERING_WAKE");
                    return {
                        content: [{ text: "PARENT_RESUMED_AFTER_CHILD_STEERING", type: "text" }],
                    };
                }

                childCalls += 1;
                if (childCalls === 1) {
                    await childMayReply;
                    return {
                        content: [
                            {
                                arguments: {
                                    toAgentId: parentAgentId,
                                    text: "CHILD_STEERING_WAKE",
                                },
                                callId: "childsteerswaitingparent",
                                name: "send_agent_message",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                expect(JSON.stringify(request.context)).toContain("Message delivered.");
                return { content: [{ text: "CHILD_FINISHED", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("Create a collaborator, then wait for its steering message.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("Used Create agent", 30_000);
        releaseChild();
        await gym.terminal.waitUntil(
            () => childCalls >= 2,
            "the child steering message to finish sending",
            10_000,
        );

        const resumed = await gym.terminal.waitForText(
            "PARENT_RESUMED_AFTER_CHILD_STEERING",
            5_000,
        );
        expect(resumed.text).toContain("PARENT_RESUMED_AFTER_CHILD_STEERING");
        expect(rootCalls).toBe(2);
    }, 45_000);
});
