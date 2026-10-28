import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("creates no Prioritizing, sidebar, or notes for a person who never opened the Spaces sidebar", async () => {
    let subtaskCall: string | undefined;
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: (request) => {
            const last = JSON.stringify(request.messages.at(-1));
            if (subtaskCall !== undefined && last.includes(subtaskCall)) {
                const callId = subtaskCall;
                subtaskCall = undefined;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_subtask",
                            callId,
                            arguments: {
                                title: "Drop indicator",
                                text: "Work on the drop indicator.",
                                model: gym.selection.modelId,
                                effort: gym.selection.effort,
                                provider: gym.selection.providerId,
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    try {
        const bot = (await gym.client.createBot({ name: "Release Steward" })).bot;
        const { task } = await gym.client.createTask({ name: "Pricing rewrite" });
        await gym.send("Rewrite the pricing page copy.", { sessionId: task.agent.id });
        await gym.send("Plan the next release.", { sessionId: bot.agent.id });
        subtaskCall = "optin_subtask_1";
        await gym.send(`Please execute create_subtask, request ${subtaskCall}.`, {
            sessionId: bot.agent.id,
        });
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgentActivity(bot.agent.id)).subagents.some(
                    (child) => child.title === "Drop indicator",
                )
                    ? true
                    : undefined,
            "the subtask",
        );
        await gym.send("Keep going.", { sessionId: task.agent.id });

        // Nobody is Prioritizing, no request ever briefed one, and no sidebar exists.
        expect(
            gym.inference.requests.some((request) =>
                request.instructions.includes("You are the Focus Agent"),
            ),
        ).toBe(false);
        const { artifacts } = await gym.client.listArtifacts();
        expect(artifacts.filter((artifact) => artifact.type === "sidebar")).toEqual([]);
        // Conversations are offered nothing that asks a Prioritizing to move rows.
        expect(
            gym.inference.requests.some((request) =>
                request.tools.some((tool) => tool.name === "request_space_placement"),
            ),
        ).toBe(false);

        // Happy has no Prioritizing subtask and no sidebar notes in its chat.
        const happy = (await gym.client.listBots()).bots.find(
            (candidate) => candidate.systemKey === "chief_of_staff",
        );
        expect(happy).toBeDefined();
        if (happy !== undefined) {
            const agent = (await gym.client.getAgent(happy.agent.id)).agent;
            expect((agent.subtasks ?? []).filter((child) => child.title === "Focus Agent")).toEqual(
                [],
            );
            const page = (await gym.client.getMessages(happy.agent.id)) as unknown as {
                runs: { messages: unknown[] }[];
            };
            expect(page.runs.flatMap((run) => run.messages)).toEqual([]);
        }
        expect(gym.errors).toEqual([]);
    } finally {
        await gym.dispose();
    }
}, 60_000);
