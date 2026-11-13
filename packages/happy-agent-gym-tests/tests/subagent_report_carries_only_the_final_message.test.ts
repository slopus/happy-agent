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

/**
 * A parent that creates one collaborator, goes idle, and answers once a report arrives. The child
 * writes a progress note before a tool call, then ends its run with `finish`.
 */
async function reportScenario(finish: GymTurn): Promise<{ gym: AgentGym; parentAgentId: string }> {
    let parentAgentId = "";
    let parentRequests = 0;
    let childRequests = 0;
    const gym = await createAgentGym({
        inference: (request: GymInferenceRequest): GymTurn => {
            if (request.sessionId.startsWith("naming:")) {
                return {
                    content: [
                        {
                            text: "<title>Final report</title><slug>final-report</slug>",
                            type: "text",
                        },
                    ],
                };
            }
            if (request.sessionId !== parentAgentId) {
                childRequests += 1;
                if (childRequests === 1) {
                    return {
                        content: [
                            { text: "CHILD_PROGRESS_NOTE", type: "text" },
                            {
                                arguments: {
                                    cmd: "true",
                                    max_output_tokens: 1_000,
                                    yield_time_ms: 1_000,
                                },
                                callId: "childstep",
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (childRequests === 2) return finish;
                return { content: [{ text: "UNEXPECTED_CHILD_CONTINUATION", type: "text" }] };
            }

            parentRequests += 1;
            if (parentRequests === 1) {
                return {
                    content: [
                        {
                            arguments: {
                                effort: "medium",
                                model: "gym/model",
                                provider: "gym",
                                text: "Check the step and report.",
                                title: "Final report probe",
                            },
                            callId: "finalreportchild",
                            name: "create_agent",
                            type: "tool_call",
                        },
                    ],
                };
            }
            const transcript = JSON.stringify(request.messages);
            if (transcript.includes(`Collaborator `) && transcript.includes("CHILD_")) {
                return { content: [{ text: "PARENT_RECEIVED_REPORT", type: "text" }] };
            }
            return { content: [{ text: "PARENT_WAITING", type: "text" }] };
        },
    });
    running.add(gym);
    parentAgentId = gym.defaultSessionId;
    await gym.send("Create the reporting collaborator.", {
        permissionMode: "full_access",
        wait: false,
    });
    return { gym, parentAgentId };
}

async function parentReport(gym: AgentGym, parentAgentId: string): Promise<string> {
    const history = await gym.waitUntil(
        async () => {
            const messages = await gym.client.getMessages(parentAgentId);
            return JSON.stringify(messages).includes("PARENT_RECEIVED_REPORT")
                ? messages
                : undefined;
        },
        "the parent to answer the child's report",
        20_000,
    );
    const reports = history.runs
        .flatMap((run) => run.messages)
        .filter(
            (message) => message.role === "agent" && message.metadata.senderAgentId !== undefined,
        );
    expect(reports).toHaveLength(1);
    return JSON.stringify(reports[0]);
}

describe("subagent report", () => {
    it("carries the final message and not the progress written before a tool call", async () => {
        const { gym, parentAgentId } = await reportScenario({
            content: [{ text: "CHILD_FINAL_ANSWER", type: "text" }],
        });

        const report = await parentReport(gym, parentAgentId);
        expect(report).toContain("finished working");
        expect(report).toContain("CHILD_FINAL_ANSWER");
        expect(report).not.toContain("CHILD_PROGRESS_NOTE");
        expect(JSON.stringify(await gym.client.getMessages(parentAgentId))).not.toContain(
            "CHILD_PROGRESS_NOTE",
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);

    it("reports a stop rather than a progress note when the run fails after a tool call", async () => {
        const { gym, parentAgentId } = await reportScenario({
            error: {
                message: "CHILD_PROVIDER_FAILED",
                providerError: { type: "authentication", diagnostics: { status: 401 } },
            },
        });

        const report = await parentReport(gym, parentAgentId);
        expect(report).toContain("stopped without answering");
        expect(report).toContain("CHILD_PROVIDER_FAILED");
        expect(report).not.toContain("CHILD_PROGRESS_NOTE");
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);
});
