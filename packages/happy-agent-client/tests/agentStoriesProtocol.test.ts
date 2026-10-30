import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { agentSchema } from "../sources/protocol/agents.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    createStoryRequestSchema,
    repostStoryRequestSchema,
    storyEndedPayloadSchema,
    storyFeedbackRequestSchema,
    storyFeedResponseSchema,
    storySchema,
    storySeenPayloadSchema,
    updateStoryRequestSchema,
    type Story,
} from "../sources/protocol/stories.js";

const transform = { x: 0.5, y: 0.5, scale: 0.8, rotation: 0 };

const agentStory: Story = {
    id: "s5g6h7j8k9l0z1x2c3v4b5n6",
    status: "posted",
    authorUserId: "u1x2y3z4a5b6c7d8e9f0g1h2",
    createdBy: { kind: "agent", agentId: "a9b8c7d6e5f4g3h2i1j0k9l8" },
    source: { agentId: "a9b8c7d6e5f4g3h2i1j0k9l8", toolCallId: "c3v5b7n9m1q2w4e6r8t0y2u4" },
    author: { kind: "agent", agentId: "a9b8c7d6e5f4g3h2i1j0k9l8" },
    ringAgentId: "r1t2y3u4i5o6p7a8s9d0f1g2",
    supersedes: ["s7k2m9q4w1e5t8y3u6i0o2p5"],
    endedAt: null,
    endReason: null,
    repostOf: null,
    caption: "Focus's ideas, right where they apply",
    frames: [
        {
            id: "f1a2b3c4d5e6f7g8h9i0j1k2",
            kind: "artifact",
            width: null,
            height: null,
            thumbhash: null,
            durationMs: null,
            asset: { type: "artifact", artifactId: "x1c2v3b4n5m6q7w8e9r0t1y2" },
            available: true,
            placement: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
            background: ["#000000", "#000000"],
            overlays: [
                {
                    id: "o4r5t6y7u8i9o0p1a2s3d4f5",
                    type: "artifact",
                    artifactId: "x1c2v3b4n5m6q7w8e9r0t1y2",
                    version: 3,
                    aspectRatio: 0.8,
                    transform,
                },
                {
                    id: "o9p8i7u6y5t4r3e2w1q0a9s8",
                    type: "round_video",
                    media: {
                        type: "artifact_file",
                        artifactId: "s5g6h7j8k9l0z1x2c3v4b5n6",
                        version: 2,
                        path: "media/o9p8i7u6y5t4r3e2w1q0a9s8.mp4",
                    },
                    durationMs: 12_000,
                    mirrored: true,
                    transform: { x: 0.2, y: 0.8, scale: 0.3, rotation: 0 },
                },
            ],
        },
    ],
    audience: "team",
    artifactVersion: 1,
    createdAt: 1755300000000,
    updatedAt: 1755300000000,
    postedAt: 1755300000000,
    expiresAt: null,
    seen: false,
    viewCount: null,
    myReaction: null,
    reactions: [],
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
};

describe("agent stories protocol", () => {
    it("accepts an agent's story with an artifact frame, artifact window, and round video", () => {
        expect(Value.Errors(storySchema, agentStory).First()).toBeUndefined();
    });

    it("still accepts a story from a daemon that predates agent stories", () => {
        const older: Record<string, unknown> = { ...agentStory };
        for (const key of ["author", "ringAgentId", "supersedes", "endedAt", "endReason"]) {
            delete older[key];
        }
        delete older["repostOf"];
        older["frames"] = [
            {
                ...agentStory.frames[0],
                kind: "image",
                asset: {
                    type: "chat_media",
                    agentId: "a9b8c7d6e5f4g3h2i1j0k9l8",
                    toolCallId: "k8j7h6g5f4d3s2a1q0w9e8r7",
                    index: 0,
                },
                overlays: [],
            },
        ];
        expect(Value.Check(storySchema, older)).toBe(true);
    });

    it("carries the repost chip's title and whether the caller may open it", () => {
        const repost = {
            ...agentStory,
            id: "s2w4e6r8t0y2u4i6o8p0a2s4",
            status: "draft",
            author: { kind: "user", userId: "u1x2y3z4a5b6c7d8e9f0g1h2" },
            ringAgentId: null,
            supersedes: [],
            postedAt: null,
            repostOf: {
                storyId: agentStory.id,
                agentId: "a9b8c7d6e5f4g3h2i1j0k9l8",
                title: "Inline sidebar diffs",
                canOpen: true,
            },
        };
        expect(Value.Errors(storySchema, repost).First()).toBeUndefined();
    });

    it("writes a round video as a new upload or keeps the one it read", () => {
        const frame = {
            id: "f1a2b3c4d5e6f7g8h9i0j1k2",
            overlays: [
                {
                    id: "o9p8i7u6y5t4r3e2w1q0a9s8",
                    type: "round_video",
                    media: {
                        type: "upload",
                        uploadId: "u8p2l4o6a1d3e5f7g9h0j2k4",
                        name: "circle.webm",
                    },
                    durationMs: 4_000,
                    transform,
                },
            ],
        };
        expect(Value.Check(updateStoryRequestSchema, { frames: [frame] })).toBe(true);
        const kept = agentStory.frames[0]?.overlays[1];
        expect(
            Value.Check(updateStoryRequestSchema, { frames: [{ ...frame, overlays: [kept] }] }),
        ).toBe(true);
        expect(
            Value.Check(createStoryRequestSchema, {
                frames: [{ asset: { type: "artifact", artifactId: "x1c2v3b4n5m6q7w8e9r0t1y2" } }],
            }),
        ).toBe(true);
    });

    it("lists rings beside authors in the feed", () => {
        const feed = {
            authors: [
                {
                    userId: null,
                    name: "Me",
                    photo: null,
                    thumbhash: null,
                    isSelf: true,
                    storyIds: [],
                    unseenCount: 0,
                    draftCount: 0,
                    latestPostedAt: null,
                },
            ],
            rings: [
                {
                    agentId: "r1t2y3u4i5o6p7a8s9d0f1g2",
                    storyIds: [agentStory.id],
                    unseenCount: 1,
                    latestPostedAt: 1755300000000,
                },
            ],
            stories: { [agentStory.id]: agentStory },
            cursor: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        };
        expect(Value.Errors(storyFeedResponseSchema, feed).First()).toBeUndefined();
    });

    it("describes story.ended and a ring's seen mark", () => {
        expect(
            Value.Check(storyEndedPayloadSchema, {
                storyId: agentStory.id,
                version: agentStory.version,
                ringAgentId: "r1t2y3u4i5o6p7a8s9d0f1g2",
                endedAt: 1755400000000,
                endReason: "superseded",
                story: { ...agentStory, endedAt: 1755400000000, endReason: "superseded" },
            }),
        ).toBe(true);
        expect(
            Value.Check(storySeenPayloadSchema, {
                authorUserId: null,
                storyId: agentStory.id,
                ringAgentId: "r1t2y3u4i5o6p7a8s9d0f1g2",
            }),
        ).toBe(true);
    });

    it("bounds feedback and accepts an empty repost request", () => {
        expect(Value.Check(repostStoryRequestSchema, {})).toBe(true);
        expect(Value.Check(storyFeedbackRequestSchema, { text: "Make it red" })).toBe(true);
        expect(Value.Check(storyFeedbackRequestSchema, { text: "" })).toBe(false);
    });

    it("reports agentStories in health and statusLine on agents", () => {
        expect(
            Value.Check(healthResponseSchema, {
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 22, daemon: "1.2.3" },
                capabilities: { agentStories: true },
            }),
        ).toBe(true);
        const agent = {
            id: "a9b8c7d6e5f4g3h2i1j0k9l8",
            workspaceId: "w5v4u3t2s1r0q9p8o7n6m5l4",
            parentAgentId: null,
            title: "Stories",
            titleStatus: "ready",
            status: "idle",
            statusLine: { text: "Testing with a few friends", updatedAt: 1755400000000 },
            subagents: { total: 0, running: 0 },
            processes: { running: 0 },
            pendingQuestionId: null,
            unread: null,
            orderKey: "5",
            lastCursor: "01991f3a-5f4d-7000-8000-6d3e5f708192",
            version: "01991f3a-5f4d-7000-8000-6d3e5f708192",
            createdAt: 1755300000000,
            updatedAt: 1755400000000,
            archivedAt: null,
        };
        expect(Value.Errors(agentSchema, agent).First()).toBeUndefined();
        const withText = (text: string) =>
            Value.Check(agentSchema, { ...agent, statusLine: { text, updatedAt: 1 } });
        expect(withText("1. Ship new onboarding\n2. Submit iOS native build")).toBe(true);
        expect(withText("one\ntwo\nthree")).toBe(false);
        expect(withText("one\n")).toBe(false);
        expect(withText("\ntwo")).toBe(false);
        expect(withText("one\r\ntwo")).toBe(false);
        expect(withText("one\rtwo")).toBe(false);
    });

    it("sends repost and feedback to their routes", async () => {
        const requests: { url: string; method: string; body: unknown }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://daemon.test",
            token: "token",
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                requests.push({
                    url: String(input),
                    method: init?.method ?? "GET",
                    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
                });
                const body = String(input).endsWith("/feedback")
                    ? { agentId: "a9b8c7d6e5f4g3h2i1j0k9l8", messageId: "m6n8b0v2c4x6z8l0k2j4h6g8" }
                    : { story: agentStory };
                return new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        });
        await client.repostStory(agentStory.id, { id: "s2w4e6r8t0y2u4i6o8p0a2s4" });
        await client.sendStoryFeedback(agentStory.id, {
            frameId: "f1a2b3c4d5e6f7g8h9i0j1k2",
            text: "Make it red",
        });
        expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
            `POST http://daemon.test/v0/stories/${agentStory.id}/repost`,
            `POST http://daemon.test/v0/stories/${agentStory.id}/feedback`,
        ]);
        expect(requests[1]?.body).toEqual({
            frameId: "f1a2b3c4d5e6f7g8h9i0j1k2",
            text: "Make it red",
        });
        expect(client.storyOverlayMediaUrl(agentStory.id, "o9p8i7u6y5t4r3e2w1q0a9s8")).toBe(
            `http://daemon.test/v0/stories/${agentStory.id}/overlays/o9p8i7u6y5t4r3e2w1q0a9s8/media`,
        );
    });
});
