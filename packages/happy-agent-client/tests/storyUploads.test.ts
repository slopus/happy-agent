import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { desktopBootstrapResponseSchema } from "../sources/protocol/bootstrap.js";
import { botSchema } from "../sources/protocol/bots.js";
import { taskSchema } from "../sources/protocol/tasks.js";
import {
    storyCreateRequestSchema,
    storyLayersSchema,
    storyMediaLayerSchema,
    storySchema,
    storyMetadataSchema,
    storyReplyRequestSchema,
    storyRepostRequestSchema,
} from "../sources/protocol/stories.js";

describe("story uploads", () => {
    it("accepts optional bounded transforms without requiring them on existing layers", () => {
        for (const transform of [{}, { scale: 0.5, rotation: -180 }, { scale: 3, rotation: 180 }]) {
            expect(
                Value.Check(storyLayersSchema, {
                    text: { text: "Ready", x: 0.5, y: 0.5, ...transform },
                    round: { x: 0.5, y: 0.45, ...transform },
                }),
            ).toBe(true);
        }
        for (const transform of [
            { scale: 0.49 },
            { scale: 3.01 },
            { scale: Infinity },
            { scale: Number.NaN },
            { rotation: -181 },
            { rotation: 181 },
            { rotation: Infinity },
            { rotation: Number.NaN },
        ]) {
            expect(
                Value.Check(storyLayersSchema, { round: { x: 0.5, y: 0.5, ...transform } }),
            ).toBe(false);
            expect(
                Value.Check(storyLayersSchema, {
                    text: { text: "Ready", x: 0.5, y: 0.5, ...transform },
                }),
            ).toBe(false);
        }
    });

    it("adds the initial story feed and reader flag without requiring them from older daemons", () => {
        expect(desktopBootstrapResponseSchema.required).not.toContain("storiesEnabled");
        expect(desktopBootstrapResponseSchema.required).not.toContain("stories");
        expect(Value.Check(desktopBootstrapResponseSchema.properties.storiesEnabled, true)).toBe(
            true,
        );
        expect(Value.Check(desktopBootstrapResponseSchema.properties.storiesEnabled, "true")).toBe(
            false,
        );
        expect(Value.Check(desktopBootstrapResponseSchema.properties.stories, [])).toBe(true);
        expect(Value.Check(desktopBootstrapResponseSchema.properties.stories, [{}])).toBe(false);
    });

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

    it("expresses stored media layers with their own placement, and references uploads", () => {
        const layer = { uploadId: "u1", x: 0.5, y: 0.5, width: 0.4, aspect: 9 / 16 };
        const round = { ...layer, shape: "round", scale: 3, rotation: -180 };
        const body = { media: { uploadId: "u0" }, mediaLayers: [layer, round] };
        expect(Value.Check(storyCreateRequestSchema, body)).toBe(true);
        expect(Value.Check(storyRepostRequestSchema, { mediaLayers: [round] })).toBe(true);
        for (const bad of [
            { ...layer, width: 0 },
            { ...layer, width: 1.01 },
            { ...layer, aspect: 0.09 },
            { ...layer, aspect: 10.1 },
            { ...layer, shape: "star" },
            { ...layer, scale: 4 },
            { x: 0.5, y: 0.5, width: 0.4, aspect: 1 },
            { ...layer, extra: true },
        ])
            expect(Value.Check(storyCreateRequestSchema, { ...body, mediaLayers: [bad] })).toBe(
                false,
            );
        expect(
            Value.Check(storyCreateRequestSchema, { ...body, mediaLayers: Array(9).fill(layer) }),
        ).toBe(false);
        expect(Value.Check(storyCreateRequestSchema, { mediaLayers: [] })).toBe(false);
        const served = { id: "round", kind: "video", mimeType: "video/mp4", size: 3, ...round };
        delete (served as { uploadId?: string }).uploadId;
        expect(Value.Check(storyMediaLayerSchema, served)).toBe(true);
        expect(Value.Check(storySchema.properties.mediaLayers, [served])).toBe(true);
        expect(storySchema.required).not.toContain("mediaLayers");
    });

    it("streams a story file to the shared upload route and posts JSON that references it", async () => {
        const requests: Request[] = [];
        const client = new HappyAgentClient({
            endpoint: "https://agent.test",
            token: "test-token",
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                return Response.json({ upload: { id: "u0" }, story: { id: "story" } });
            },
        });
        const file = new Blob([new Uint8Array([0, 255, 42])], { type: "video/mp4" });
        expect((await client.uploadStoryMedia(file)).upload.id).toBe("u0");
        const body = { media: { uploadId: "u0" }, caption: "Ready" };
        await client.postStory(body);
        await client.repostStory("story", { mediaLayers: [] });
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
            "/v0/artifact-uploads",
            "/v0/stories",
            "/v0/stories/story/repost",
        ]);
        expect(new Uint8Array(await requests[0]!.arrayBuffer())).toEqual(
            new Uint8Array([0, 255, 42]),
        );
        expect(await requests[1]!.json()).toEqual(body);
        expect(requests[2]!.headers.get("content-type")).toContain("application/json");
        expect(client.storyLayerUrl("story", "round")).toBe(
            "https://agent.test/v0/stories/story/layers/round",
        );
        await expect(
            client.repostStory("story", { mediaLayers: [], round: file }),
        ).rejects.toThrow();
    });

    it("carries an optional generated short name on tasks and bots", () => {
        for (const schema of [taskSchema, botSchema]) {
            expect(schema.required).not.toContain("shortName");
            expect(Value.Check(schema.properties.shortName, "Onboarding 🚀")).toBe(true);
            expect(Value.Check(schema.properties.shortName, "")).toBe(false);
        }
    });
});
