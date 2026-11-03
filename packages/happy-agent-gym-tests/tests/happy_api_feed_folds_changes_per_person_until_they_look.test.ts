import type {
    FeedItem,
    FeedSubject,
    HappyAgentClient,
    HappyAgentEvent,
} from "@slopus/happy-agent-client";
import { runGymSql, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A team with a task whose agent runs exactly the tool calls a scenario asks for. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const team = await surfaceTeamClients({
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
    const { gym, alice } = team;
    running.add(gym);
    const task = (await alice.createTask({ name: "Launch page" })).task;
    let count = 0;
    /** The task's agent calls one tool on Alice's behalf. */
    async function agentCall(name: string, args: Record<string, unknown>) {
        const callId = `feed_call_${String(++count)}`;
        commands.set(task.agent.id, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: task.agent.id,
            permissionMode: "full_access",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    /** Wait until the reader's entries for a subject satisfy a check, newest first. */
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
    return { ...team, task, agentCall, entries };
}

function feedEvents(events: readonly HappyAgentEvent[]) {
    return events.filter((event) => event.type.startsWith("feed."));
}

describe("the feed", () => {
    it("folds changes for someone who never looks and splits them for someone who looks each time", async () => {
        const { gym, alice, bob, aliceId, agentCall, entries } = await harness();
        const { surface } = await alice.createSurface({ type: "todo", name: "Shopping" });
        const subject = { type: "surface", id: surface.id };
        // Alice created it herself, so her entry is already seen; Bob's is new.
        const [aliceCreated] = await entries(alice, subject, (items) => items.length === 1);
        expect(aliceCreated).toMatchObject({ created: true, updates: 0 });
        expect(aliceCreated!.seenAt).not.toBeNull();
        const [bobCreated] = await entries(bob, subject, (items) => items.length === 1);
        expect(bobCreated).toMatchObject({
            created: true,
            updates: 0,
            seenAt: null,
            cluster: `surface:${surface.id}`,
            actors: [{ userId: aliceId, agentId: null }],
            snapshot: { title: "Shopping", surfaceType: "todo" },
        });

        const bobBefore = (await bob.getEvents()).latestCursor;
        for (const text of ["Milk", "Eggs", "Bread"]) {
            const seen = (await entries(alice, subject, () => true)).length;
            await agentCall("create_todo", { surfaceId: surface.id, text, authorUserId: null });
            const [open] = await entries(alice, subject, (items) => items.length === seen + 1);
            expect(open).toMatchObject({ created: false, updates: 1, seenAt: null });
            // The agent acted for Alice, but she has not looked at it yet.
            expect(open!.actors).toEqual([{ userId: aliceId, agentId: expect.any(String) }]);
            const { items, unread } = await alice.markFeedSeen({
                subjects: [{ ...subject, through: open!.cursor }],
            });
            expect(items.map((item) => item.id)).toEqual([open!.id]);
            expect(unread).toBe(0);
        }

        const aliceItems = await entries(alice, subject, (items) => items.length === 4);
        expect(aliceItems.every((item) => item.seenAt !== null)).toBe(true);
        const [bobItem] = await entries(
            bob,
            subject,
            (items) => items.length === 1 && items[0]!.updates === 3,
        );
        // One entry under the same identity, moved up, with the newest todo as its detail.
        expect(bobItem).toMatchObject({
            id: bobCreated!.id,
            created: true,
            updates: 3,
            seenAt: null,
            actorCount: 2,
            snapshot: { title: "Shopping", surfaceType: "todo", detail: "Bread" },
        });
        expect(bobItem!.cursor > bobCreated!.cursor).toBe(true);
        expect(bobItem!.version > bobCreated!.version).toBe(true);
        expect((await bob.getFeed()).items[0]!.id).toBe(bobItem!.id);

        // Bob's copies of those changes reached Bob alone.
        const bobEvents = feedEvents(
            (await bob.getEvents({ after: bobBefore, limit: 1000 })).events,
        );
        expect(bobEvents.map((event) => event.type)).toEqual([
            "feed.item.updated",
            "feed.item.updated",
            "feed.item.updated",
        ]);
        const aliceEvents = feedEvents(
            (await alice.getEvents({ after: bobBefore, limit: 1000 })).events,
        );
        expect(
            aliceEvents.some(
                (event) =>
                    event.type !== "feed.unread.updated" &&
                    (event.payload as { item?: FeedItem }).item?.id === bobItem!.id,
            ),
        ).toBe(false);

        // A change that arrives after what Bob was shown keeps his entry open.
        await agentCall("create_todo", { surfaceId: surface.id, text: "Tea", authorUserId: null });
        await entries(bob, subject, (items) => items[0]?.updates === 4);
        const stale = await bob.markFeedSeen({
            subjects: [{ ...subject, through: bobItem!.cursor }],
        });
        expect(stale.items).toEqual([]);
        expect(stale.unread).toBeGreaterThan(0);
        expect(gym.errors).toEqual([]);
    });

    it("counts a person's own change as seen and an agent's change for them as unread", async () => {
        const { gym, alice, bob, aliceId, agentCall, entries } = await harness();
        const { artifact } = await alice.createArtifact({
            type: "markdown",
            title: "Q3 report",
            files: [{ path: "index.md", text: "# Q3\n" }],
        });
        const subject = { type: "artifact", id: artifact.id };
        const [own] = await entries(alice, subject, (items) => items.length === 1);
        expect(own).toMatchObject({ created: true, actors: [{ userId: aliceId, agentId: null }] });
        expect(own!.seenAt).not.toBeNull();
        await entries(bob, subject, (items) => items[0]?.seenAt === null);

        // An agent's todo on Alice's behalf opens an unread entry for her.
        const { surface } = await alice.createSurface({ type: "todo", name: "Errands" });
        const list = { type: "surface", id: surface.id };
        await entries(alice, list, (items) => items.length === 1);
        await agentCall("create_todo", { surfaceId: surface.id, text: "Post", authorUserId: null });
        const [open] = await entries(alice, list, (items) => items[0]?.seenAt === null);
        expect((await alice.getDesktopBootstrap()).feedUnread).toBe(1);

        // Her own todo closes that entry and folds into it.
        await alice.createTodo(surface.id, { text: "Bank" });
        const [closed] = await entries(alice, list, (items) => items[0]?.seenAt !== null);
        expect(closed).toMatchObject({ id: open!.id, updates: 2 });
        expect((await alice.getFeed()).unread).toBe(0);
        // Her own artifact version folds into her seen entry instead of adding one.
        await alice.updateArtifact(
            artifact.id,
            { files: [{ path: "index.md", text: "# Q3, revised\n" }] },
            { ifMatch: artifact.version },
        );
        const mine = await entries(alice, subject, (items) => items[0]?.updates === 1);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.seenAt).not.toBeNull();
        expect(mine[0]!.snapshot).toMatchObject({ artifactType: "markdown", artifactVersion: 2 });
        expect(gym.errors).toEqual([]);
    });

    it("folds a document's edits into one session per actor", async () => {
        const { gym, alice, bob, agentCall, entries } = await harness();
        const { surface } = await alice.createSurface({
            type: "document",
            name: "Plan",
            text: "# Plan\n",
        });
        const subject = { type: "surface", id: surface.id };
        await entries(bob, subject, (items) => items.length === 1);
        await agentCall("update_document", {
            surfaceId: surface.id,
            seq: 1,
            text: "# Plan\n\nOne\n",
        });
        await agentCall("update_document", {
            surfaceId: surface.id,
            seq: 2,
            text: "# Plan\n\nOne\n\nTwo\n",
        });
        const [item] = await entries(bob, subject, (items) => items[0]?.updates === 1);
        expect(item).toMatchObject({ created: true, updates: 1, actorCount: 2 });
        expect(JSON.stringify(await alice.getSurfaceDocument(surface.id))).toContain("Two");
        // The second edit, within the same session, added nothing more.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await entries(bob, subject, () => true))[0]!.updates).toBe(1);
        expect(gym.errors).toEqual([]);
    });

    it("seeds a new member with seen history and marks tasks seen through the read routes", async () => {
        const { gym, alice, task, clientFor, onboard, entries } = await harness();
        await alice.createSurface({ type: "todo", name: "Before Carol" });
        await entries(alice, { type: "task", id: task.id }, (items) => items.length === 1);

        const carol = clientFor("carol");
        await onboard(carol, "Carol");
        const { items, unread } = await carol.getFeed();
        // The installation's built-in Chief of Staff bot is part of the history too.
        expect(items.map((item) => item.snapshot.title)).toEqual([
            "Before Carol",
            "Launch page",
            "Chief of Staff",
        ]);
        expect(items.every((item) => item.seenAt !== null)).toBe(true);
        expect(unread).toBe(0);
        expect((await carol.getDesktopBootstrap()).feedUnread).toBe(0);

        // What happens after she joined is new to her, and opening the task's chat sees it.
        const { task: next } = await alice.createTask({ name: "After Carol" });
        const [fresh] = await entries(
            carol,
            { type: "task", id: next.id },
            (found) => found.length === 1,
        );
        expect(fresh).toMatchObject({ seenAt: null, snapshot: { agentId: next.agent.id } });
        await carol.markAgentRead(next.agent.id);
        await entries(carol, { type: "task", id: next.id }, (found) => found[0]?.seenAt !== null);
        expect((await carol.getFeed()).unread).toBe(0);

        const bot = (await alice.createBot({ name: "Helper" })).bot;
        await entries(carol, { type: "bot", id: bot.id }, (found) => found[0]?.seenAt === null);
        await carol.markAgentRead(bot.agent.id);
        await entries(carol, { type: "bot", id: bot.id }, (found) => found[0]?.seenAt !== null);
        expect(gym.errors).toEqual([]);
    });

    it("mutes and subscribes clusters, peeks without writing, and reads all", async () => {
        const { gym, alice, bob, task, agentCall, entries } = await harness();
        const { surface } = await alice.createSurface({ type: "todo", name: "Groceries" });
        const list = { type: "surface", id: surface.id };
        await entries(bob, list, (items) => items.length === 1);

        const muted = await bob.muteFeedCluster(`surface:${surface.id}`);
        expect(muted.cluster).toMatchObject({ kind: "surface", name: "Groceries", state: "muted" });
        await agentCall("create_todo", {
            surfaceId: surface.id,
            text: "Apples",
            authorUserId: null,
        });
        await entries(alice, list, (items) => items[0]?.updates === 1);
        expect((await entries(bob, list, () => true))[0]!.updates).toBe(0);

        // Peeking reads the shared history without touching Bob's feed.
        const peek = await bob.peekFeedCluster(`surface:${surface.id}`);
        expect(peek.entries).toEqual([
            expect.objectContaining({ subject: list, created: true, updates: 1 }),
        ]);
        expect((await entries(bob, list, () => true))[0]!.updates).toBe(0);

        // With everything muted, only clusters he subscribed to reach him; subscribing seeds.
        await bob.muteFeedCluster("*");
        const { task: quiet } = await alice.createTask({ name: "Quiet task" });
        await entries(alice, { type: "task", id: quiet.id }, (items) => items.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(
            (await bob.getFeed({ limit: 200 })).items.some((item) => item.subject.id === quiet.id),
        ).toBe(false);
        const subscribed = await bob.subscribeFeedCluster(`task:${quiet.id}`);
        expect(subscribed.cluster).toMatchObject({ kind: "task", state: "subscribed" });
        const [seeded] = await entries(
            bob,
            { type: "task", id: quiet.id },
            (items) => items.length === 1,
        );
        expect(seeded!.seenAt).not.toBeNull();

        const { clusters } = await bob.listFeedClusters();
        expect(clusters.slice(0, 2).map((cluster) => cluster.cluster)).toEqual(["*", "team"]);
        expect(clusters[0]).toMatchObject({ kind: "everything", state: "muted" });
        expect(clusters.find((cluster) => cluster.cluster === `task:${task.id}`)).toMatchObject({
            name: "Launch page",
            state: null,
        });

        await bob.subscribeFeedCluster("*");
        expect((await bob.getFeed()).unread).toBeGreaterThan(0);
        expect(await bob.markFeedReadAll()).toEqual({ unread: 0 });
        expect((await bob.getFeed()).items.every((item) => item.seenAt !== null)).toBe(true);
        expect(gym.errors).toEqual([]);
    });

    it("refuses malformed and unknown clusters and pages the feed", async () => {
        const { gym, alice, bob, tokenFor, entries } = await harness();
        for (const name of ["Errands 1", "Errands 2", "Errands 3"]) {
            const { surface } = await alice.createSurface({ type: "todo", name });
            await entries(bob, { type: "surface", id: surface.id }, (items) => items.length === 1);
        }
        const all = (await bob.getFeed({ limit: 200 })).items;
        const first = await bob.getFeed({ limit: 2 });
        expect(first.items).toEqual(all.slice(0, 2));
        expect(first.hasMore).toBe(true);
        const second = await bob.getFeed({ before: first.items[1]!.cursor, limit: 200 });
        expect(second.items).toEqual(all.slice(2));
        expect(second.hasMore).toBe(false);
        expect(all.slice(0, 4).map((item) => item.snapshot.title)).toEqual([
            "Errands 3",
            "Errands 2",
            "Errands 1",
            "Launch page",
        ]);

        const call = async (method: string, path: string) =>
            (
                await fetch(new URL(path, gym.daemon.httpUrl), {
                    method,
                    headers: { authorization: `Bearer ${tokenFor("bob")}` },
                })
            ).status;
        expect(await call("PUT", "/v0/feed/subscriptions/nonsense")).toBe(400);
        expect(await call("PUT", "/v0/feed/subscriptions/task%3Azzzzzzzzzzzzzzzzzzzzzzzz")).toBe(
            404,
        );
        expect(await call("GET", "/v0/feed?before=not-a-cursor")).toBe(400);
        expect(await call("GET", "/v0/feed?limit=500")).toBe(400);
        expect((await alice.getHealth()).capabilities?.feed).toBe(true);
        expect(gym.errors).toEqual([]);
    });

    it("keeps restricted changes out of seeding and peeking", async () => {
        const { gym, alice, bob, aliceId, clientFor, onboard } = await harness();
        const changeId = "01900000-0000-7000-8000-000000000001";
        const record = {
            id: changeId,
            subject: { type: "task", id: "zprivatetask00000000000a" },
            verb: "task.created",
            clusters: ["team", "task:zprivatetask00000000000a"],
            audience: { kind: "users", userIds: [aliceId] },
            actor: { userId: aliceId, agentId: null },
            snapshot: { title: "Only for Alice" },
            occurredAt: Date.now(),
        };
        await gym.restart({
            whileStopped: async () =>
                await runGymSql(gym.happyHome, [
                    `INSERT INTO happy_agent_feed_changes (id, subject_type, subject_id, occurred_at, audience_users, record) VALUES ('${changeId}', 'task', 'zprivatetask00000000000a', ${String(record.occurredAt)}, '${JSON.stringify([aliceId])}', '${JSON.stringify(record).replaceAll("'", "''")}')`,
                    `INSERT INTO happy_agent_feed_change_clusters (cluster, change_id) VALUES ('team', '${changeId}')`,
                ]),
        });
        const titles = async (client: HappyAgentClient) =>
            (await client.peekFeedCluster("team")).entries.map((entry) => entry.snapshot.title);
        expect(await titles(alice)).toContain("Only for Alice");
        expect(await titles(bob)).not.toContain("Only for Alice");

        const carol = clientFor("carol");
        await onboard(carol, "Carol");
        const seeded = (await carol.getFeed()).items.map((item) => item.snapshot.title);
        expect(seeded).toContain("Launch page");
        expect(seeded).not.toContain("Only for Alice");
        expect(gym.errors).toEqual([]);
    });
});
