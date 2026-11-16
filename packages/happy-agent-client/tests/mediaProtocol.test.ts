import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { isMediaImageItem } from "../sources/isMediaImageItem.js";
import { artifactFileSchema } from "../sources/protocol/artifacts.js";
import { attachmentSchema, fileBlockSchema } from "../sources/protocol/attachments.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    mediaChunkResponseSchema,
    mediaReadQuerySchema,
    mediaResponseSchema,
    mediaSchema,
    type Media,
} from "../sources/protocol/media.js";
import { mediaItemSchema } from "../sources/protocol/messages.js";

const id = "a".repeat(64);
const measured: Media = {
    id,
    kind: "video",
    mimeType: "video/mp4",
    size: 1024,
    width: 1080,
    height: 1920,
    durationMs: 60_000,
    thumbhash: "AAAA",
    preview: { width: 360, height: 640 },
};

describe("global media protocol", () => {
    it("carries an optional true-only animation flag on all picture surfaces", () => {
        const image = { ...measured, kind: "image", mimeType: "image/webp" };
        const surfaces = [
            [mediaSchema, image],
            [attachmentSchema, { ...image, name: "moving.webp" }],
            [fileBlockSchema, { ...image, type: "file", attachment: id, name: "moving.webp" }],
            [mediaItemSchema, { ...image, name: "moving.webp" }],
            [artifactFileSchema, { ...image, sha256: id, path: "moving.webp" }],
        ] as const;
        for (const [schema, object] of surfaces) {
            expect(Value.Check(schema, object)).toBe(true);
            expect(Value.Check(schema, { ...object, animated: true })).toBe(true);
            expect(Value.Check(schema, { ...object, animated: false })).toBe(false);
            expect(Value.Check(schema, { ...object, animated: "true" })).toBe(false);
        }
    });
    it("tolerates an animation flag on video items without treating them as pictures", () => {
        const video = { ...measured, kind: "video" as const, name: "clip.mp4" };
        expect(Value.Check(mediaItemSchema, video)).toBe(true);
        const flagged = { ...video, animated: true } as const;
        expect(Value.Check(mediaItemSchema, flagged)).toBe(true);
        expect(isMediaImageItem(flagged)).toBe(false);
    });
    it("accepts the same optional measurements on every surface", () => {
        expect(Value.Check(mediaResponseSchema, { media: measured })).toBe(true);
        expect(Value.Check(attachmentSchema, { ...measured, name: "clip.mp4" })).toBe(true);
        expect(
            Value.Check(fileBlockSchema, {
                ...measured,
                type: "file",
                attachment: id,
                name: "clip.mp4",
            }),
        ).toBe(true);
        expect(Value.Check(mediaItemSchema, { ...measured, name: "clip.mp4" })).toBe(true);
        expect(
            Value.Check(artifactFileSchema, {
                ...measured,
                sha256: id,
                path: "clip.mp4",
            }),
        ).toBe(true);
        expect(Value.Check(mediaSchema, { ...measured, scale: 2 })).toBe(true);
    });

    it("keeps new fields optional for older compatible daemons", () => {
        expect(
            Value.Check(mediaSchema, { id, kind: "file", mimeType: "text/plain", size: 0 }),
        ).toBe(true);
        expect(
            Value.Check(attachmentSchema, { id, name: "a.txt", mimeType: "text/plain", size: 0 }),
        ).toBe(true);
        expect(
            Value.Check(mediaItemSchema, {
                kind: "image",
                name: "a.png",
                mimeType: "image/png",
                size: 12,
                width: 1,
                height: 1,
                thumbhash: "AAAA",
            }),
        ).toBe(true);
        const health = {
            healthy: true,
            ready: true,
            status: "ready",
            version: { daemon: "gym", protocol: 35 },
        };
        expect(
            Value.Check(healthResponseSchema, { ...health, capabilities: { media: true } }),
        ).toBe(true);
        expect(Value.Check(healthResponseSchema, health)).toBe(true);
    });

    it("validates digests, measurement bounds, and the three variant names", () => {
        expect(Value.Check(mediaSchema, { ...measured, id: "A".repeat(64) })).toBe(false);
        expect(Value.Check(mediaSchema, { ...measured, durationMs: -1 })).toBe(false);
        expect(Value.Check(mediaSchema, { ...measured, preview: { width: 0, height: 1 } })).toBe(
            false,
        );
        expect(Value.Check(mediaSchema, { ...measured, preview: { width: 1 } })).toBe(false);
        expect(Value.Check(mediaSchema, { ...measured, scale: 5 })).toBe(false);
        expect(Value.Check(mediaReadQuerySchema, {})).toBe(true);
        for (const variant of ["play", "preview", "large"]) {
            expect(Value.Check(mediaReadQuerySchema, { variant })).toBe(true);
        }
        expect(Value.Check(mediaReadQuerySchema, { variant: "small" })).toBe(false);
    });

    it("accepts a resumed upload or a completed media response", () => {
        expect(
            Value.Check(mediaChunkResponseSchema, {
                upload: {
                    id,
                    name: "clip.mp4",
                    size: 1024,
                    received: [{ start: 0, end: 511 }],
                    expiresAt: 1,
                },
            }),
        ).toBe(true);
        expect(Value.Check(mediaChunkResponseSchema, { media: measured })).toBe(true);
    });

    it("uploads whole bytes, probes, sends chunks, and deletes without an agent", async () => {
        const requests: {
            url: string;
            method: string;
            contentType: string | null;
            contentRange: string | null;
            bytes: number[] | null;
        }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            token: "t",
            fetch: async (input, init) => {
                const headers = new Headers(init?.headers);
                requests.push({
                    url: String(input),
                    method: init?.method ?? "GET",
                    contentType: headers.get("content-type"),
                    contentRange: headers.get("content-range"),
                    bytes: init?.body instanceof Uint8Array ? [...init.body] : null,
                });
                return Response.json({ media: measured });
            },
        });
        await expect(
            client.uploadMedia({
                name: "clip one.mp4",
                contentType: "video/mp4",
                data: new Uint8Array([1, 2, 3]),
            }),
        ).resolves.toEqual({ media: measured });
        await client.uploadMediaChunk(id, { name: "clip.mp4", size: 3 });
        await client.uploadMediaChunk(id, {
            name: "clip.mp4",
            size: 3,
            start: 1,
            data: new Uint8Array([2, 3]),
        });
        await client.deleteMedia(id);
        expect(requests).toEqual([
            {
                url: "http://agent.local/v0/media?name=clip+one.mp4",
                method: "PUT",
                contentType: "video/mp4",
                contentRange: null,
                bytes: [1, 2, 3],
            },
            {
                url: `http://agent.local/v0/media/${id}?name=clip.mp4`,
                method: "PUT",
                contentType: "application/octet-stream",
                contentRange: "bytes */3",
                bytes: [],
            },
            {
                url: `http://agent.local/v0/media/${id}?name=clip.mp4`,
                method: "PUT",
                contentType: "application/octet-stream",
                contentRange: "bytes 1-2/3",
                bytes: [2, 3],
            },
            {
                url: `http://agent.local/v0/media/${id}`,
                method: "DELETE",
                contentType: null,
                contentRange: null,
                bytes: null,
            },
        ]);
    });

    it.each(["play", "preview", "large"] as const)(
        "reads %s with Range, ETag and endpoint query preserved",
        async (variant) => {
            const client = new HappyAgentClient({
                endpoint: "http://agent.local/tunnel?route=one",
                token: "t",
                fetch: async (input, init) => {
                    expect(String(input)).toBe(
                        `http://agent.local/tunnel/v0/media/${id}?variant=${variant}&route=one`,
                    );
                    const headers = new Headers(init?.headers);
                    expect(headers.get("authorization")).toBe("Bearer t");
                    expect(headers.get("range")).toBe("bytes=1-2");
                    expect(headers.get("if-none-match")).toBe('"before"');
                    return new Response(new Uint8Array([2, 3]), {
                        status: 206,
                        headers: {
                            "Content-Type": "image/webp",
                            "Content-Range": "bytes 1-2/3",
                            ETag: '"after"',
                        },
                    });
                },
            });
            const result = await client.getMedia(id, {
                variant,
                range: { start: 1, end: 2 },
                ifNoneMatch: '"before"',
            });
            expect(result).toMatchObject({
                contentType: "image/webp",
                contentRange: "bytes 1-2/3",
                etag: '"after"',
            });
            expect([...new Uint8Array(result!.data)]).toEqual([2, 3]);
            expect(client.mediaUrl(id, { variant })).toBe(
                `http://agent.local/tunnel/v0/media/${id}?variant=${variant}&route=one`,
            );
            expect(client.attachmentUrl("agent1", id, { variant })).toBe(
                `http://agent.local/tunnel/v0/agents/agent1/attachments/${id}?variant=${variant}&route=one`,
            );
        },
    );

    it("keeps conditional reads and attachment variant aliases", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            fetch: async (input) => {
                expect(String(input)).toBe(
                    `http://agent.local/v0/agents/agent1/attachments/${id}?variant=preview`,
                );
                return new Response(null, { status: 304 });
            },
        });
        await expect(
            client.getAttachment("agent1", id, { variant: "preview", ifNoneMatch: '"same"' }),
        ).resolves.toBeNull();
    });

    it.each([undefined, "play", "preview", "large"] as const)(
        "forwards date If-Range and receives a whole %s body",
        async (variant) => {
            const date = "Wed, 21 Oct 2015 07:28:00 GMT";
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                fetch: async (input, init) => {
                    expect(new URL(String(input)).searchParams.get("variant")).toBe(
                        variant ?? null,
                    );
                    const headers = new Headers(init?.headers);
                    expect(headers.get("if-range")).toBe(date);
                    expect(headers.get("range")).toBe("bytes=1-");
                    return new Response(new Uint8Array([1, 2, 3]), {
                        status: 200,
                        headers: { ETag: '"held"' },
                    });
                },
            });
            const result = await client.getMedia(id, {
                variant,
                range: { start: 1 },
                ifRange: date,
            });
            expect(result!.contentRange).toBeNull();
            expect([...new Uint8Array(result!.data)]).toEqual([1, 2, 3]);
        },
    );

    it.each([undefined, "play"] as const)(
        "forwards a held ETag to resume immutable %s bytes",
        async (variant) => {
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                fetch: async (_input, init) => {
                    const headers = new Headers(init?.headers);
                    expect(headers.get("if-range")).toBe('"held"');
                    expect(headers.get("range")).toBe("bytes=1-");
                    return new Response(new Uint8Array([2, 3]), {
                        status: 206,
                        headers: { ETag: '"held"', "Content-Range": "bytes 1-2/3" },
                    });
                },
            });
            const result = await client.getMedia(id, {
                variant,
                range: { start: 1 },
                ifRange: '"held"',
            });
            expect(result!.contentRange).toBe("bytes 1-2/3");
            expect([...new Uint8Array(result!.data)]).toEqual([2, 3]);
        },
    );

    it.each([
        [false, 206],
        [false, 200],
        [true, 206],
        [true, 200],
    ] as const)(
        "resumes with If-Range and distinguishes replacement bodies (attachment=%s, status=%i)",
        async (attachment, status) => {
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                fetch: async (input, init) => {
                    expect(String(input)).toBe(
                        `http://agent.local/v0/${attachment ? "agents/agent1/attachments" : "media"}/${id}?variant=preview`,
                    );
                    const headers = new Headers(init?.headers);
                    expect(headers.get("range")).toBe("bytes=1-");
                    expect(headers.get("if-range")).toBe('"held"');
                    return new Response(new Uint8Array(status === 206 ? [2, 3] : [1, 2, 3]), {
                        status,
                        headers: {
                            "Content-Type": "image/webp",
                            ...(status === 206 ? { "Content-Range": "bytes 1-2/3" } : {}),
                            ETag: status === 206 ? '"held"' : '"remade"',
                        },
                    });
                },
            });
            const options = { variant: "preview", range: { start: 1 }, ifRange: '"held"' } as const;
            const result = attachment
                ? await client.getAttachment("agent1", id, options)
                : await client.getMedia(id, options);
            expect(result!.contentRange).toBe(status === 206 ? "bytes 1-2/3" : null);
            expect(result!.etag).toBe(status === 206 ? '"held"' : '"remade"');
            expect([...new Uint8Array(result!.data)]).toEqual(status === 206 ? [2, 3] : [1, 2, 3]);
        },
    );

    it.each([
        [503, "variant_not_ready"],
        [404, "variant_unavailable"],
    ] as const)(
        "exposes %i %s for the caller to fall back to the original",
        async (status, code) => {
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                fetch: async () =>
                    Response.json({ error: "The variant is unavailable.", code }, { status }),
            });
            const error = await client
                .getMedia(id, { variant: "play" })
                .catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(HappyAgentApiError);
            expect(error).toMatchObject({ status, code });
        },
    );
});
