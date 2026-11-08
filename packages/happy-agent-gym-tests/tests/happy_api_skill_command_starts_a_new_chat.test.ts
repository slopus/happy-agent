import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

/**
 * A new-chat composer creates the agent and then sends the person's `/name args` straight to the
 * slash-command endpoint, so the invocation is the conversation's very first action.
 */
describe("a skill command as the first action of a new chat", () => {
    it("runs under the full mode, records it, names the chat, and echoes the mutation", async () => {
        const gym = await createAgentGym({
            files: {
                ".agents/skills/review/SKILL.md":
                    "---\nname: review\ndescription: Review the current changes.\n---\n\nInspect authentication carefully.",
            },
            inference: (request) =>
                request.sessionId.startsWith("naming:")
                    ? { content: [{ text: "<title>Review the login flow</title>", type: "text" }] }
                    : { content: [{ text: "Reviewed.", type: "text" }] },
        });
        activeGyms.add(gym);

        const created = await gym.client.createAgent({
            id: "firstskillchat",
            workspaceId: (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId,
        });
        const agentId = created.agent.id;
        expect(created.slashCommands).toContainEqual({
            description: "Review the current changes.",
            hasArguments: true,
            kind: "skill",
            name: "review",
        });
        await expect(gym.client.getAgentMode(agentId)).resolves.toEqual({ mode: null });

        const mode = {
            effort: "high",
            modelId: "gym/model-2",
            permissionMode: "read_only",
            providerId: "gym",
            serviceTier: null,
        } as const;
        const invoked = await gym.http.post(`/v0/agents/${agentId}/slash-commands/review`, {
            arguments: "focus on the login redirect",
            mode,
            mutationId: "first-skill-chat",
        });
        expect(invoked.status).toBe(202);
        const body = invoked.body as { command: unknown; cursor: string };
        expect(body.command).toMatchObject({ kind: "skill", name: "review" });

        const settled = await gym.waitUntil(async () => {
            const { agent } = await gym.client.getAgent(agentId);
            return agent.status === "idle" && agent.titleStatus === "ready" ? agent : undefined;
        }, "the first skill run to finish and the chat to be named");
        expect(settled.title).toBe("Review the login flow");
        await expect(gym.client.getAgentMode(agentId)).resolves.toEqual({ mode });

        const run = gym.inference.requests.find(
            (request) => request.sessionId === agentId && !request.sessionId.startsWith("naming:"),
        );
        expect(run).toMatchObject({ effort: "high", model: "gym/model-2" });
        expect(run?.instructions).toContain("Inspect authentication carefully.");
        expect(JSON.stringify(run?.messages.at(-1))).toContain(
            "Use the /review skill.\\n\\nfocus on the login redirect",
        );
        const naming = gym.inference.requests.find((request) =>
            request.sessionId.startsWith("naming:"),
        );
        expect(JSON.stringify(naming?.messages)).toContain("Use the /review skill.");

        const { events } = await gym.client.getEvents({ after: body.cursor });
        const caused = events.filter(
            (event) =>
                (event.type === "message.created" || event.type === "run.finished") &&
                event.payload.agentId === agentId,
        );
        expect(caused.map((event) => event.type)).toEqual(
            expect.arrayContaining(["message.created", "run.finished"]),
        );
        for (const event of caused) {
            expect(event.payload).toMatchObject({ mutationId: "first-skill-chat" });
        }
        expect(gym.errors).toEqual([]);
    });
});
