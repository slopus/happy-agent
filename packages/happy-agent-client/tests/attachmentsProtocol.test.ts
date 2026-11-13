import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    attachmentChunkResponseSchema,
    attachmentResponseSchema,
    fileBlockSchema,
    type Attachment,
    type AttachmentByteRange,
} from "../sources/protocol/attachments.js";

interface Recorded {
    method: string;
    url: string;
    contentType: string | null;
    contentRange: string | null;
    body: number[] | null;
}

/** A client whose fetch records each request and answers with `answer`. */
function recordingClient(answer: (request: Recorded) => unknown): {
    client: HappyAgentClient;
    requests: Recorded[];
} {
    const requests: Recorded[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        const recorded: Recorded = {
            method: init?.method ?? "GET",
            url: input.toString(),
            contentType: headers.get("content-type"),
            contentRange: headers.get("content-range"),
            body: init?.body instanceof Uint8Array ? Array.from(init.body) : null,
        };
        requests.push(recorded);
        return new Response(JSON.stringify(answer(recorded)), { status: 200 });
    };
    return {
        client: new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch }),
        requests,
    };
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

describe("attachments protocol", () => {
    const id = digest(new Uint8Array([1, 2, 3]));
    const attachment: Attachment = {
        id,
        name: "shot.png",
        mimeType: "image/png",
        size: 3,
        kind: "image",
        width: 2,
        height: 1,
        thumbhash: "AAAA",
    };

    it("accepts Happy Cloud's attachment and block, without the optional details", () => {
        const cloud = { id, name: "a.txt", mimeType: "text/plain", size: 3 };
        expect(Value.Check(attachmentResponseSchema, { attachment: cloud })).toBe(true);
        expect(Value.Check(attachmentResponseSchema, { attachment })).toBe(true);
        expect(Value.Check(fileBlockSchema, { type: "file", attachment: id, name: "a.txt" })).toBe(
            true,
        );
        expect(
            Value.Check(fileBlockSchema, { type: "file", attachment: "A1", name: "a.txt" }),
        ).toBe(false);
        expect(
            Value.Check(attachmentChunkResponseSchema, {
                upload: {
                    id,
                    name: "a.txt",
                    size: 3,
                    received: [{ start: 0, end: 0 }],
                    expiresAt: 1,
                },
            }),
        ).toBe(true);
    });

    it("puts whole files, chunks, and probes on the attachment routes", async () => {
        const { client, requests } = recordingClient(() => ({ attachment }));
        await client.uploadAttachment("agent1", {
            name: "shot one.png",
            data: new Uint8Array([1, 2, 3]),
            contentType: "image/png",
        });
        await client.uploadAttachmentChunk("agent1", id, { name: "shot.png", size: 3 });
        await client.uploadAttachmentChunk("agent1", id, {
            name: "shot.png",
            size: 3,
            start: 1,
            data: new Uint8Array([2, 3]),
        });
        await client.deleteAttachment("agent1", id);
        expect(client.attachmentUrl("agent1", id)).toBe(
            `http://agent.local/v0/agents/agent1/attachments/${id}`,
        );
        const base = "http://agent.local/v0/agents/agent1/attachments";
        expect(requests).toEqual([
            {
                method: "PUT",
                url: `${base}?name=shot+one.png`,
                contentType: "image/png",
                contentRange: null,
                body: [1, 2, 3],
            },
            {
                method: "PUT",
                url: `${base}/${id}?name=shot.png`,
                contentType: "application/octet-stream",
                contentRange: "bytes */3",
                body: [],
            },
            {
                method: "PUT",
                url: `${base}/${id}?name=shot.png`,
                contentType: "application/octet-stream",
                contentRange: "bytes 1-2/3",
                body: [2, 3],
            },
            {
                method: "DELETE",
                url: `${base}/${id}`,
                contentType: null,
                contentRange: null,
                body: null,
            },
        ]);
    });

    it("sends a small file in one request", async () => {
        const { client, requests } = recordingClient(() => ({ attachment }));
        const attached = await client.attachFile("agent1", {
            name: "shot.png",
            data: new Uint8Array([1, 2, 3]),
        });
        expect(attached).toEqual(attachment);
        expect(requests.map((request) => request.url)).toEqual([
            "http://agent.local/v0/agents/agent1/attachments?name=shot.png",
        ]);
    });

    it("sends a large file in chunks, asking first and skipping what the daemon holds", async () => {
        const data = new Uint8Array(10).map((_, index) => index);
        const fileId = digest(data);
        // The daemon already holds bytes 4–5 from an earlier attempt.
        const held: AttachmentByteRange[] = [{ start: 4, end: 5 }];
        const { client, requests } = recordingClient((request) => {
            const range = /^bytes (\d+)-(\d+)\/10$/.exec(request.contentRange ?? "");
            if (range !== null) {
                held.push({ start: Number(range[1]), end: Number(range[2]) });
                held.sort((left, right) => left.start - right.start);
                // Merged, as the daemon answers them.
                for (let index = held.length - 1; index > 0; index -= 1) {
                    const [before, after] = [held[index - 1]!, held[index]!];
                    if (after.start > before.end + 1) continue;
                    before.end = Math.max(before.end, after.end);
                    held.splice(index, 1);
                }
            }
            const total = held.reduce((sum, part) => sum + part.end - part.start + 1, 0);
            if (total >= 10) return { attachment: { ...attachment, id: fileId, size: 10 } };
            return {
                upload: { id: fileId, name: "big.bin", size: 10, received: held, expiresAt: 1 },
            };
        });
        const attached = await client.attachFile(
            "agent1",
            { name: "big.bin", data },
            { directLimit: 4, chunkSize: 3 },
        );
        expect(attached.id).toBe(fileId);
        expect(requests.every((request) => request.url.includes(`/attachments/${fileId}?`))).toBe(
            true,
        );
        expect(requests.map((request) => request.contentRange)).toEqual([
            "bytes */10",
            "bytes 0-2/10",
            "bytes 3-3/10",
            "bytes 6-8/10",
            "bytes 9-9/10",
        ]);
        expect(requests[2]?.body).toEqual([3]);
    });

    it("stops when the daemon does not keep a chunk", async () => {
        const { client } = recordingClient(() => ({
            upload: { id, name: "big.bin", size: 10, received: [], expiresAt: 1 },
        }));
        await expect(
            client.attachFile(
                "agent1",
                { name: "big.bin", data: new Uint8Array(10) },
                { directLimit: 4, chunkSize: 5 },
            ),
        ).rejects.toThrow("did not keep");
    });
});
