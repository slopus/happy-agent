import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

describe("workspace creation through the agent tool", () => {
    it("creates a named child of the current workspace and lists its parent", async () => {
        let createIssued = false;
        const gym = await createAgentGym({
            files: { "workspace-tool-marker.txt": "created through the agent tool\n" },
            inference: (_request: GymInferenceRequest): GymTurn => {
                if (_request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "Workspace tool", type: "text" }] };
                }
                if (!createIssued) {
                    createIssued = true;
                    return {
                        content: [
                            {
                                arguments: {
                                    name: "Agent tool child workspace",
                                    baseRef: "main",
                                },
                                callId: "call_workspace_agent_tool",
                                name: "create_child_workspace",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            text: "The workspace was reserved and its setup is continuing.",
                            type: "text",
                        },
                    ],
                };
            },
        });
        running.add(gym);

        const project = (await gym.client.listProjects()).projects.find((candidate) =>
            candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
        );
        expect(project).toBeDefined();
        if (project === undefined) throw new Error("The gym did not register its root project.");

        await gym.send("Create a child workspace with the child-workspace tool.");
        expect(gym.inference.lastTools()).toContain("create_child_workspace");
        const toolResult = gym.inference
            .toolResults()
            .find((result) => result.callId === "call_workspace_agent_tool");
        if (toolResult === undefined)
            throw new Error("The child-workspace tool returned no result.");
        expect(toolResult.text).toContain("Child workspace created:");

        const workspace = await gym.waitUntil(async () => {
            const candidate = (
                await gym.client.listWorkspaces({
                    includeArchived: true,
                    projectId: project.id,
                })
            ).workspaces.find((item) => item.creatorAgentId === gym.defaultSessionId);
            if (candidate?.initialization.status === "failed") {
                throw new Error(candidate.initialization.error ?? "Workspace creation failed.");
            }
            return candidate?.initialization.status === "ready" ? candidate : undefined;
        }, "the agent-tool workspace to become ready");

        expect(workspace).toMatchObject({
            creatorAgentId: gym.defaultSessionId,
            initialization: { error: null, status: "ready" },
            base: { ref: "main" },
            name: "Agent tool child workspace",
            nameSource: "user",
            parentId: project.id,
            projectId: project.id,
        });
        expect(workspace.compute.type).toBe("host");
        if (workspace.compute.type !== "host") {
            throw new Error("The agent-tool workspace did not receive a host folder.");
        }
        await expect(
            readFile(join(workspace.compute.path, "workspace-tool-marker.txt"), "utf8"),
        ).resolves.toBe("created through the agent tool\n");
        expect(
            gym.inference
                .toolResults()
                .some((result) => result.callId === "call_workspace_agent_tool"),
        ).toBe(true);
    }, 30_000);
});
