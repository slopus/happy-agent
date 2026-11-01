import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    storyLayersSchema,
    storySchema,
    storyMetadataSchema,
    storyReplyRequestSchema,
    storyRepostRequestSchema,
} from "../sources/protocol/stories.js";

describe("story uploads", () => {
    it("shares the bounded upload, repost, and reply contract with the daemon", () => {
        expect(Value.Check(storyMetadataSchema, { caption: "Ready" })).toBe(true);
        expect(Value.Check(storyRepostRequestSchema, { round: { data: "AAAA" } })).toBe(true);
        expect(Value.Check(storyReplyRequestSchema, { text: "Nice work" })).toBe(true);
        for (const body of [{ caption: "" }, { caption: "x".repeat(201) }, { round: {} }])
            expect(Value.Check(storyMetadataSchema, body)).toBe(false);
        for (const body of [
            { round: { data: "" } },
            { round: { data: "AAAA", extra: true } },
            { extra: true },
        ])
            expect(Value.Check(storyRepostRequestSchema, body)).toBe(false);
        for (const body of [{ text: "" }, { text: "x".repeat(2001) }, { text: "Hi", extra: true }])
            expect(Value.Check(storyReplyRequestSchema, body)).toBe(false);
    });
    it("sends original media and a round as binary parts, keeping layers separate", async () => {
        const requests: Request[] = [];
        const client = new HappyAgentClient({
            endpoint: "https://agent.test",
            token: "test-token",
            fetch: async (input, init) => {
                expect(init?.body).toBeInstanceOf(ArrayBuffer);
                requests.push(new Request(input, init));
                return Response.json({ story: { id: "story" } });
            },
        });
        const layers = { text: { text: "Ready 👋", x: 0.4, y: 0.6 }, round: { x: 0.1, y: 0.2 } };
        const media = new Blob([new Uint8Array([0, 255, 42])], { type: "image/png" });
        const round = new Blob([new Uint8Array([1, 254, 43])], { type: "video/mp4" });
        await client.postStory(media, { layers, round });
        await client.repostStory("story", { layers, round });
        for (const [index, request] of requests.entries()) {
            expect(request.headers.get("authorization")).toBe("Bearer test-token");
            expect(request.headers.get("content-type")).toContain("multipart/form-data; boundary=");
            const form = await request.formData();
            expect(JSON.parse(form.get("metadata") as string)).toEqual({ layers });
            expect(await (form.get("round") as Blob).arrayBuffer()).toEqual(
                await round.arrayBuffer(),
            );
            expect(form.has("media")).toBe(index === 0);
            if (index === 0)
                expect(await (form.get("media") as Blob).arrayBuffer()).toEqual(
                    await media.arrayBuffer(),
                );
        }
        expect(new URL(requests[0]!.url).pathname).toBe("/v0/stories");
        expect(new URL(requests[1]!.url).pathname).toBe("/v0/stories/story/repost");
    });

    it("validates finite normalized layer centers and bounded text", () => {
        expect(Value.Check(storyLayersSchema, { text: { text: "Hi 👋", x: 0, y: 1 } })).toBe(true);
        for (const value of [
            { text: { text: "", x: 0.5, y: 0.5 } },
            { text: { text: "x".repeat(201), x: 0.5, y: 0.5 } },
            { round: { x: -0.1, y: 0.5 } },
            { round: { x: 0.1, y: 1.01 } },
            { round: { x: Number.NaN, y: 0.5 } },
            { round: { x: 0.1, y: Infinity } },
            { text: { text: "Hi", x: 0.1, y: 0.2, style: "bold" } },
            { unknown: {} },
        ])
            expect(Value.Check(storyLayersSchema, value)).toBe(false);
        expect(Value.Check(storySchema.properties.agentId, null)).toBe(true);
    });
});
