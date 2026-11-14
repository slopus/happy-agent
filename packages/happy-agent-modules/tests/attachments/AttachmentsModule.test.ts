import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import {
    withAgentPermissionMode,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
    AttachmentError,
    AttachmentsModule,
    type AttachmentChunkRange,
} from "../../sources/attachments/index.js";
import { ChatMediaModule } from "../../sources/chatMedia/index.js";
import type { HostCompute } from "../../sources/compute/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import {
    insertAttachment,
    queryAttachment,
    queryUpload,
    updateAttachmentLifetime,
    updateUploadChunks,
} from "../../sources/attachments/persistence/attachmentStore.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule } from "../support/computeModule.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const HOUR = 60 * 60 * 1000;
const closers: (() => void)[] = [];

afterEach(() => {
    for (const close of closers.splice(0)) close();
});

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function body(...parts: Uint8Array[]): Readable {
    return Readable.from(parts);
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** Chat media whose measuring waits while `hold` is set, to pause an attachment being kept. */
class HeldChatMedia extends ChatMediaModule {
    hold: Promise<void> | undefined;
    measuring: (() => void) | undefined;

    override async describe(path: string, name: string, size: number) {
        this.measuring?.();
        await this.hold;
        return await super.describe(path, name, size);
    }
}

async function world() {
    const config = await temporaryTestConfig();
    const history = new HistoryModule();
    const compute = new FakeCompute();
    const chatMedia = new HeldChatMedia(config, history);
    const attachments = new AttachmentsModule(
        config,
        new DurableFunctionsModule(),
        chatMedia,
        scriptedComputeModule(async () => compute as unknown as HostCompute),
    );
    const erased = new Set<string>();
    const agents = {
        config: async (_ctx: unknown, agentId: string) => (erased.has(agentId) ? undefined : {}),
    } as unknown as AgentSystemRef;
    const database = moduleDatabase(
        [...history.migrations, ...attachments.migrations],
        "attachments-test",
    );
    closers.push(database.close);
    await database.ready;
    const ctx = database.context;
    const hooks = attachments.beforeStart(ctx, agents);
    return {
        chatMedia,
        hooks,
        /** Erase an agent as Agent Base does, with the module's hook in its transaction. */
        erase: async (agentId: string) => {
            erased.add(agentId);
            await ctx.inTx((txCtx) =>
                hooks.agentErasedTransact!(txCtx, {} as never, { id: agentId } as never),
            );
        },
        config,
        compute,
        ctx,
        attachments,
        upload: async (agentId: string, name: string, bytes: Uint8Array, contentType?: string) =>
            (await attachments.upload(ctx, agentId, null, { name, contentType }, body(bytes))).id,
        tool: async (agentId: string): Promise<AnyAgentTool> => {
            const tools = await hooks.tools!(ctx, {
                agent: { id: agentId },
            } as AgentModuleScope);
            return tools.find((tool) => tool.name === "read_attachment")!;
        },
    };
}

async function code(work: Promise<unknown>): Promise<string | undefined> {
    try {
        await work;
        return undefined;
    } catch (error) {
        if (!(error instanceof AttachmentError)) throw error;
        return error.code;
    }
}

describe("AttachmentsModule", () => {
    it("names a whole upload by its digest and answers the same attachment for the same bytes", async () => {
        const { ctx, attachments } = await world();
        const bytes = Buffer.from("hello");
        const first = await attachments.upload(
            ctx,
            "agentone",
            null,
            { name: "a.txt", contentType: "text/markdown; charset=utf-8" },
            body(bytes),
        );
        expect(first).toEqual({
            id: sha256(bytes),
            name: "a.txt",
            mimeType: "text/markdown",
            size: 5,
            kind: "file",
        });
        // A generic type goes by the name, and the first upload's details stay.
        const again = await attachments.upload(
            ctx,
            "agentone",
            null,
            { name: "b.bin", contentType: "application/octet-stream" },
            body(bytes),
        );
        expect(again).toEqual(first);
        expect(
            await code(
                attachments.upload(
                    ctx,
                    "agentone",
                    null,
                    { name: "\u0001 ", contentType: undefined },
                    body(bytes),
                ),
            ),
        ).toBe("invalid_request");
    });

    it("measures a picture from its bytes", async () => {
        const { ctx, attachments } = await world();
        const picture = await sharp({
            create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
        })
            .png()
            .toBuffer();
        const attachment = await attachments.upload(
            ctx,
            "agentone",
            null,
            { name: "shot.png", contentType: "image/jpeg" },
            body(picture),
        );
        expect(attachment).toMatchObject({
            kind: "image",
            mimeType: "image/png",
            width: 40,
            height: 20,
            thumbhash: expect.any(String),
        });
        // AVIF stays a plain file, as on Happy Cloud.
        const avif = await sharp({
            create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
        })
            .avif()
            .toBuffer();
        expect(
            await attachments.upload(
                ctx,
                "agentone",
                null,
                { name: "shot.avif", contentType: "image/avif" },
                body(avif),
            ),
        ).toEqual({
            id: sha256(avif),
            name: "shot.avif",
            mimeType: "image/avif",
            size: avif.byteLength,
            kind: "file",
        });
    });

    it("assembles chunks sent in any order and at the same time, and checks the digest", async () => {
        const { ctx, attachments } = await world();
        const bytes = Buffer.from("0123456789");
        const id = sha256(bytes);
        const file = { name: "digits.txt", contentType: "text/plain" };
        const chunk = (start: number, end: number) =>
            attachments.receive(
                ctx,
                "agentone",
                null,
                id,
                file,
                { type: "bytes", start, end, size: 10 },
                body(bytes.subarray(start, end + 1)),
            );
        const status = await attachments.receive(
            ctx,
            "agentone",
            null,
            id,
            file,
            { type: "status", size: 10 },
            body(),
        );
        expect(status).toMatchObject({ upload: { id, size: 10, received: [] } });
        expect(await chunk(6, 9)).toMatchObject({ upload: { received: [{ start: 6, end: 9 }] } });
        // The status answers what is held; a wrong total or range is refused.
        expect(
            await attachments.receive(
                ctx,
                "agentone",
                null,
                id,
                file,
                { type: "status", size: 10 },
                body(),
            ),
        ).toMatchObject({ upload: { received: [{ start: 6, end: 9 }] } });
        expect(
            await code(
                attachments.receive(
                    ctx,
                    "agentone",
                    null,
                    id,
                    file,
                    { type: "status", size: 11 },
                    body(),
                ),
            ),
        ).toBe("invalid_request");
        expect(
            await code(
                attachments.receive(
                    ctx,
                    "agentone",
                    null,
                    id,
                    file,
                    { type: "bytes", start: 0, end: 3, size: 10 },
                    body(Buffer.from("01")),
                ),
            ),
        ).toBe("invalid_request");
        const [first, second] = await Promise.all([chunk(0, 2), chunk(3, 5)]);
        const answers = [first, second];
        expect(answers.filter((answer) => "attachment" in answer)).toHaveLength(1);
        expect(answers.find((answer) => "attachment" in answer)).toEqual({
            attachment: { id, name: "digits.txt", mimeType: "text/plain", size: 10, kind: "file" },
        });
        // Done: any further request answers the attachment without its body.
        expect(await chunk(0, 2)).toMatchObject({ attachment: { id } });

        // Bytes that do not match the ID discard the upload.
        const wrong = sha256(Buffer.from("something else"));
        expect(
            await code(
                attachments.receive(
                    ctx,
                    "agentone",
                    null,
                    wrong,
                    file,
                    { type: "bytes", start: 0, end: 9, size: 10 },
                    body(bytes),
                ),
            ),
        ).toBe("hash_mismatch");
        expect(
            await attachments.receive(
                ctx,
                "agentone",
                null,
                wrong,
                file,
                { type: "status", size: 10 },
                body(),
            ),
        ).toMatchObject({ upload: { received: [] } });
    });

    it("keeps stored content unchanged when a resent chunk finishes writing after the file is done", async () => {
        const { ctx, attachments } = await world();
        const bytes = Buffer.from("ab");
        const id = sha256(bytes);
        const file = { name: "ab.txt", contentType: "text/plain" };
        const send = (start: number, parts: AsyncIterable<Uint8Array>) =>
            attachments.receive(
                ctx,
                "agentone",
                null,
                id,
                file,
                { type: "bytes", start, end: start, size: 2 },
                parts,
            );
        let opened!: () => void;
        const writing = new Promise<void>((resolve) => (opened = resolve));
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        // A resend of byte 0 whose body arrives only once the file is complete, and differs.
        const late = send(0, {
            async *[Symbol.asyncIterator]() {
                opened();
                await released;
                yield Buffer.from("x");
            },
        });
        await writing;
        await send(0, body(bytes.subarray(0, 1)));
        expect(await send(1, body(bytes.subarray(1, 2)))).toMatchObject({ attachment: { id } });
        release();
        expect(await late).toMatchObject({ attachment: { id } });
        const content = await attachments.content(ctx, "agentone", id);
        expect(await readFile(content.contentPath, "utf8")).toBe("ab");
    });

    it("answers 404 to a whole file still arriving when its upload is cancelled", async () => {
        const { ctx, attachments } = await world();
        const bytes = Buffer.from("whole");
        const id = sha256(bytes);
        const file = { name: "whole.txt", contentType: "text/plain" };
        await attachments.receive(
            ctx,
            "agentone",
            null,
            id,
            file,
            { type: "status", size: 5 },
            body(),
        );
        let opened!: () => void;
        const arriving = new Promise<void>((resolve) => (opened = resolve));
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        const slow = attachments.receive(
            ctx,
            "agentone",
            null,
            id,
            file,
            { type: "whole" },
            {
                async *[Symbol.asyncIterator]() {
                    opened();
                    await released;
                    yield bytes;
                },
            },
        );
        await arriving;
        await attachments.delete(ctx, "agentone", id);
        release();
        expect(await code(slow)).toBe("not_found");
        expect(await code(attachments.content(ctx, "agentone", id))).toBe("not_found");
    });

    it("refuses a status request that carries a body", async () => {
        const { ctx, attachments } = await world();
        const id = sha256(Buffer.from("ab"));
        expect(
            await code(
                attachments.receive(
                    ctx,
                    "agentone",
                    null,
                    id,
                    { name: "ab.txt", contentType: undefined },
                    { type: "status", size: 2 },
                    body(Buffer.from("ab")),
                ),
            ),
        ).toBe("invalid_request");
    });

    it("takes the same bytes again after they expired, before maintenance runs", async () => {
        const { ctx, attachments, upload } = await world();
        const bytes = Buffer.from("again");
        const id = await upload("agentone", "again.txt", bytes);
        const row = await ctx.inTx((txCtx) => queryAttachment(txCtx, "agentone", id));
        await ctx.inTx((txCtx) =>
            updateAttachmentLifetime(txCtx, { ...row!, expiresAt: Date.now() - 1 }),
        );
        expect(await code(attachments.content(ctx, "agentone", id))).toBe("not_found");
        expect(await upload("agentone", "again.txt", bytes)).toBe(id);
        expect((await attachments.content(ctx, "agentone", id)).sha256).toBe(id);
    });

    it("leaves files as they were when the caller's transaction rolls back", async () => {
        const { config, ctx, attachments, upload } = await world();
        const rolledBack = new Error("rolled back");
        const fresh = Buffer.from("never committed");
        await expect(
            ctx.inTx(async (txCtx) => {
                await attachments.upload(
                    txCtx,
                    "agentone",
                    null,
                    { name: "a.txt", contentType: undefined },
                    body(fresh),
                );
                throw rolledBack;
            }),
        ).rejects.toBe(rolledBack);
        expect(await exists(config.attachmentContentPath(sha256(fresh)))).toBe(false);

        const id = await upload("agentone", "kept.txt", Buffer.from("kept"));
        await expect(
            ctx.inTx(async (txCtx) => {
                await attachments.delete(txCtx, "agentone", id);
                await attachments.collect(txCtx, Date.now() + HOUR);
                throw rolledBack;
            }),
        ).rejects.toBe(rolledBack);
        expect((await attachments.content(ctx, "agentone", id)).sha256).toBe(id);
        expect(await exists(config.attachmentContentPath(id))).toBe(true);
    });

    it("deletes bytes an attachment uploaded, deleted, and collected in one transaction left", async () => {
        const { config, ctx, attachments } = await world();
        const bytes = Buffer.from("short lived");
        const id = sha256(bytes);
        await ctx.inTx(async (txCtx) => {
            await attachments.upload(
                txCtx,
                "agentone",
                null,
                { name: "a.txt", contentType: undefined },
                body(bytes),
            );
            await attachments.delete(txCtx, "agentone", id);
            await attachments.collect(txCtx, Date.now() + HOUR);
        });
        await attachments.collect(ctx, Date.now() + HOUR);
        expect(await exists(config.attachmentContentPath(id))).toBe(false);
    });

    it("stores the bytes of an attachment recorded just before a crash", async () => {
        const { config, ctx, attachments } = await world();
        const bytes = Buffer.from("recorded, not stored");
        const id = sha256(bytes);
        const fileId = "crashedfile";
        await mkdir(dirname(config.attachmentUploadPath(fileId)), { recursive: true });
        await writeFile(config.attachmentUploadPath(fileId), bytes);
        const now = Date.now();
        await ctx.inTx((txCtx) =>
            insertAttachment(txCtx, {
                agentId: "agentone",
                id,
                name: "a.txt",
                kind: "file",
                mimeType: "text/plain",
                size: bytes.byteLength,
                width: null,
                height: null,
                thumbhash: null,
                scale: null,
                uploadedBy: null,
                createdAt: now,
                sentAt: null,
                expiresAt: now + HOUR,
                pendingFileId: fileId,
            }),
        );
        await attachments.maintain(ctx, now);
        expect(await readFile(config.attachmentContentPath(id), "utf8")).toBe(
            "recorded, not stored",
        );
        expect(await exists(config.attachmentUploadPath(fileId))).toBe(false);
        expect(
            (await ctx.inTx((txCtx) => queryAttachment(txCtx, "agentone", id)))?.pendingFileId,
        ).toBeNull();
    });

    it("stores pending bytes only once maintenance's own transaction commits", async () => {
        const { config, ctx, attachments } = await world();
        const bytes = Buffer.from("rolled back with maintenance");
        const rolledBack = new Error("rolled back");
        await expect(
            ctx.inTx(async (txCtx) => {
                await attachments.upload(
                    txCtx,
                    "agentone",
                    null,
                    { name: "a.txt", contentType: undefined },
                    body(bytes),
                );
                await attachments.maintain(txCtx, Date.now());
                throw rolledBack;
            }),
        ).rejects.toBe(rolledBack);
        expect(await exists(config.attachmentContentPath(sha256(bytes)))).toBe(false);
    });

    it("stores the bytes when the file is asked for again after storing them failed", async () => {
        const { config, ctx, attachments, upload } = await world();
        const bytes = Buffer.from("stored on the second try");
        const id = sha256(bytes);
        const contentPath = config.attachmentContentPath(id);
        // A file where the content's folder belongs makes storing fail.
        await mkdir(dirname(dirname(contentPath)), { recursive: true });
        await writeFile(dirname(contentPath), "in the way");
        await expect(upload("agentone", "a.txt", bytes)).rejects.toThrow();
        await rm(dirname(contentPath));
        // Asking by ID stores them before answering the attachment.
        expect(
            await attachments.receive(
                ctx,
                "agentone",
                null,
                id,
                { name: "a.txt", contentType: undefined },
                { type: "status", size: bytes.byteLength },
                body(),
            ),
        ).toMatchObject({ attachment: { id } });
        expect(await readFile(contentPath, "utf8")).toBe("stored on the second try");
        expect(await upload("agentone", "a.txt", bytes)).toBe(id);
        expect(await readFile(contentPath, "utf8")).toBe("stored on the second try");
        expect(
            (await ctx.inTx((txCtx) => queryAttachment(txCtx, "agentone", id)))?.pendingFileId,
        ).toBeNull();
    });

    it("keeps shared bytes after a rolled-back collection of another conversation's copy", async () => {
        const { config, ctx, attachments, upload } = await world();
        const bytes = Buffer.from("shared after a rollback");
        const id = await upload("agentone", "one.txt", bytes);
        const rolledBack = new Error("rolled back");
        await expect(
            ctx.inTx(async (txCtx) => {
                await attachments.delete(txCtx, "agentone", id);
                await attachments.collect(txCtx, Date.now() + HOUR);
                throw rolledBack;
            }),
        ).rejects.toBe(rolledBack);
        await upload("agenttwo", "two.txt", bytes);
        await attachments.collect(ctx, Date.now() + HOUR);
        expect(await readFile(config.attachmentContentPath(id), "utf8")).toBe(
            "shared after a rollback",
        );
    });

    it("answers 404 when an upload expires or its agent is erased while its file is kept", async () => {
        const { config, ctx, attachments, chatMedia, erase } = await world();
        const pause = () => {
            let release!: () => void;
            chatMedia.hold = new Promise<void>((resolve) => (release = resolve));
            const measuring = new Promise<void>((resolve) => (chatMedia.measuring = resolve));
            return { measuring, release };
        };
        const bytes = Buffer.from("ab");
        const id = sha256(bytes);
        const file = { name: "ab.txt", contentType: "text/plain" };
        const send = (start: number) =>
            attachments.receive(
                ctx,
                "agentone",
                null,
                id,
                file,
                { type: "bytes", start, end: start, size: 2 },
                body(bytes.subarray(start, start + 1)),
            );
        await send(0);
        const expiring = pause();
        const finishing = send(1);
        await expiring.measuring;
        await attachments.maintain(ctx, Date.now() + 25 * HOUR);
        expiring.release();
        expect(await code(finishing)).toBe("not_found");
        expect(await code(attachments.content(ctx, "agentone", id))).toBe("not_found");

        const erasing = pause();
        const uploading = attachments.upload(
            ctx,
            "agentone",
            null,
            { name: "ab.txt", contentType: undefined },
            body(bytes),
        );
        await erasing.measuring;
        await erase("agentone");
        erasing.release();
        expect(await code(uploading)).toBe("not_found");
        expect(await exists(config.attachmentContentPath(id))).toBe(false);
    });

    it("takes at most 4,096 requests carrying bytes per upload, resent ones included", async () => {
        const { ctx, attachments } = await world();
        const bytes = Buffer.from("ab");
        const id = sha256(bytes);
        const file = { name: "ab.txt", contentType: "text/plain" };
        const receive = (range: AttachmentChunkRange, parts: Uint8Array[]) =>
            attachments.receive(ctx, "agentone", null, id, file, range, body(...parts));
        const send = (start: number) =>
            receive({ type: "bytes", start, end: start, size: 2 }, [
                bytes.subarray(start, start + 1),
            ]);
        const chunks = async () =>
            (await ctx.inTx((txCtx) => queryUpload(txCtx, "agentone", id)))?.chunks;

        await send(0);
        await send(0);
        // Asking where it stands does not count.
        await receive({ type: "status", size: 2 }, []);
        expect(await chunks()).toBe(2);
        await ctx.inTx((txCtx) =>
            updateUploadChunks(txCtx, { agentId: "agentone", id, chunks: 4095 }),
        );
        // A request whose body is cut short still counts.
        expect(await code(receive({ type: "bytes", start: 1, end: 1, size: 2 }, []))).toBe(
            "invalid_request",
        );
        expect(await chunks()).toBe(4096);
        await expect(send(1)).rejects.toThrow(/at most 4096 requests/);
        // The refused request stored nothing.
        expect(await receive({ type: "status", size: 2 }, [])).toMatchObject({
            upload: { received: [{ start: 0, end: 0 }] },
        });
        // Cancelling lets the file start again.
        await attachments.delete(ctx, "agentone", id);
        await send(0);
        expect(await send(1)).toMatchObject({ attachment: { id } });
    });

    it("cancels uploads and unsent attachments, but keeps a sent one", async () => {
        const { ctx, attachments, upload } = await world();
        const bytes = Buffer.from("abcdef");
        const id = sha256(bytes);
        const file = { name: "a.txt", contentType: undefined };
        await attachments.receive(
            ctx,
            "agentone",
            null,
            id,
            file,
            { type: "bytes", start: 0, end: 2, size: 6 },
            body(bytes.subarray(0, 3)),
        );
        await attachments.delete(ctx, "agentone", id);
        expect(await code(attachments.delete(ctx, "agentone", id))).toBe("not_found");
        expect(
            await attachments.receive(
                ctx,
                "agentone",
                null,
                id,
                file,
                { type: "status", size: 6 },
                body(),
            ),
        ).toMatchObject({ upload: { received: [] } });

        const unsent = await upload("agentone", "u.txt", Buffer.from("unsent"));
        await attachments.delete(ctx, "agentone", unsent);
        expect(await code(attachments.content(ctx, "agentone", unsent))).toBe("not_found");

        const sent = await upload("agentone", "s.txt", Buffer.from("sent"));
        await attachments.send(ctx, "agentone", [
            { type: "file", attachment: sent, name: "s.txt" },
        ]);
        expect(await code(attachments.delete(ctx, "agentone", sent))).toBe("conflict");
    });

    it("shows the model small pictures and text, and names everything else", async () => {
        const { config, ctx, attachments, upload } = await world();
        const picture = await sharp({
            create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
        })
            .png()
            .toBuffer();
        const image = await upload("agentone", "shot.png", picture, "image/png");
        const text = await upload("agentone", "notes.md", Buffer.from("# Notes\nline two\n"));
        const large = await upload("agentone", "big.txt", Buffer.alloc(256 * 1024 + 1, "a"));
        const binary = await upload("agentone", "blob.bin", Buffer.from([0, 1, 2, 3]));
        const gone = await upload("agentone", "gone.txt", Buffer.from("removed bytes"));
        await rm(config.attachmentContentPath(gone));
        const files = [
            { type: "file" as const, attachment: image, name: "shot.png" },
            { type: "file" as const, attachment: text, name: 'my "notes".md' },
            { type: "file" as const, attachment: large, name: "big.txt" },
            { type: "file" as const, attachment: binary, name: "blob.bin" },
            { type: "file" as const, attachment: gone, name: "gone.txt" },
            {
                type: "file" as const,
                attachment: sha256(Buffer.from("never uploaded")),
                name: "x.txt",
            },
        ];
        const bodies = await attachments.modelBodies(ctx, "agentone", files);
        const blocks = await attachments.send(ctx, "agentone", files.slice(0, 5));
        const inputs = blocks.map((block) => attachments.modelInput(block, bodies));

        expect(inputs[0]).toEqual([
            {
                type: "text",
                text: `[Attachment ${image}: "shot.png", image/png, ${String(picture.byteLength)} bytes. It is shown below; read_attachment opens it again or saves a copy.]`,
            },
            { type: "image", mimeType: "image/png", data: expect.any(String) },
        ]);
        expect(inputs[1]).toEqual([
            {
                type: "text",
                text: `[Attachment ${text}: "my \\"notes\\".md", text/markdown, 17 bytes. Its text follows; read_attachment reads it by line or saves a copy.]\n<file name="my &quot;notes&quot;.md">\n# Notes\nline two\n</file>`,
            },
        ]);
        for (const [index, id, described] of [
            [2, large, `"big.txt", text/plain, 256 KB`],
            [3, binary, `"blob.bin", application/octet-stream, 4 bytes`],
            [4, gone, `"gone.txt", text/plain, 13 bytes`],
        ] as const) {
            expect(inputs[index]).toEqual([
                {
                    type: "text",
                    text: `[Attachment ${id}: ${described}. Open it with read_attachment.]`,
                },
            ]);
        }
        expect(bodies.get(files[5]!.attachment)).toEqual({ type: "none" });
    });

    it("shows a picture whose file is larger than an image may be by encoding it smaller", async () => {
        const { ctx, attachments, upload, tool } = await world();
        // Noise does not compress, so this PNG fits 2000 px yet holds about 3.4 MiB.
        const noise = await sharp(randomBytes(1200 * 1000 * 3), {
            raw: { width: 1200, height: 1000, channels: 3 },
        })
            .png({ compressionLevel: 0 })
            .toBuffer();
        expect(noise.byteLength).toBeGreaterThan(3 * 1024 * 1024);
        expect(noise.byteLength).toBeLessThan(5 * 1024 * 1024);
        const id = await upload("agentone", "noise.png", noise, "image/png");
        const files = [{ type: "file" as const, attachment: id, name: "noise.png" }];
        const bodies = await attachments.modelBodies(ctx, "agentone", files);
        const [block] = await attachments.send(ctx, "agentone", files);
        const [, image] = attachments.modelInput(block!, bodies);
        expect(image).toMatchObject({ type: "image", mimeType: "image/webp" });
        const encoded = Buffer.from((image as { data: string }).data, "base64");
        expect(encoded.byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
        expect(await sharp(encoded).metadata()).toMatchObject({ format: "webp" });
        // read_attachment shows it the same way.
        const read = await tool("agentone");
        expect(await read.execute(ctx, { attachment_id: id }, {} as never)).toMatchObject({
            image: { mimeType: "image/webp" },
        });
    });

    it("keeps a large picture's orientation when it is encoded smaller", async () => {
        const { ctx, attachments, upload } = await world();
        for (const orientation of [6, 8]) {
            // Stored 1500 wide and 1000 tall, shown turned a quarter: 1000 wide and 1500 tall.
            const photo = await sharp(randomBytes(1500 * 1000 * 3), {
                raw: { width: 1500, height: 1000, channels: 3 },
            })
                .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
                .withMetadata({ orientation })
                .toBuffer();
            expect(photo.byteLength).toBeGreaterThan(3 * 1024 * 1024);
            expect(photo.byteLength).toBeLessThan(5 * 1024 * 1024);
            const id = await upload("agentone", "photo.jpg", photo, "image/jpeg");
            const files = [{ type: "file" as const, attachment: id, name: "photo.jpg" }];
            const bodies = await attachments.modelBodies(ctx, "agentone", files);
            const [block] = await attachments.send(ctx, "agentone", files);
            const [, image] = attachments.modelInput(block!, bodies);
            const shown = await sharp(
                Buffer.from((image as { data: string }).data, "base64"),
            ).metadata();
            expect(shown).toMatchObject({ format: "webp", width: 1000, height: 1500 });
            expect(shown.orientation ?? 1).toBe(1);
        }
    });

    it("resolves a message's files, and refuses ones the conversation does not hold", async () => {
        const { ctx, attachments, upload } = await world();
        const id = await upload("agentone", "a.txt", Buffer.from("hello"));
        const blocks = await attachments.send(ctx, "agentone", [
            { type: "file", attachment: id, name: "renamed.txt" },
            { type: "file", attachment: id, name: "\u0000" },
        ]);
        expect(blocks).toEqual([
            {
                type: "file",
                attachment: id,
                name: "renamed.txt",
                mimeType: "text/plain",
                size: 5,
                kind: "file",
            },
            {
                type: "file",
                attachment: id,
                name: "a.txt",
                mimeType: "text/plain",
                size: 5,
                kind: "file",
            },
        ]);
        expect(
            await code(
                attachments.send(ctx, "agenttwo", [{ type: "file", attachment: id, name: "a" }]),
            ),
        ).toBe("attachment_not_found");
        expect(
            await code(
                attachments.send(
                    ctx,
                    "agentone",
                    Array.from({ length: 33 }, () => ({
                        type: "file" as const,
                        attachment: id,
                        name: "a",
                    })),
                ),
            ),
        ).toBe("invalid_request");
    });

    it("keeps shared content until no conversation holds it", async () => {
        const { config, ctx, attachments, upload, erase } = await world();
        const bytes = Buffer.from("the same bytes");
        const id = await upload("agentone", "one.txt", bytes);
        await upload("agenttwo", "two.txt", bytes);
        await attachments.send(ctx, "agentone", [
            { type: "file", attachment: id, name: "one.txt" },
        ]);
        const content = config.attachmentContentPath(id);
        await attachments.delete(ctx, "agenttwo", id);
        await attachments.collect(ctx, Date.now() + HOUR);
        expect(await exists(content)).toBe(true);

        // Erasing the last conversation holding it frees it.
        await erase("agentone");
        await attachments.collect(ctx, Date.now() + HOUR);
        expect(await exists(content)).toBe(false);
    });

    it("discards unsent attachments and uploads a day after their last bytes, with stray files", async () => {
        const { config, ctx, attachments, upload } = await world();
        const ready = await upload("agentone", "ready.txt", Buffer.from("ready"));
        const sent = await upload("agentone", "sent.txt", Buffer.from("sent"));
        await attachments.send(ctx, "agentone", [
            { type: "file", attachment: sent, name: "sent.txt" },
        ]);
        const partial = sha256(Buffer.from("partial!!!"));
        await attachments.receive(
            ctx,
            "agentone",
            null,
            partial,
            { name: "partial.bin", contentType: undefined },
            { type: "bytes", start: 0, end: 3, size: 10 },
            body(Buffer.from("part")),
        );
        const uploads = join(config.attachmentsHome, "uploads");
        const stray = join(uploads, "strayuploadfile");
        await writeFile(stray, "left behind");
        const old = new Date(Date.now() - 2 * 24 * HOUR);
        await utimes(stray, old, old);

        await attachments.maintain(ctx, Date.now() + 25 * HOUR);
        expect(await code(attachments.content(ctx, "agentone", ready))).toBe("not_found");
        expect(await exists(config.attachmentContentPath(ready))).toBe(false);
        expect((await attachments.content(ctx, "agentone", sent)).sha256).toBe(sent);
        expect(await readdir(uploads)).toEqual([]);
    });

    it("shows images fitted and text a page at a time, and saves a copy only where asked", async () => {
        const { compute, ctx, attachments, upload, tool } = await world();
        const picture = await sharp({
            create: { width: 3000, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } },
        })
            .png()
            .toBuffer();
        const image = await upload("agentone", "wide.png", picture);
        const lines = Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`);
        const text = await upload("agentone", "log.txt", Buffer.from(lines.join("\n")));
        const binary = await upload("agentone", "b.bin", Buffer.from([0, 1, 2, 0]));
        const unsent = await upload("agentone", "unsent.txt", Buffer.from("secret"));
        await attachments.send(
            ctx,
            "agentone",
            [image, text, binary].map((id) => ({
                type: "file" as const,
                attachment: id,
                name: "f",
            })),
        );
        const read = await tool("agentone");
        const filesBefore = compute.files.size;

        const shown = await read.execute(ctx, { attachment_id: image }, {} as never);
        expect(shown.path).toBeUndefined();
        const metadata = await sharp(Buffer.from(shown.image.data, "base64")).metadata();
        expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(2000);
        const page = await read.execute(
            withAgentPermissionMode(ctx, "read_only"),
            { attachment_id: text, offset: 10, limit: 5 },
            {} as never,
        );
        expect(page).toMatchObject({
            text: "10\tline 10\n11\tline 11\n12\tline 12\n13\tline 13\n14\tline 14",
            totalLines: 30,
            nextOffset: 15,
        });
        expect(compute.files.size).toBe(filesBefore);

        const saved = await read.execute(
            ctx,
            { attachment_id: binary, path: "scratch/in/b.bin" },
            {} as never,
        );
        expect(saved).toMatchObject({ path: "/workspace/scratch/in/b.bin" });
        expect(compute.files.get(saved.path)?.bytes).toEqual(new Uint8Array([0, 1, 2, 0]));
        compute.write("/workspace/scratch/in/b.bin", "the agent's own edit");
        await expect(
            read.execute(ctx, { attachment_id: binary, path: "scratch/in/b.bin" }, {} as never),
        ).rejects.toThrow(/already exists\. Pass overwrite: true/u);

        const review = (path?: string) =>
            read.shouldReviewInAutoMode(
                { attachment_id: text, ...(path === undefined ? {} : { path }) },
                ctx,
            );
        expect(await review()).toBe(false);
        expect(await review("notes/log.txt")).toBe(false);
        expect(await review("/elsewhere/log.txt")).toBe(true);

        // Unsent and other conversations' attachments do not exist for the model.
        for (const [agentId, id] of [
            ["agentone", unsent],
            ["agenttwo", text],
        ] as const) {
            expect(
                await (await tool(agentId)).execute(ctx, { attachment_id: id }, {} as never),
            ).toMatchObject({ note: "No attachment with this ID was sent in this conversation." });
        }
    });
});
