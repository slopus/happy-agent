import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public API steering at a tool boundary", () => {
    it("accepts steering after the complete tool batch and before the next inference", async () => {
        let agentCalls = 0;
        const gym = await createAgentGym({
            inference: async (request): Promise<GymTurn> => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [{ text: "<title>Steering boundary</title>", type: "text" }],
                    };
                }
                const current = agentCalls;
                agentCalls += 1;
                if (current === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    context: "The active tool batch is waiting for one answer.",
                                    questions: [
                                        {
                                            header: "Continue",
                                            id: "continue",
                                            multiSelect: false,
                                            options: [
                                                {
                                                    description: "Finish the tool batch.",
                                                    label: "Continue",
                                                },
                                            ],
                                            question: "Continue to the next inference?",
                                        },
                                    ],
                                },
                                callId: "steeringquestion",
                                name: "request_user_input",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return {
                    content: [{ text: `steering-answer-${String(current)}`, type: "text" }],
                };
            },
        });
        activeGyms.add(gym);

        const first = await gym.send("start the tool batch", { wait: false });
        const question = await gym.waitUntil(
            async () =>
                (await gym.client.getPendingQuestion(gym.defaultSessionId)).question ?? undefined,
            "the steering boundary question",
        );
        const steering = gym.steer("steering after tools", {
            id: "steeringaftertools",
            wait: false,
        });
        await gym.waitUntil(async () => {
            const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
            return bootstrap.pending.some((message) => message.id === "steeringaftertools")
                ? true
                : undefined;
        }, "steering to become pending");
        expect(agentCalls).toBe(1);

        await gym.client.answerQuestion(gym.defaultSessionId, question.id, {
            answers: { continue: ["Continue"] },
            mutationId: "answer-steering-boundary-question",
        });
        const accepted = await steering;
        const boundary = await gym.waitForEvent(
            (event) =>
                event.type === "run.boundary" &&
                event.payload.acceptedMessageIds.includes(accepted.id),
            "the steering run boundary",
        );
        expect(boundary.type).toBe("run.boundary");
        if (boundary.type !== "run.boundary")
            throw new Error("Steering did not create a boundary.");
        await gym.waitForRun(boundary.payload.startedRun.id);

        const requests = gym.inference.requests.filter(
            (request) => !request.sessionId.startsWith("naming:"),
        );
        expect(requests).toHaveLength(2);
        expect(requests[1]?.messages.at(-2)).toMatchObject({
            callId: "steeringquestion",
            role: "tool",
        });
        expect(requests[1]?.messages.at(-1)).toEqual({
            content: [{ text: "steering after tools", type: "text" }],
            role: "user",
        });
        expect(boundary.payload.finishedRun.id).toBe(first.runId);
        expect(boundary.payload.acceptedMessageIds).toEqual(["steeringaftertools"]);
    }, 30_000);
});
