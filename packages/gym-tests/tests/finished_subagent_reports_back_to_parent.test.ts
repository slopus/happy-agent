import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("finished subagent reporting", () => {
    it("delivers the child's final answer to its active parent", async () => {
        let parentAgentId = "";
        let parentRequests = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Subagent report</title><slug>subagent-report</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.sessionId !== parentAgentId) {
                    return { content: [{ text: "CHILD_FINAL_ANSWER", type: "text" }] };
                }

                parentRequests += 1;
                const transcript = JSON.stringify(request.messages);
                if (parentRequests === 1) {
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Finish and report your exact answer.",
                                    title: "Report delivery probe",
                                },
                                callId: "reportdeliverychild",
                                name: "create_agent",
                                type: "tool_call",
                            },
                            {
                                arguments: {
                                    cmd: "sleep 1",
                                    max_output_tokens: 1_000,
                                    yield_time_ms: 2_000,
                                },
                                callId: "holdparenttoolbatch",
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                expect(transcript).toContain("CHILD_FINAL_ANSWER");
                return { content: [{ text: "PARENT_RECEIVED_REPORT", type: "text" }] };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        await gym.send("Create the reporting collaborator.", { wait: false });

        const parentRequest = await gym.waitUntil(
            () =>
                gym.inference.requests.filter((request) => request.sessionId === parentAgentId)[1],
            "the active parent to run again with the child report",
            20_000,
        );
        expect(JSON.stringify(parentRequest.messages)).toContain("CHILD_FINAL_ANSWER");

        const parentAnswered = await gym.waitUntil(async () => {
            const events = await gym.sessionEvents(parentAgentId);
            return JSON.stringify(events).includes("PARENT_RECEIVED_REPORT") ? events : undefined;
        }, "the parent to answer after receiving the report");
        expect(JSON.stringify(parentAnswered)).toContain("PARENT_RECEIVED_REPORT");

        const history = await gym.client.getMessages(parentAgentId);
        expect(history.runs).toHaveLength(2);
        expect(history.runs[0]).toMatchObject({ reason: "steering", status: "aborted" });
        expect(history.runs[1]).toMatchObject({ reason: "completed", status: "completed" });
        const report = history.runs[1]?.messages.find(
            (message) => message.role === "agent" && message.metadata.senderAgentId !== undefined,
        );
        if (report === undefined)
            throw new Error("The child report is absent from parent history.");

        const boundaries = (await gym.client.getEvents({ limit: 10_000 })).events.filter(
            (event) => event.type === "run.boundary" && event.payload.agentId === parentAgentId,
        );
        expect(boundaries).toHaveLength(1);
        const boundary = boundaries[0];
        if (boundary?.type !== "run.boundary") {
            throw new Error("The collaboration steering transition emitted no run boundary.");
        }
        expect(boundary.payload.finishedRun).toMatchObject({
            id: history.runs[0]?.id,
            reason: "steering",
            status: "aborted",
        });
        expect(boundary.payload.startedRun.id).toBe(history.runs[1]?.id);
        expect(boundary.payload.acceptedMessageIds).toEqual([report.id]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);
});
