import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("subagent replies and interruption", () => {
    it("steers an explicit child message into the active parent and sends no report after interrupt", async () => {
        let parentAgentId = "";
        let childAgentId: string | undefined;
        let parentRequests = 0;
        let childRequests = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Subagent steering</title><slug>subagent-steering</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.sessionId === parentAgentId) {
                    parentRequests += 1;
                    if (parentRequests === 1) {
                        return {
                            content: [
                                {
                                    arguments: {
                                        effort: "medium",
                                        model: "gym/model",
                                        provider: "gym",
                                        text: "Send progress to me, then keep working until interrupted.",
                                        title: "Steering child",
                                    },
                                    callId: "steeringchild",
                                    name: "create_agent",
                                    type: "tool_call",
                                },
                                {
                                    arguments: {
                                        cmd: "sleep 2",
                                        max_output_tokens: 1_000,
                                        yield_time_ms: 3_000,
                                    },
                                    callId: "holdparentactive",
                                    name: "exec_command",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    if (parentRequests === 2) {
                        expect(JSON.stringify(request.messages)).toContain(
                            "CHILD_EXPLICIT_PROGRESS",
                        );
                        if (childAgentId === undefined) {
                            throw new Error("The child did not start before steering its parent.");
                        }
                        return {
                            content: [
                                {
                                    arguments: { targetAgentId: childAgentId },
                                    callId: "interruptsteeringchild",
                                    name: "interrupt_agent",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    if (parentRequests === 3) {
                        return {
                            content: [
                                { text: "PARENT_CONTINUED_AFTER_CHILD_STEERING", type: "text" },
                            ],
                        };
                    }
                    return {
                        content: [{ text: "UNEXPECTED_INTERRUPTED_CHILD_REPORT", type: "text" }],
                    };
                }

                childAgentId ??= request.sessionId;
                childRequests += 1;
                if (childRequests > 1) {
                    return { content: [{ text: "UNEXPECTED_CHILD_CONTINUATION", type: "text" }] };
                }
                return {
                    content: [
                        { text: "CHILD_COMMENTARY_BEFORE_INTERRUPT", type: "text" },
                        {
                            arguments: {
                                toAgentId: parentAgentId,
                                text: "CHILD_EXPLICIT_PROGRESS",
                            },
                            callId: "childprogress",
                            name: "send_agent_message",
                            type: "tool_call",
                        },
                        {
                            arguments: { duration: "30 seconds" },
                            callId: "holdchildactive",
                            name: "wait",
                            type: "tool_call",
                        },
                    ],
                };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        await gym.send("Create a child that reports progress while I work.", {
            permissionMode: "full_access",
            wait: false,
        });
        const child = await gym.waitUntil(async () => {
            const candidate = (await gym.client.getAgentActivity(parentAgentId)).subagents[0];
            return candidate?.status === "working" ? candidate : undefined;
        }, "the child to remain active after steering its parent");
        expect(child.id).toBe(childAgentId);

        const parentHistory = await gym.waitUntil(async () => {
            const history = await gym.client.getMessages(parentAgentId);
            const finalRun = history.runs.at(-1);
            return finalRun?.status === "completed" &&
                JSON.stringify(history).includes("PARENT_CONTINUED_AFTER_CHILD_STEERING")
                ? history
                : undefined;
        }, "the parent to finish after incorporating the child's steering message");
        const childRun = await gym.waitUntil(async () => {
            const run = (await gym.client.getMessages(child.id)).runs.at(-1);
            return run?.status === "aborted" ? run : undefined;
        }, "the interrupted child run to settle");
        expect(childRun).toMatchObject({ reason: "abort", status: "aborted" });

        expect(parentHistory.runs).toHaveLength(2);
        expect(parentHistory.runs[0]).toMatchObject({ reason: "steering", status: "aborted" });
        expect(parentHistory.runs[1]).toMatchObject({ reason: "completed", status: "completed" });
        expect(JSON.stringify(parentHistory)).toContain("CHILD_EXPLICIT_PROGRESS");
        expect(JSON.stringify(parentHistory)).toContain("PARENT_CONTINUED_AFTER_CHILD_STEERING");
        expect(JSON.stringify(parentHistory)).not.toContain("finished working");
        expect(JSON.stringify(parentHistory)).not.toContain("CHILD_COMMENTARY_BEFORE_INTERRUPT");
        expect(parentRequests).toBe(3);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 45_000);
});
