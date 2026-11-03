import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    desktopBootstrapResponseSchema,
    feedClustersResponseSchema,
    feedItemCreatedPayloadSchema,
    feedItemRemovedPayloadSchema,
    feedItemSchema,
    feedPeekResponseSchema,
    feedReadAllRequestSchema,
    feedResponseSchema,
    feedSeenRequestSchema,
    feedUnreadUpdatedPayloadSchema,
    healthResponseSchema,
    type FeedItem,
    type HappyAgentEvent,
} from "../sources/index.js";

const cursor = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const itemCursor = "01991f3b-09f2-7000-8000-7a6b5c4d3e2f";

const item: FeedItem = {
    id: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    version: "01991f3b-0a1c-7000-8000-1b2c3d4e5f60",
    cursor: itemCursor,
    subject: { type: "artifact", id: "r7k2m9q4w1e5t8y3u6i0o2p5" },
    cluster: "task:t4k8m2q9w1e5r7y3u6i0o2p4",
    created: true,
    updates: 49,
    actors: [
        { userId: null, agentId: "a9b8c7d6e5f4g3h2i1j0k9l8" },
        { userId: "u1x2y3z4a5b6c7d8e9f0g1h2", agentId: null },
    ],
    actorCount: 2,
    snapshot: {
        title: "Q3 revenue report",
        agentId: "a9b8c7d6e5f4g3h2i1j0k9l8",
        artifactType: "markdown",
        artifactVersion: 50,
    },
    firstAt: 1_755_300_000_000,
    lastAt: 1_755_400_000_000,
    seenAt: null,
};

function recordingClient(body: unknown) {
    const requests: { method: string; url: string; body: string | null }[] = [];
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        token: "t",
        fetch: async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return Response.json(body);
        },
    });
    return { client, requests };
}

describe("feed protocol", () => {
    it("describes the specified feed item, response, and events", () => {
        expect(Value.Check(feedItemSchema, item)).toBe(true);
        expect(
            Value.Check(feedItemSchema, {
                ...item,
                subject: { type: "surface", id: "s4k8m2q9w1e5r7y3u6i0o2p4" },
                snapshot: { title: "Shopping", surfaceType: "todo", detail: "Buy milk" },
                seenAt: 1_755_400_000_001,
            }),
        ).toBe(true);
        // Shapes grow: unknown subject types and snapshot fields stay readable.
        expect(
            Value.Check(feedItemSchema, {
                ...item,
                subject: { type: "calendar_event", id: "x" },
                snapshot: { title: "Later", somethingNew: true },
            }),
        ).toBe(true);
        expect(
            Value.Check(feedItemSchema, { ...item, actors: Array(6).fill(item.actors[0]) }),
        ).toBe(false);
        expect(
            Value.Check(feedResponseSchema, { items: [item], unread: 3, hasMore: true, cursor }),
        ).toBe(true);
        expect(Value.Check(feedItemCreatedPayloadSchema, { item, mutationId: "m1" })).toBe(true);
        expect(Value.Check(feedItemRemovedPayloadSchema, { itemId: item.id })).toBe(true);
        expect(Value.Check(feedUnreadUpdatedPayloadSchema, { unread: 0 })).toBe(true);
        expect(Value.Check(feedUnreadUpdatedPayloadSchema, { unread: -1 })).toBe(false);

        const events: HappyAgentEvent[] = [
            { cursor, type: "feed.item.created", occurredAt: 1, payload: { item } },
            { cursor, type: "feed.item.updated", occurredAt: 1, payload: { item } },
            { cursor, type: "feed.item.removed", occurredAt: 1, payload: { itemId: item.id } },
            { cursor, type: "feed.unread.updated", occurredAt: 1, payload: { unread: 2 } },
        ];
        expect(events.map((event) => event.type)).toHaveLength(4);
    });

    it("peeks entries without anyone's seen state, and lists clusters", () => {
        const { id: _id, version: _version, seenAt: _seenAt, ...entry } = item;
        const cluster = {
            cluster: "*",
            kind: "everything",
            name: "Everything",
            state: "subscribed",
            lastAt: null,
        };
        expect(Value.Check(feedPeekResponseSchema, { cluster, entries: [entry] })).toBe(true);
        const team = { cluster: "team", kind: "team", name: "Team", state: null, lastAt: 1 };
        const task = { ...team, cluster: "task:t1", kind: "task", name: "Fix it", state: "muted" };
        expect(Value.Check(feedClustersResponseSchema, { clusters: [cluster, team, task] })).toBe(
            true,
        );
        expect(
            Value.Check(feedClustersResponseSchema, { clusters: [{ ...task, state: "maybe" }] }),
        ).toBe(false);
    });

    it("validates seen and read-all requests", () => {
        expect(
            Value.Check(feedSeenRequestSchema, {
                subjects: [{ type: "task", id: "t4k8", through: itemCursor }],
                mutationId: "m",
            }),
        ).toBe(true);
        expect(Value.Check(feedSeenRequestSchema, { subjects: [] })).toBe(false);
        expect(
            Value.Check(feedSeenRequestSchema, {
                subjects: Array(101).fill({ type: "task", id: "t" }),
            }),
        ).toBe(false);
        expect(
            Value.Check(feedSeenRequestSchema, {
                subjects: [{ type: "task", id: "t", through: "not-a-cursor" }],
            }),
        ).toBe(false);
        expect(
            Value.Check(feedSeenRequestSchema, { subjects: [{ type: "task", id: "t", extra: 1 }] }),
        ).toBe(false);
        expect(Value.Check(feedReadAllRequestSchema, {})).toBe(true);
        expect(Value.Check(feedReadAllRequestSchema, { through: itemCursor })).toBe(true);
    });

    it("carries the capability and the bootstrap badge as optional additions", () => {
        const health = {
            healthy: true,
            ready: true,
            status: "ready",
            version: { protocol: 33, daemon: "1.0.0" },
        };
        expect(Value.Check(healthResponseSchema, health)).toBe(true);
        expect(Value.Check(healthResponseSchema, { ...health, capabilities: { feed: true } })).toBe(
            true,
        );
        const schema = desktopBootstrapResponseSchema.properties.feedUnread;
        expect(Value.Check(schema, 3)).toBe(true);
        expect(Value.Check(schema, -1)).toBe(false);
        expect(desktopBootstrapResponseSchema.required).not.toContain("feedUnread");
    });

    it("pages the feed", async () => {
        const { client, requests } = recordingClient({
            items: [],
            unread: 0,
            hasMore: false,
            cursor,
        });
        await client.getFeed();
        await client.getFeed({ before: itemCursor, limit: 20 });
        expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
            "GET http://agent.local/v0/feed",
            `GET http://agent.local/v0/feed?before=${itemCursor}&limit=20`,
        ]);
    });

    it("marks subjects seen and everything read", async () => {
        const { client, requests } = recordingClient({ items: [], unread: 0 });
        await client.markFeedSeen({
            subjects: [{ type: "surface", id: "s1", through: itemCursor }],
            mutationId: "m",
        });
        await client.markFeedReadAll();
        await client.markFeedReadAll({ through: itemCursor });
        expect(requests).toEqual([
            {
                method: "POST",
                url: "http://agent.local/v0/feed/seen",
                body: JSON.stringify({
                    subjects: [{ type: "surface", id: "s1", through: itemCursor }],
                    mutationId: "m",
                }),
            },
            { method: "POST", url: "http://agent.local/v0/feed/read-all", body: "{}" },
            {
                method: "POST",
                url: "http://agent.local/v0/feed/read-all",
                body: JSON.stringify({ through: itemCursor }),
            },
        ]);
    });

    it("encodes cluster names as one path segment", async () => {
        const { client, requests } = recordingClient({ cluster: {}, entries: [], clusters: [] });
        await client.listFeedClusters();
        await client.subscribeFeedCluster("task:t4k8m2q9w1e5r7y3u6i0o2p4");
        await client.muteFeedCluster("*", { mutationId: "m" });
        await client.peekFeedCluster("team", { limit: 10 });
        await client.peekFeedCluster("workspace:w1");
        expect(requests).toEqual([
            { method: "GET", url: "http://agent.local/v0/feed/clusters", body: null },
            {
                method: "PUT",
                url: "http://agent.local/v0/feed/subscriptions/task%3At4k8m2q9w1e5r7y3u6i0o2p4",
                body: "{}",
            },
            {
                method: "DELETE",
                url: "http://agent.local/v0/feed/subscriptions/%2A",
                body: JSON.stringify({ mutationId: "m" }),
            },
            { method: "GET", url: "http://agent.local/v0/feed/clusters/team?limit=10", body: null },
            {
                method: "GET",
                url: "http://agent.local/v0/feed/clusters/workspace%3Aw1",
                body: null,
            },
        ]);
    });
});
