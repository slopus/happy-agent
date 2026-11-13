import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * Claude models with preserved thinking bind every thinking block to the `system` prompt, tools,
 * and messages before it, and reject a replayed block once any of them changed. Creating a
 * collaborator happens in the middle of a turn, so the list of them must never be part of `system`.
 */
describe("the collaborators an agent created stay out of the system prompt", () => {
    it.each([
        { tool: "create_agent", from: "the main agent" },
        { tool: "create_subtask", from: "a task" },
    ] as const)(
        "keeps the instructions byte-identical after $tool from $from and lists it with the next message",
        async ({ tool }) => {
            const turns: GymInferenceRequest[] = [];
            let created: string | undefined;
            const gym = await createAgentGym({
                inference(request) {
                    if (request.sessionId.startsWith("naming:")) {
                        return { content: [{ type: "text", text: "<title>Unused</title>" }] };
                    }
                    if (turns.length > 0 && request.sessionId !== turns[0]!.sessionId) {
                        created = request.sessionId;
                        return { content: [{ type: "text", text: "Hello back." }] };
                    }
                    turns.push(request);
                    if (turns.length !== 1) return { content: [{ type: "text", text: "Done." }] };
                    return {
                        content: [
                            { type: "reasoning", text: "A second pair of hands will help." },
                            {
                                type: "tool_call",
                                name: tool,
                                arguments: {
                                    title: "Collaborator",
                                    text: "Collaborator hello.",
                                    model: gym.selection.modelId,
                                    provider: gym.selection.providerId,
                                    effort: "medium",
                                },
                            },
                        ],
                    };
                },
            });
            running.add(gym);
            // Only a task or a bot creates subtasks; the main agent creates collaborators.
            const sessionId =
                tool === "create_subtask"
                    ? (await gym.client.createTask({ name: "Parent task" })).task.agent.id
                    : gym.defaultSessionId;

            await gym.send("Start a collaborator.", { sessionId, permissionMode: "auto" });
            await gym.waitUntil(() => created, "the collaborator to start working");

            // The request carrying the tool result is built with the collaborator already created.
            expect(turns.length).toBeGreaterThanOrEqual(2);
            expect(turns[1]!.instructions).toBe(turns[0]!.instructions);
            expect(turns[1]!.instructions).not.toContain("Collaborators you created");
            // The tool result already names the collaborator: nothing lands in the running turn.
            expect(systemTexts(turns[1]!).filter(isCollaboratorsNotice)).toEqual([]);

            await gym.send("Anything else?", { sessionId, permissionMode: "auto" });

            const last = turns.at(-1)!;
            expect(new Set(turns.map((turn) => turn.instructions)).size).toBe(1);
            // Listed once, whether it arrived with the collaborator's report or with this message.
            expect(systemTexts(last).filter(isCollaboratorsNotice)).toEqual([
                `Collaborators you created: ${created}. Each reports back with only its final message when it finishes; you do not see its intermediate messages, and nothing waits for them.`,
            ]);
            expect(gym.errors).toEqual([]);
        },
        30_000,
    );
});

function isCollaboratorsNotice(text: string): boolean {
    return text.startsWith("Collaborators you created: ");
}

function systemTexts(request: GymInferenceRequest): string[] {
    return request.messages.flatMap((message) =>
        message.role === "system"
            ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
    );
}
