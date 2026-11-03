import type {
    FeedItem,
    FeedSubject,
    HappyAgentClient,
    HappyAgentEvent,
} from "@slopus/happy-agent-client";
import type { AgentGym, GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const PNG_1X1 = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);

/** Every key a Feed response, entry, cluster, or event may carry: references, counts, and times. */
const REFERENCE_KEYS = new Set([
    "items",
    "item",
    "itemId",
    "entries",
    "clusters",
    "cluster",
    "unread",
    "hasMore",
    "cursor",
    "mutationId",
    "id",
    "version",
    "subject",
    "type",
    "created",
    "updates",
    "actors",
    "userId",
    "agentId",
    "actorCount",
    "latest",
    "todoId",
    "seq",
    "artifactVersion",
    "firstAt",
    "lastAt",
    "seenAt",
    "kind",
    "state",
]);

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
    if (Array.isArray(value)) for (const each of value) keysOf(each, into);
    else if (value !== null && typeof value === "object")
        for (const [key, each] of Object.entries(value)) {
            into.add(key);
            keysOf(each, into);
        }
    return into;
}

describe("feed entries", () => {
    it("carry references only, so renames, naming, edits, and pictures never go stale", async () => {
        const commands = new Map<string, { callId: string; turn: GymTurn }>();
        const team = await surfaceTeamClients({
            timeoutMs: 20_000,
            inference: async (request) => {
                if (request.sessionId.startsWith("naming:"))
                    return {
                        content: [
                            {
                                type: "text",
                                text: "<title>Audit billing exports</title><short>Billing</short><slug>audit-billing-exports</slug>",
                            },
                        ],
                    };
                const command = commands.get(request.sessionId);
                if (
                    command !== undefined &&
                    JSON.stringify(request.messages).includes(command.callId)
                ) {
                    commands.delete(request.sessionId);
                    return command.turn;
                }
                return { content: [{ type: "text", text: "On it." }] };
            },
        });
        const { gym, alice, bob } = team;
        running.add(gym);
        const bobStart = (await bob.getEvents()).latestCursor;
        const aliceStart = (await alice.getEvents()).latestCursor;

        async function entries(
            client: HappyAgentClient,
            subject: FeedSubject,
            check: (items: readonly FeedItem[]) => boolean,
        ): Promise<FeedItem[]> {
            return await gym.waitUntil(async () => {
                const { items } = await client.getFeed({ limit: 200 });
                const mine = items.filter(
                    (item) => item.subject.type === subject.type && item.subject.id === subject.id,
                );
                return check(mine) ? mine : undefined;
            }, `feed entries for ${subject.type} ${subject.id}`);
        }

        // A task created without a name is "New Task" until it names itself.
        const { task } = await alice.createTask({});
        expect(task.name).toBe("New Task");
        const taskSubject = { type: "task", id: task.id };
        const [created] = await entries(bob, taskSubject, (items) => items.length === 1);
        expect(created).toMatchObject({ created: true, latest: { type: "task.created" } });
        await gym.send("Audit the billing exports for duplicate rows.", {
            sessionId: task.agent.id,
        });
        const named = await gym.waitUntil(async () => {
            const current = (await bob.getTask(task.id)).task;
            return current.name === "Audit billing exports" ? current : undefined;
        }, "the task's generated name");
        const renamed = (
            await alice.renameTask(task.id, { name: "Billing audit" }, { ifMatch: named.version })
        ).task;
        // Still one entry, unchanged: the name lives on the task, which Bob reads live.
        expect(await entries(bob, taskSubject, () => true)).toEqual([created]);
        expect((await bob.getTask(task.id)).task.name).toBe(renamed.name);

        // A todo is named by its ID, and its text is read from the todo, edits included.
        const { surface } = await alice.createSurface({ type: "todo", name: "Shopping" });
        const listSubject = { type: "surface", id: surface.id };
        await entries(bob, listSubject, (items) => items.length === 1);
        commands.set(task.agent.id, {
            callId: "references_todo",
            turn: {
                content: [
                    {
                        type: "tool_call",
                        name: "create_todo",
                        arguments: { surfaceId: surface.id, text: "Buy milk", authorUserId: null },
                        callId: "references_todo",
                    },
                ],
            },
        });
        await gym.send("Please add a todo, request references_todo.", {
            sessionId: task.agent.id,
            permissionMode: "full_access",
        });
        const [listItem] = await entries(bob, listSubject, (items) => items[0]?.updates === 1);
        const todoId = listItem!.latest?.todoId;
        expect(listItem!.latest).toEqual({ type: "todo.created", todoId: expect.any(String) });
        const todo = (await bob.getTodo(surface.id, todoId!)).todo;
        expect(todo.text).toBe("Buy milk");
        await alice.updateTodo(
            surface.id,
            todo.id,
            { text: "Buy oat milk" },
            { ifMatch: todo.version },
        );
        expect((await bob.getTodo(surface.id, todo.id)).todo.text).toBe("Buy oat milk");
        expect(await entries(bob, listSubject, () => true)).toEqual([listItem]);

        // An artifact's newest change is named by its version; its title is the artifact's.
        const { artifact } = await alice.createArtifact({
            type: "markdown",
            title: "Q3 report",
            files: [{ path: "index.md", text: "# Q3\n" }],
        });
        const artifactSubject = { type: "artifact", id: artifact.id };
        await alice.updateArtifact(
            artifact.id,
            { title: "Q3 revenue" },
            { ifMatch: artifact.version },
        );
        const [artifactItem] = await entries(
            bob,
            artifactSubject,
            (items) => items[0]?.updates === 1,
        );
        expect(artifactItem!.latest).toEqual({ type: "artifact.updated", artifactVersion: 2 });
        expect((await bob.getArtifact(artifact.id)).artifact.title).toBe("Q3 revenue");

        // A bot's picture changes on the bot alone.
        const { bot } = await alice.createBot({ name: "Helper" });
        const botSubject = { type: "bot", id: bot.id };
        const [botItem] = await entries(bob, botSubject, (items) => items.length === 1);
        const pictured = await alice.setBotAvatar(
            bot.id,
            { contentType: "image/png", data: PNG_1X1 },
            { ifMatch: bot.version },
        );
        expect(pictured.bot.avatar).not.toBeNull();
        expect(await entries(bob, botSubject, () => true)).toEqual([botItem]);

        // Every Feed payload either person can read is references, counts, and times.
        const seen = await bob.markFeedSeen({
            subjects: [taskSubject, listSubject, artifactSubject, botSubject],
        });
        expect(seen.items).toHaveLength(4);
        const feedEvents = async (client: HappyAgentClient, after: string) =>
            (await client.getEvents({ after, limit: 1000 })).events.filter(
                (event: HappyAgentEvent) => event.type.startsWith("feed."),
            );
        const payloads = [
            await bob.getFeed({ limit: 200 }),
            await alice.getFeed({ limit: 200 }),
            seen,
            await bob.listFeedClusters(),
            await bob.peekFeedCluster("*", { limit: 200 }),
            await bob.peekFeedCluster(`task:${task.id}`),
            await bob.peekFeedCluster(`surface:${surface.id}`),
            await bob.subscribeFeedCluster(`bot:${bot.id}`),
            await bob.muteFeedCluster(`surface:${surface.id}`),
            ...(await feedEvents(bob, bobStart)).map((event) => event.payload),
            ...(await feedEvents(alice, aliceStart)).map((event) => event.payload),
        ];
        expect([...keysOf(payloads)].filter((key) => !REFERENCE_KEYS.has(key))).toEqual([]);
        const json = JSON.stringify(payloads);
        for (const data of [
            "New Task",
            "Audit billing exports",
            "Billing",
            "Shopping",
            "milk",
            "Q3",
            "Helper",
            "Alice",
            "Bob",
            "Chief of Staff",
            "markdown",
            '"todo"',
            '"document"',
        ])
            expect(json).not.toContain(data);
        // An agent appears only as an actor: the task's and bot's own entries, made by Alice, no
        // longer carry the agent that opens their chat.
        const own = JSON.stringify(
            (await bob.getFeed({ limit: 200 })).items.filter(
                (item) => item.subject.id === task.id || item.subject.id === bot.id,
            ),
        );
        expect(own).not.toContain(task.agent.id);
        expect(own).not.toContain(bot.agent.id);
        // Naming, renaming, the todo's edit, and the picture moved no entry: only the new todo and
        // the new artifact version folded into Bob's open entries.
        const folded = (await feedEvents(bob, bobStart))
            .filter((event) => event.type === "feed.item.updated")
            .map((event) => (event.payload as { item: FeedItem }).item)
            .filter((item) => item.seenAt === null)
            .map((item) => item.subject.id);
        expect(folded).toEqual([surface.id, artifact.id]);
        expect(gym.errors).toEqual([]);
    });
});
