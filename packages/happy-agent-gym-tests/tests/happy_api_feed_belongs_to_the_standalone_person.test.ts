import type { FeedItem } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("the standalone feed", () => {
    it("sees the person's own changes, keeps an agent's unread, and survives a restart", async () => {
        const commands = new Map<string, { callId: string; turn: GymTurn }>();
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            inference: async (request) => {
                const command = commands.get(request.sessionId);
                if (
                    command !== undefined &&
                    JSON.stringify(request.messages).includes(command.callId)
                ) {
                    commands.delete(request.sessionId);
                    return command.turn;
                }
                return { content: [{ type: "text", text: "Done." }] };
            },
        });
        running.add(gym);
        const client = gym.client;
        const before = (await client.getEvents()).latestCursor;
        const { task } = await client.createTask({ name: "Garden" });
        const { surface } = await client.createSurface({ type: "todo", name: "Seeds" });
        const forSubject = async (id: string, check: (item: FeedItem) => boolean) =>
            await gym.waitUntil(async () => {
                const item = (await client.getFeed()).items.find(
                    (entry) => entry.subject.id === id,
                );
                return item !== undefined && check(item) ? item : undefined;
            }, `the feed entry for ${id}`);
        // Both are the person's own, so they are already seen and attributed to nobody else.
        const own = await forSubject(task.id, (item) => item.seenAt !== null);
        expect(own.actors).toEqual([{ userId: null, agentId: null }]);
        await forSubject(surface.id, (item) => item.seenAt !== null);
        expect((await client.getDesktopBootstrap()).feedUnread).toBe(0);

        commands.set(task.agent.id, {
            callId: "standalone_todo",
            turn: {
                content: [
                    {
                        type: "tool_call",
                        name: "create_todo",
                        arguments: { tabId: surface.id, text: "Tomatoes", authorUserId: null },
                        callId: "standalone_todo",
                    },
                ],
            },
        });
        await gym.send("Please add a todo, request standalone_todo.", {
            sessionId: task.agent.id,
            permissionMode: "full_access",
        });
        const open = await forSubject(surface.id, (item) => item.seenAt === null);
        expect(open).toMatchObject({ updates: 1, snapshot: { detail: "Tomatoes" } });
        expect((await client.getDesktopBootstrap()).feedUnread).toBe(1);
        const types = (await client.getEvents({ after: before, limit: 1000 })).events
            .map((event) => event.type)
            .filter((type) => type.startsWith("feed."));
        expect(types).toContain("feed.item.created");
        expect(types).toContain("feed.unread.updated");

        await gym.restart();
        const after = await client.getFeed();
        expect(after.unread).toBe(1);
        expect(after.items.find((item) => item.id === open.id)).toEqual(open);
        await client.markFeedSeen({ subjects: [{ type: "surface", id: surface.id }] });
        expect((await client.getFeed()).unread).toBe(0);
        expect(gym.errors).toEqual([]);
    });
});
