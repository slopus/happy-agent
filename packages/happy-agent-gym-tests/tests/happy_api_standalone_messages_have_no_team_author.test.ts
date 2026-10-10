import { createAgentGym } from "@slopus/happy-agent-gym";
import { describe, expect, it } from "vitest";

describe("standalone message authorship", () => {
    it("keeps client user IDs opaque and leaves historical messages unattributed after restart", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ type: "text", text: "First answer." }] },
                { content: [{ type: "text", text: "Second answer." }] },
            ],
        });
        try {
            const mode = { ...gym.selection, permissionMode: "full_access" as const };
            const request = {
                id: "standaloneauthor123",
                text: "Keep this text unchanged.",
                mode,
                clientMetadata: { userId: "alice123" },
            };
            const sent = await gym.client.sendMessage(gym.defaultSessionId, request);
            expect(sent.message.metadata).not.toHaveProperty("userId");
            await gym.waitUntil(async () => {
                const history = await gym.client.getMessages(gym.defaultSessionId);
                return history.runs.length > 0 &&
                    history.runs.every((run) => run.status === "completed")
                    ? history
                    : undefined;
            }, "the standalone message to complete");
            await expect(gym.client.getUsers(["alice123"])).rejects.toMatchObject({
                status: 404,
                code: "not_found",
            });
            await gym.restart();
            const retried = await gym.client.sendMessage(gym.defaultSessionId, {
                ...request,
                clientMetadata: { userId: "bob456" },
                text: "Do not replace the original.",
            });
            expect(retried.message).toMatchObject({
                metadata: {},
                clientMetadata: { userId: "alice123" },
                content: [{ type: "text", text: request.text }],
                status: "accepted",
            });
            expect(retried.message.metadata).not.toHaveProperty("userId");
            await gym.send("Continue the same conversation.");
            const history = await gym.client.getMessages(gym.defaultSessionId);
            expect(
                history.runs
                    .flatMap((run) => run.messages)
                    .every((message) => message.metadata.userId === undefined),
            ).toBe(true);
            const userMessages = gym.inference.last?.messages.filter(
                (message) => message.role === "user",
            );
            expect(userMessages).toContainEqual({
                role: "user",
                content: [{ type: "text", text: request.text }],
            });
            expect(JSON.stringify(userMessages)).not.toContain("alice123");
            expect(gym.errors).toEqual([]);
            expect(gym.inference.unscripted).toEqual([]);
        } finally {
            await gym.dispose();
        }
    }, 30_000);
});
