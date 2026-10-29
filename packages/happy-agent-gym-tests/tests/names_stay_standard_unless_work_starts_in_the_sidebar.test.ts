import {
    createAgentGym,
    GYM_MODEL_ID,
    type AgentGym,
    type GymInferenceRequest,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** Five words: a standard name keeps them all, a subject name keeps three. */
const FIVE_WORD_TITLE = "Pricing page copy team rewrite";

interface StemCell {
    readonly space: { readonly id: string; readonly target: { readonly id: string } };
    readonly agent: { readonly id: string };
}

async function namingGym(): Promise<AgentGym> {
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: (request) => {
            if (!request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "Done." }] };
            }
            if (request.instructions.includes("persistent assistant")) {
                return { content: [{ type: "text", text: "<title>Release Steward</title>" }] };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `<title>${FIVE_WORD_TITLE}</title>\n<slug>pricing-page-copy</slug>`,
                    },
                ],
            };
        },
    });
    running.add(gym);
    return gym;
}

/** The detached naming requests one first message started. */
function namingFor(gym: AgentGym, firstMessage: string): GymInferenceRequest[] {
    return gym.inference.requests.filter(
        (request) =>
            request.sessionId.startsWith("naming:") &&
            JSON.stringify(request.messages).includes(firstMessage),
    );
}

describe("naming", () => {
    it("names tasks, bots and workspaces the standard way for a person who never opened the sidebar", async () => {
        const gym = await namingGym();

        // A task without a name takes its name from its first message.
        const { task } = await gym.client.createTask({});
        const taskMessage = "Rewrite the pricing page copy so the team plan is clear.";
        await gym.send(taskMessage, { sessionId: task.agent.id });
        await gym.waitUntil(async () => {
            const current = (await gym.client.getTask(task.id)).task;
            return current.name === FIVE_WORD_TITLE ? current : undefined;
        }, "the task to take a six-word-bounded name");

        // A bot takes a role-like name from its first message.
        const bot = (await gym.client.createBot({})).bot;
        const botMessage = "Track releases and flag regressions for me.";
        await gym.send(botMessage, { sessionId: bot.agent.id });
        await gym.waitUntil(async () => {
            const current = (await gym.client.getBot(bot.id)).bot;
            return current.name === "Release Steward" ? current : undefined;
        }, "the bot to take its role-like name");

        // A placeholder workspace takes its folder and branch name from its first chat.
        const project = (await gym.client.listProjects()).projects.find((candidate) =>
            candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
        );
        if (project === undefined) throw new Error("The gym did not expose its root project.");
        await gym.waitUntil(async () => {
            try {
                const root = (await gym.client.getWorkspace(project.id)).workspace;
                return root.initialization.status === "ready" ? root : undefined;
            } catch (error) {
                if ((error as { readonly status?: unknown }).status === 409) return undefined;
                throw error;
            }
        }, "the root workspace to become ready");
        const placeholder = (
            await gym.client.createWorkspace({
                mutationId: "standard-naming-placeholder",
                name: "Workspace",
                nameConfigured: false,
                parentId: project.id,
            })
        ).workspace;
        await gym.waitUntil(async () => {
            const current = (await gym.client.getWorkspace(placeholder.id)).workspace;
            return current.initialization.status === "ready" ? current : undefined;
        }, "the placeholder workspace to become ready");
        const agent = (
            await gym.client.createAgent({
                id: "standardnamingworkspaceagent",
                mutationId: "standard-naming-workspace-agent",
                workspaceId: placeholder.id,
            })
        ).agent;
        const workspaceMessage = "Investigate why the pricing page copy is stale.";
        await gym.send(workspaceMessage, { sessionId: agent.id });
        const renamed = await gym.waitUntil(async () => {
            const current = (await gym.client.getWorkspace(placeholder.id)).workspace;
            return current.name === "pricing-page-copy" ? current : undefined;
        }, "the workspace to take the first chat's name");
        expect(renamed.git?.branch).toBe("worktree/pricing-page-copy");
        await gym.waitUntil(async () => {
            const current = (await gym.client.getAgent(agent.id)).agent;
            return current.title === FIVE_WORD_TITLE ? current : undefined;
        }, "the workspace chat to take a six-word-bounded title");

        // Every name came from the cheapest model of the chat's account at the least effort,
        // asked for with the standard prompts.
        const titleRequests = [...namingFor(gym, taskMessage), ...namingFor(gym, workspaceMessage)];
        expect(titleRequests.length).toBeGreaterThanOrEqual(2);
        for (const request of titleRequests) {
            expect(request.model).toBe(GYM_MODEL_ID);
            expect(request.effort).toBe("low");
            expect(request.instructions).toContain("two to six words");
            expect(request.instructions).not.toContain("one to three words");
        }
        const botRequests = namingFor(gym, botMessage);
        expect(botRequests).toHaveLength(1);
        expect(botRequests[0]?.effort).toBe("low");
        expect(botRequests[0]?.instructions).toContain("At most three words and 40 characters.");

        // Nothing here opted in to the sidebar.
        expect(
            gym.inference.requests.some((request) =>
                request.instructions.includes("You are the Focus Agent"),
            ),
        ).toBe(false);
        expect(gym.errors).toEqual([]);
    }, 90_000);

    it("names work started in the sidebar by its subject, on the chat's own model", async () => {
        const gym = await namingGym();
        await gym.client.saveUserSetting("happy-desktop.experiments.stemCells", { value: true });

        const stem = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
        const stemMessage = "Rewrite the pricing page copy so the team plan is clear.";
        await gym.send(stemMessage, { sessionId: stem.agent.id });
        await gym.waitUntil(async () => {
            const current = (await gym.client.getTask(stem.space.target.id)).task;
            return current.name === "Pricing page copy" ? current : undefined;
        }, "the stem cell to take a three-word subject name");

        const requests = namingFor(gym, stemMessage);
        expect(requests.length).toBeGreaterThanOrEqual(1);
        for (const request of requests) {
            expect(request.model).toBe(gym.selection.modelId);
            expect(request.effort).toBe("medium");
            expect(request.instructions).toContain("one to three words, at most 32 characters");
        }

        // The same person's other work keeps standard names.
        const { task } = await gym.client.createTask({});
        const taskMessage = "Investigate why the pricing page copy is stale.";
        await gym.send(taskMessage, { sessionId: task.agent.id });
        await gym.waitUntil(async () => {
            const current = (await gym.client.getTask(task.id)).task;
            return current.name === FIVE_WORD_TITLE ? current : undefined;
        }, "a task started outside the sidebar to take a standard name");
        for (const request of namingFor(gym, taskMessage)) {
            expect(request.effort).toBe("low");
            expect(request.instructions).toContain("two to six words");
        }
        expect(gym.errors).toEqual([]);
    }, 90_000);
});
