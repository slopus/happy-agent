import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

describe("provider-measured compaction source size", () => {
    it("replaces the provisional prior-context count in the public compaction message", async () => {
        const gym = await createAgentGym({
            inference: (request) =>
                request.sessionId.startsWith("naming:")
                    ? { content: [{ text: "Compaction accounting", type: "text" }] }
                    : {
                          content: [{ text: "Ready to compact.", type: "text" }],
                          usage: {
                              cacheRead: 500_000,
                              cacheWrite: 25_000,
                              input: 550_000,
                              output: 1_000,
                              totalTokens: 551_000,
                          },
                      },
            compaction: async (request) => ({
                status: "completed",
                preservedMessages: [],
                usage: {
                    cacheRead: 1_000_000,
                    cacheWrite: 50_000,
                    input: 1_102_000,
                    output: 29_800,
                    totalTokens: 1_131_800,
                },
                context: { instructions: request.context.instructions, messages: [] },
            }),
        });
        running.add(gym);

        await gym.send("Measure this context.");
        const started = await gym.client.compactAgent(gym.defaultSessionId);
        expect(started.message.content).toContainEqual(
            expect.objectContaining({
                type: "compaction",
                status: "running",
                tokensBefore: 551_000,
            }),
        );

        const completed = await gym.waitForEvent(
            (event) =>
                event.type === "message.updated" &&
                event.payload.message.id === started.message.id &&
                event.payload.message.content.some(
                    (block) =>
                        block.type === "compaction" &&
                        block.status === "completed" &&
                        block.tokensBefore === 1_102_000,
                ),
            "the provider-measured source size",
        );
        expect(completed.type).toBe("message.updated");

        const history = await gym.client.getMessages(gym.defaultSessionId);
        const block = history.runs
            .flatMap((run) => run.messages)
            .find((message) => message.id === started.message.id)
            ?.content.find((content) => content.type === "compaction");
        expect(block).toMatchObject({
            type: "compaction",
            status: "completed",
            tokensBefore: 1_102_000,
        });
    }, 30_000);
});
