import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym, type GymInferenceBlock } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("collaboration tree limits", () => {
    it("refuses a sixth collaborator when parallel tool calls fill one root tree", async () => {
        let rootProviderSessionId: string | undefined;
        let rootCalls = 0;
        const gym = await createGym({
            inference: (request) => {
                rootProviderSessionId ??= request.options.sessionId;
                if (request.options.sessionId === rootProviderSessionId) {
                    rootCalls += 1;
                    return rootCalls === 1
                        ? {
                              content: Array.from({ length: 6 }, (_unused, index) =>
                                  createAgentCall(
                                      `parallelchild${index + 1}`,
                                      `Parallel child ${index + 1}`,
                                      `Complete parallel task ${index + 1}.`,
                                  ),
                              ),
                          }
                        : {
                              content: [
                                  {
                                      text: "The root handled the collaborator limit.",
                                      type: "text",
                                  },
                              ],
                          };
                }
                return { content: [{ text: "Parallel task complete.", type: "text" }] };
            },
        });
        running.add(gym);

        gym.terminal.type("Create six collaborators in parallel.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("limited to 5 collaborators", 30_000);
        expect(screen.text).toContain("Reuse an existing collaborator");
        await gym.terminal.waitForText("The root handled the collaborator limit.", 30_000);
    }, 45_000);

    it("returns the depth error when a grandchild tries to create a fourth level", async () => {
        let rootProviderSessionId: string | undefined;
        let childProviderSessionId: string | undefined;
        let grandchildProviderSessionId: string | undefined;
        const calls = new Map<string, number>();
        let depthFailureSeen = false;
        const gym = await createGym({
            inference: (request) => {
                const sessionId = request.options.sessionId ?? "";
                rootProviderSessionId ??= sessionId;
                const call = calls.get(sessionId) ?? 0;
                calls.set(sessionId, call + 1);

                if (sessionId === rootProviderSessionId) {
                    if (call === 0) {
                        return {
                            content: [
                                createAgentCall(
                                    "depthchild",
                                    "Depth child",
                                    "Create one grandchild.",
                                ),
                            ],
                        };
                    }
                    return JSON.stringify(request.context).includes("Child saw the depth limit")
                        ? {
                              content: [{ text: "The root saw the depth limit.", type: "text" }],
                          }
                        : { content: [{ text: "The root is waiting.", type: "text" }] };
                }

                childProviderSessionId ??= sessionId;
                if (sessionId === childProviderSessionId) {
                    if (call === 0) {
                        return {
                            content: [
                                createAgentCall(
                                    "depthgrandchild",
                                    "Depth grandchild",
                                    "Try to create one more collaborator.",
                                ),
                            ],
                        };
                    }
                    return JSON.stringify(request.context).includes(
                        "The grandchild hit the depth limit",
                    )
                        ? {
                              content: [{ text: "Child saw the depth limit.", type: "text" }],
                          }
                        : { content: [{ text: "The child is waiting.", type: "text" }] };
                }

                grandchildProviderSessionId ??= sessionId;
                if (sessionId !== grandchildProviderSessionId) {
                    throw new Error(
                        "A fourth collaborator reached inference despite the depth limit.",
                    );
                }
                if (call === 0) {
                    return {
                        content: [
                            createAgentCall(
                                "depthgreatgrandchild",
                                "Forbidden fourth level",
                                "This task must not start.",
                            ),
                        ],
                    };
                }
                depthFailureSeen = JSON.stringify(request.context).includes(
                    "maximum depth of 3 agents including the root",
                );
                return {
                    content: [{ text: "The grandchild hit the depth limit.", type: "text" }],
                };
            },
        });
        running.add(gym);

        gym.terminal.type("Create a collaborator chain.");
        gym.terminal.press("enter");

        await gym.terminal.waitForText("The root saw the depth limit.", 30_000);
        expect(depthFailureSeen).toBe(true);
    }, 45_000);
});

function createAgentCall(callId: string, title: string, text: string): GymInferenceBlock {
    return {
        arguments: { effort: "off", model: "openai/gym", text, title },
        callId,
        name: "create_agent",
        type: "tool_call",
    };
}
