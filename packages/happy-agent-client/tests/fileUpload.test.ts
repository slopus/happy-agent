import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentUploadLimitError } from "../sources/index.js";
import { artifactFileSchema } from "../sources/protocol/artifacts.js";
import {
    attachmentSchema,
    type AttachmentByteRange,
    type AttachmentKind,
} from "../sources/protocol/attachments.js";
import { mediaSchema } from "../sources/protocol/media.js";
import {
    mediaFileItemSchema,
    mediaItemSchema,
    type MediaFileItem,
} from "../sources/protocol/messages.js";
import type { FileUploadSource } from "../sources/requestOptions.js";

const CHUNK = 4 * 1024 * 1024;
const fileName = "recording.mp4";

afterEach(() => vi.unstubAllGlobals());

function bytesAt(start: number, end: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(end - start);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (start + index) % 251;
    return bytes;
}

/** A server that keeps ranges and never stores the entire test file in memory. */
function server(size: number, initial: AttachmentByteRange[] = [], attachment = false) {
    const held = initial.map((range) => ({ ...range }));
    const requests: { range: string | null; url: string; size: number; method: string }[] = [];
    let active = 0;
    let maxActive = 0;
    const client = new HappyAgentClient({
        endpoint: "http://agent.local",
        fetch: async (input, init) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {
                await Promise.resolve();
                const range = new Headers(init?.headers).get("content-range");
                const bytes = init?.body as Uint8Array;
                requests.push({
                    range,
                    url: String(input),
                    size: bytes.byteLength,
                    method: init?.method ?? "GET",
                });
                const id =
                    range === null
                        ? "a".repeat(64)
                        : new URL(String(input)).pathname.split("/").at(-1)!;
                const complete = () => {
                    const media = {
                        id,
                        name: fileName,
                        size,
                        mimeType: "video/mp4",
                        kind: "video",
                    };
                    return Response.json(attachment ? { attachment: media } : { media }, {
                        status: 201,
                    });
                };
                if (range === null) return complete();
                const part = /^bytes (\d+)-(\d+)\//u.exec(range);
                if (part !== null) {
                    const start = Number(part[1]);
                    const end = Number(part[2]);
                    expect(
                        Buffer.compare(Buffer.from(bytes), Buffer.from(bytesAt(start, end + 1))),
                    ).toBe(0);
                    held.push({ start, end });
                    held.sort((a, b) => a.start - b.start);
                    for (let index = held.length - 1; index > 0; index -= 1) {
                        const before = held[index - 1]!;
                        const after = held[index]!;
                        if (before.end + 1 < after.start) continue;
                        before.end = Math.max(before.end, after.end);
                        held.splice(index, 1);
                    }
                }
                if (held.length === 1 && held[0]!.start === 0 && held[0]!.end === size - 1)
                    return complete();
                return Response.json({
                    upload: { id, name: fileName, size, received: held, expiresAt: 1 },
                });
            } finally {
                active -= 1;
            }
        },
    });
    return { client, requests, maxActive: () => maxActive };
}

describe("streaming file uploads", () => {
    it.each([false, true])(
        "hashes bounded reads and resumes off-grid ranges (attachment=%s)",
        async (attachment) => {
            // Prove the production helper never needs Web Crypto's whole-buffer digest.
            vi.stubGlobal("crypto", undefined);
            const size = 3 * CHUNK + 17;
            const reads: [number, number][] = [];
            let reading = false;
            const source: FileUploadSource = {
                size,
                read: async (start, end) => {
                    expect(reading).toBe(false);
                    reading = true;
                    reads.push([start, end]);
                    await Promise.resolve();
                    reading = false;
                    return bytesAt(start, end);
                },
            };
            const s = server(
                size,
                [
                    { start: 0, end: 122 },
                    { start: CHUNK + 100, end: CHUNK + 199 },
                ],
                attachment,
            );
            const progress: number[] = [];
            const hashing: number[] = [];
            const options = {
                onHashProgress: (hashed: number, total: number) => {
                    expect(total).toBe(size);
                    expect(s.requests).toEqual([]);
                    hashing.push(hashed);
                },
                onProgress: (uploaded: number, total: number) => {
                    expect(total).toBe(size);
                    progress.push(uploaded);
                },
            };
            const result = attachment
                ? await s.client.attachFile("agent1", { name: fileName, data: source }, options)
                : await s.client.uploadMediaFile({ name: fileName, data: source }, options);
            const expectedHash = createHash("sha256");
            for (let start = 0; start < size; start += CHUNK)
                expectedHash.update(bytesAt(start, Math.min(size, start + CHUNK)));
            expect(result.id).toBe(expectedHash.digest("hex"));
            expect(hashing).toEqual([0, CHUNK, 2 * CHUNK, 3 * CHUNK, size]);
            expect(reads.every(([start, end]) => end - start <= CHUNK)).toBe(true);
            expect(s.requests.map((request) => request.range)).toEqual([
                `bytes 0-${String(CHUNK - 1)}/${String(size)}`,
                `bytes ${String(CHUNK)}-${String(CHUNK + 99)}/${String(size)}`,
                `bytes ${String(CHUNK + 200)}-${String(2 * CHUNK + 199)}/${String(size)}`,
                `bytes ${String(2 * CHUNK + 200)}-${String(size - 1)}/${String(size)}`,
            ]);
            expect(s.requests.every((request) => request.size <= CHUNK)).toBe(true);
            expect(s.maxActive()).toBe(1);
            expect(progress[0]).toBe(0);
            expect(progress[1]).toBe(CHUNK + 100);
            expect(progress.at(-1)).toBe(size);
            expect(
                progress.every((value, index) => index === 0 || value >= progress[index - 1]!),
            ).toBe(true);
        },
        30_000,
    );

    it.each([CHUNK, CHUNK + 1])(
        "uses a 4 MiB whole-file threshold for Blob sources (%i bytes)",
        async (size) => {
            class SlicedBlob extends Blob {
                override async arrayBuffer(): Promise<ArrayBuffer> {
                    throw new Error("Whole Blob read");
                }
            }
            const s = server(size);
            await s.client.uploadMediaFile({
                name: fileName,
                data: new SlicedBlob([bytesAt(0, size)]),
            });
            expect(s.requests[0]!.range).toBe(
                size <= CHUNK ? null : `bytes 0-${String(CHUNK - 1)}/${String(size)}`,
            );
            expect(s.requests.every((request) => request.size <= CHUNK)).toBe(true);
        },
        30_000,
    );

    it("accepts File and existing Uint8Array values through the same attachment helper", async () => {
        const s = server(3, [], true);
        await s.client.attachFile("agent1", {
            name: fileName,
            data: new File([bytesAt(0, 3)], fileName),
        });
        await s.client.attachFile("agent1", { name: fileName, data: bytesAt(0, 3) });
        expect(s.requests).toHaveLength(2);
        expect(s.requests.every((request) => request.range === null)).toBe(true);
    });

    it.each([false, true])(
        "stops when the first data chunk finds an already-held file (attachment=%s)",
        async (attachment) => {
            const size = CHUNK + 1;
            const read = vi.fn(async (start: number, end: number) => bytesAt(start, end));
            const s = server(size, [{ start: 0, end: size - 1 }], attachment);
            const progress: number[] = [];
            const file = { name: fileName, data: { size, read } };
            const options = { onProgress: (bytes: number) => progress.push(bytes) };
            if (attachment) await s.client.attachFile("agent1", file, options);
            else await s.client.uploadMediaFile(file, options);
            expect(read).toHaveBeenCalledTimes(3);
            expect(s.requests).toHaveLength(1);
            expect(s.requests[0]).toMatchObject({
                range: `bytes 0-${String(CHUNK - 1)}/${String(size)}`,
                size: CHUNK,
            });
            expect(progress).toEqual([0, size]);
        },
    );

    it.each([false, true])(
        "sends only data requests for a fresh upload (attachment=%s)",
        async (attachment) => {
            const size = 3 * CHUNK + 17;
            const s = server(size, [], attachment);
            const file = {
                name: fileName,
                data: { size, read: async (start: number, end: number) => bytesAt(start, end) },
            };
            if (attachment) await s.client.attachFile("agent1", file);
            else await s.client.uploadMediaFile(file);
            expect(s.requests.map(({ range }) => range)).toEqual([
                `bytes 0-${String(CHUNK - 1)}/${String(size)}`,
                `bytes ${String(CHUNK)}-${String(2 * CHUNK - 1)}/${String(size)}`,
                `bytes ${String(2 * CHUNK)}-${String(3 * CHUNK - 1)}/${String(size)}`,
                `bytes ${String(3 * CHUNK)}-${String(size - 1)}/${String(size)}`,
            ]);
        },
    );

    it.each([
        [false, 4],
        [true, 4],
        [false, 6],
        [true, 6],
    ] as const)(
        "resumes after repeating held chunk zero (attachment=%s, prior chunk=%i)",
        async (attachment, priorChunk) => {
            const size = 11;
            const s = server(size, [{ start: 0, end: priorChunk - 1 }], attachment);
            const file = { name: fileName, data: bytesAt(0, size) };
            const options = { directLimit: 0, chunkSize: 4 };
            if (attachment) await s.client.attachFile("agent1", file, options);
            else await s.client.uploadMediaFile(file, options);
            expect(s.requests.map(({ range }) => range)).toEqual([
                "bytes 0-3/11",
                `bytes ${String(priorChunk)}-${String(priorChunk + 3)}/11`,
                `bytes ${String(priorChunk + 4)}-10/11`,
            ]);
        },
    );

    it("aborts a pending source read promptly and removes its listener", async () => {
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        let began!: () => void;
        const started = new Promise<void>((resolve) => {
            began = resolve;
        });
        const source = {
            size: 1,
            read: async () => {
                began();
                return await new Promise<Uint8Array>(() => undefined);
            },
        };
        const s = server(1);
        const pending = s.client.uploadMediaFile(
            { name: fileName, data: source },
            { signal: controller.signal },
        );
        await started;
        controller.abort(new Error("Cancelled by caller"));
        await expect(pending).rejects.toThrow("Cancelled by caller");
        expect(s.requests).toEqual([]);
        expect(add).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it("cancels hashing from its progress callback before uploading or reading again", async () => {
        const controller = new AbortController();
        const size = CHUNK + 1;
        const read = vi.fn(async (start: number, end: number) => bytesAt(start, end));
        const s = server(size);
        await expect(
            s.client.uploadMediaFile(
                { name: fileName, data: { size, read } },
                {
                    signal: controller.signal,
                    onHashProgress: (hashed) => {
                        if (hashed > 0) controller.abort();
                    },
                },
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(read).toHaveBeenCalledTimes(1);
        expect(s.requests).toEqual([]);
    });

    it("honors cancellation before reading or hashing, and after a progress callback", async () => {
        const before = new AbortController();
        before.abort();
        const read = vi.fn(async () => bytesAt(0, 1));
        const s = server(1);
        await expect(
            s.client.uploadMediaFile(
                { name: fileName, data: { size: 1, read } },
                { signal: before.signal },
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(read).not.toHaveBeenCalled();
        const during = new AbortController();
        await expect(
            s.client.uploadMediaFile(
                { name: fileName, data: { size: 1, read } },
                {
                    signal: during.signal,
                    onProgress: () => during.abort(),
                },
            ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(read).not.toHaveBeenCalled();
    });

    it("removes read listeners after success and rejects short reads before HTTP", async () => {
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        const s = server(3);
        await s.client.uploadMediaFile(
            { name: fileName, data: bytesAt(0, 3) },
            { signal: controller.signal },
        );
        expect(add).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
        const fetch = vi.fn();
        const client = new HappyAgentClient({ endpoint: "http://agent.local", fetch });
        await expect(
            client.uploadMediaFile({
                name: fileName,
                data: { size: 3, read: async () => new Uint8Array(2) },
            }),
        ).rejects.toThrow("wrong number of bytes");
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        [409, "hash_mismatch"],
        [400, "invalid_request"],
    ] as const)(
        "preserves %i %s without retrying or discarding a shared upload",
        async (status, code) => {
            let calls = 0;
            const client = new HappyAgentClient({
                endpoint: "http://agent.local",
                fetch: async () => {
                    calls += 1;
                    return Response.json({ error: "Upload could not complete.", code }, { status });
                },
            });
            const error = await client
                .uploadMediaFile({ name: fileName, data: bytesAt(0, 3) }, { directLimit: 0 })
                .catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(HappyAgentApiError);
            expect(error).toMatchObject({ status, code });
            expect(calls).toBe(1);
        },
    );

    it("never sends a 4,097th byte-carrying request", async () => {
        const size = 4097;
        let requests = 0;
        const client = new HappyAgentClient({
            endpoint: "http://agent.local",
            fetch: async (input, init) => {
                const range = new Headers(init?.headers).get("content-range")!;
                if (!range.startsWith("bytes */")) requests += 1;
                const id = new URL(String(input)).pathname.split("/").at(-1);
                return Response.json({
                    upload: {
                        id,
                        size,
                        name: fileName,
                        received: requests === 0 ? [] : [{ start: 0, end: requests - 1 }],
                        expiresAt: 1,
                    },
                });
            },
        });
        await expect(
            client.uploadMediaFile(
                { name: fileName, data: bytesAt(0, size) },
                { directLimit: 0, chunkSize: 1 },
            ),
        ).rejects.toBeInstanceOf(HappyAgentUploadLimitError);
        expect(requests).toBe(4096);
    }, 30_000);

    it.each([
        [false, 4096, "carrying"],
        [true, 4096, "carrying"],
        [false, 8192, "carrying"],
        [true, 8192, "carrying"],
        [false, 4096, "with"],
        [true, 4096, "with"],
    ] as const)(
        "normalizes the server's persisted cap (attachment=%s, cap=%i, wording=%s)",
        async (attachment, cap, wording) => {
            const causeMessage =
                wording === "with"
                    ? "An upload takes at most 4096 requests with bytes; cancel it and start again."
                    : `An upload takes at most ${String(cap)} requests carrying bytes; cancel it and upload the file again.`;
            const fetch = vi.fn(async () =>
                Response.json({ error: causeMessage, code: "invalid_request" }, { status: 400 }),
            );
            const client = new HappyAgentClient({ endpoint: "http://agent.local", fetch });
            const file = { name: fileName, data: bytesAt(0, 3) };
            const pending = attachment
                ? client.attachFile("agent1", file, { directLimit: 0 })
                : client.uploadMediaFile(file, { directLimit: 0 });
            const error: unknown = await pending.catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(HappyAgentUploadLimitError);
            expect(error).toMatchObject({
                cause: { status: 400, code: "invalid_request", message: causeMessage },
            });
            expect(fetch).toHaveBeenCalledTimes(1);
        },
    );

    it("accepts future kinds on media, attachments, and artifact files", () => {
        const media = {
            id: "a".repeat(64),
            kind: "future_kind",
            size: 1,
            mimeType: "application/example",
        };
        expect(Value.Check(mediaSchema, media)).toBe(true);
        expect(Value.Check(attachmentSchema, { ...media, name: "a.example" })).toBe(true);
        expect(Value.Check(mediaFileItemSchema, { ...media, name: "a.example" })).toBe(true);
        expect(Value.Check(mediaItemSchema, { ...media, name: "a.example", kind: "image" })).toBe(
            false,
        );
        expectTypeOf<Extract<AttachmentKind, "image">>().toEqualTypeOf<"image">();
        expectTypeOf<Extract<MediaFileItem["kind"], "video">>().toEqualTypeOf<"video">();
        expectTypeOf<"future_kind">().toExtend<AttachmentKind>();
        expectTypeOf<"future_kind">().not.toExtend<MediaFileItem["kind"]>();
        expect(
            Value.Check(artifactFileSchema, { ...media, path: "a.example", sha256: media.id }),
        ).toBe(true);
    });
});
