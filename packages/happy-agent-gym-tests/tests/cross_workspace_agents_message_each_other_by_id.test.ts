import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("cross-workspace Agent-ID messaging", () => {
    it("identifies the sender in its prompt and delivers to an unrelated workspace agent", async () => {
        let senderAgentId = "";
        let recipientAgentId = "";
        let senderCalls = 0;
        let recipientCalls = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (
                    request.sessionId.startsWith("naming:") ||
                    request.instructions.includes("You name a piece of work")
                ) {
                    return {
                        content: [
                            {
                                text: "<title>Cross-workspace messaging</title><slug>cross-workspace-messaging</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.sessionId === senderAgentId) {
                    senderCalls += 1;
                    expect(request.instructions).toContain(`Your Agent ID is ${senderAgentId}.`);
                    expect(request.instructions).toContain(
                        "Cross-workspace agent messaging is enabled",
                    );
                    if (senderCalls === 1) {
                        return {
                            content: [
                                {
                                    arguments: {
                                        text: "CROSS_WORKSPACE_MESSAGE_RECEIVED",
                                        toAgentId: recipientAgentId,
                                    },
                                    callId: "crossworkspacemessage",
                                    name: "send_agent_message",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    return {
                        content: [{ text: "CROSS_WORKSPACE_SENDER_FINISHED", type: "text" }],
                    };
                }
                if (request.sessionId === recipientAgentId) {
                    recipientCalls += 1;
                    expect(JSON.stringify(request.messages)).toContain(
                        "CROSS_WORKSPACE_MESSAGE_RECEIVED",
                    );
                    expect(JSON.stringify(request.messages)).toContain(senderAgentId);
                    return {
                        content: [{ text: "CROSS_WORKSPACE_RECIPIENT_FINISHED", type: "text" }],
                    };
                }
                return { content: [{ text: "UNEXPECTED_AGENT", type: "text" }] };
            },
        });
        running.add(gym);
        senderAgentId = gym.defaultSessionId;

        const project = await rootProject(gym);
        const workspace = await createChildWorkspace(gym, project.id);
        recipientAgentId = (
            await gym.client.createAgent({
                id: "crossworkspacerecipient",
                title: "Cross-workspace recipient",
                workspaceId: workspace.id,
            })
        ).agent.id;

        await gym.send("Message the other workspace agent using its Agent ID.");

        const recipientHistory = await gym.waitUntil(async () => {
            const history = await gym.client.getMessages(recipientAgentId);
            return history.runs.at(-1)?.status === "completed" ? history : undefined;
        }, "the unrelated workspace agent to finish the delivered message");
        expect(JSON.stringify(recipientHistory)).toContain("CROSS_WORKSPACE_MESSAGE_RECEIVED");
        expect(JSON.stringify(recipientHistory)).toContain("CROSS_WORKSPACE_RECIPIENT_FINISHED");
        expect(senderCalls).toBe(2);
        expect(recipientCalls).toBe(1);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 45_000);
});

async function rootProject(gym: AgentGym) {
    return await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const project = projects.projects.find((candidate) =>
                candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
            return project?.initialization.status === "ready" ? project : undefined;
        },
        "the root project to be ready",
        30_000,
    );
}

async function createChildWorkspace(gym: AgentGym, parentId: string) {
    const created = await gym.client.createWorkspace({
        id: "crossworkspacemessagingworkspace",
        name: "cross-workspace-messaging",
        parentId,
    });
    return await gym.waitUntil(
        async () => {
            const workspace = (await gym.client.getWorkspace(created.workspace.id)).workspace;
            if (workspace.initialization.status === "failed") {
                throw new Error(
                    workspace.initialization.error ?? "workspace initialization failed",
                );
            }
            return workspace.initialization.status === "ready" ? workspace : undefined;
        },
        "the destination workspace to be ready",
        30_000,
    );
}
