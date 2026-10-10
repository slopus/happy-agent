import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("first-message naming", () => {
    it("accepts and starts the first turn while naming is still running", async () => {
        let releaseNaming!: () => void;
        const namingMayFinish = new Promise<void>((resolve) => {
            releaseNaming = resolve;
        });
        const gym = await createAgentGym({
            inference: async (request) => {
                if (request.instructions.includes("You name a piece of work")) {
                    await namingMayFinish;
                    return {
                        content: [
                            {
                                text: "<title>Project file list investigation</title>",
                                type: "text",
                            },
                        ],
                    };
                }
                return { content: [{ text: "Investigation complete.", type: "text" }] };
            },
        });
        activeGyms.add(gym);

        let acceptance: Awaited<ReturnType<AgentGym["send"]>> | undefined;
        const sending = gym
            .send("Investigate why the project file list is empty.", { wait: false })
            .then((accepted) => {
                acceptance = accepted;
                return accepted;
            });

        try {
            await gym.waitUntil(
                () =>
                    gym.inference.requests.some((request) =>
                        request.instructions.includes("You name a piece of work"),
                    )
                        ? true
                        : undefined,
                "title generation to start",
            );
            await gym.waitUntil(
                () => acceptance,
                "the first message to be accepted while title generation is still running",
                2_000,
            );
            await gym.waitUntil(
                () =>
                    gym.inference.requests.some(
                        (request) => !request.instructions.includes("You name a piece of work"),
                    )
                        ? true
                        : undefined,
                "the first real inference to start while title generation is still running",
                2_000,
            );
            expect(gym.inference.requests).toHaveLength(2);
        } finally {
            releaseNaming();
        }

        const accepted = await sending;
        await gym.waitForRun(accepted.runId);
        expect(gym.inference.requests).toHaveLength(2);
    }, 30_000);

    it("names an untitled session from its first message", async () => {
        const gym = await startGym();

        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.title).toBeNull();

        await gym.send("Investigate why the project file list is empty.");

        const named = await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === null ? undefined : agent;
        }, "the first message to name its session");
        expect(named.title).toBe("Project file list investigation");

        const requests = gym.inference.requests;
        const naming = requests.find((request) =>
            request.instructions.includes("You name a piece of work"),
        );
        expect(naming).toBeDefined();
        const namingPrompt = JSON.stringify(naming?.messages);
        expect(namingPrompt).toContain("Investigate why the project file list is empty.");
        expect(namingPrompt).not.toContain("Investigation complete.");
        expect(
            requests.some((request) =>
                JSON.stringify(request.messages).includes(
                    "Investigate why the project file list is empty.",
                ),
            ),
        ).toBe(true);
    }, 30_000);

    it("propagates the first generated session name to its placeholder workspace", async () => {
        const gym = await startGym();
        const root = await rootWorkspace(gym);
        const placeholder = (
            await gym.client.createWorkspace({
                mutationId: "first-message-placeholder-workspace",
                name: "Workspace",
                nameConfigured: false,
                parentId: root.id,
            })
        ).workspace;
        await gym.waitUntil(async () => {
            const workspace = (await gym.client.getWorkspace(placeholder.id)).workspace;
            return workspace.initialization.status === "ready" ? workspace : undefined;
        }, "the placeholder workspace to become ready");
        expect((await gym.client.getWorkspace(placeholder.id)).workspace.nameSource).toBe(
            "generated",
        );

        const agent = (
            await gym.client.createAgent({
                id: "firstmessageworkspaceagent",
                mutationId: "first-message-workspace-agent",
                workspaceId: placeholder.id,
            })
        ).agent;
        await gym.send("Investigate why the project file list is empty.", {
            sessionId: agent.id,
        });

        const renamed = await gym.waitUntil(async () => {
            const workspace = (await gym.client.getWorkspace(placeholder.id)).workspace;
            return workspace.name === "project-file-list" ? workspace : undefined;
        }, "the first generated session name to propagate to its workspace");
        expect(renamed.nameSource).toBe("generated");
        expect(renamed.git?.branch).toBe("worktree/project-file-list");
        expect((await gym.client.getAgent(agent.id)).agent.title).toBe(
            "Project file list investigation",
        );
    }, 30_000);

    it("refines once from history including the second user message", async () => {
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.instructions.includes("You name a piece of work")) {
                    return {
                        content: [
                            {
                                text: "<title>Project file list investigation</title>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.instructions.includes("saved chat that already has a title")) {
                    return {
                        content: [
                            {
                                text: "<title>Project file list repair</title>",
                                type: "text",
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            text: JSON.stringify(request.messages).includes(
                                "Actually fix the project file list instead.",
                            )
                                ? "Repair complete."
                                : "Investigation complete.",
                            type: "text",
                        },
                    ],
                };
            },
        });
        activeGyms.add(gym);

        await gym.send("Investigate why the project file list is empty.");
        await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === "Project file list investigation" ? true : undefined;
        }, "the first user message to set the initial title");

        await gym.send("Actually fix the project file list instead.");
        await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === "Project file list repair" ? true : undefined;
        }, "the second user message to refine the title");

        const refinement = gym.inference.requests.find((request) =>
            request.instructions.includes("saved chat that already has a title"),
        );
        expect(refinement).toBeDefined();
        const prompt = JSON.stringify(refinement?.messages);
        expect(prompt).toContain("Investigate why the project file list is empty.");
        expect(prompt).toContain("Investigation complete.");
        expect(prompt).toContain("Actually fix the project file list instead.");
        expect(prompt).not.toContain("Repair complete.");

        await gym.send("Run the focused tests too.");
        expect(
            gym.inference.requests.filter((request) =>
                request.instructions.includes("saved chat that already has a title"),
            ),
        ).toHaveLength(1);
    }, 30_000);
});

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym({
        inference: (request) => {
            if (request.instructions.includes("You name a piece of work")) {
                return {
                    content: [
                        {
                            text: [
                                "<title>Project file list investigation</title>",
                                "<slug>project-file-list</slug>",
                            ].join("\n"),
                            type: "text",
                        },
                    ],
                };
            }
            return { content: [{ text: "Investigation complete.", type: "text" }] };
        },
    });
    activeGyms.add(gym);
    return gym;
}

async function rootWorkspace(gym: AgentGym) {
    const project = (await gym.client.listProjects()).projects.find((candidate) =>
        candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
    );
    if (project === undefined) throw new Error("The gym did not expose its root project.");
    return await gym.waitUntil(async () => {
        try {
            const workspace = (await gym.client.getWorkspace(project.id)).workspace;
            return workspace.initialization.status === "ready" ? workspace : undefined;
        } catch (error) {
            if ((error as { readonly status?: unknown }).status === 409) return undefined;
            throw error;
        }
    }, "the root workspace to become ready");
}
