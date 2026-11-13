import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { Type } from "@sinclair/typebox";
import type {
    AgentModule,
    AgentModuleAgentLifecycle,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { afterCommit, delay, type Context } from "@steve.kite/stdlib";

import type { ChatMediaDescription, ChatMediaModule } from "../chatMedia/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import type { DurableFunctionsModule } from "../durableFunctions/index.js";
import type { HistoryFileBlock } from "../history/index.js";
import {
    ATTACHMENT_LIFETIME_MS,
    AttachmentError,
    attachmentResource,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENT_CHUNKS,
    MAX_ATTACHMENT_REQUEST_BYTES,
    MAX_MESSAGE_FILES,
    uploadResource,
    type AttachmentChunkResult,
    type AttachmentContent,
    type AttachmentResource,
    type AttachmentUploader,
    type FileRequestBlock,
    type StoredAttachment,
    type StoredUpload,
} from "./Attachment.js";
import { attachmentsMigrations } from "./AttachmentsMigrations.js";
import {
    createUploadFile,
    fileExists,
    hashFile,
    snapshotUploadFile,
    receiveWholeFile,
    removeFile,
    storeUploadedContent,
    writeUploadChunk,
} from "./impl/attachmentFiles.js";
import { attachmentNote } from "./impl/attachmentNote.js";
import { addByteRange, byteRangesComplete } from "./impl/byteRanges.js";
import * as store from "./persistence/attachmentStore.js";
import { readAttachmentTool } from "./tools/read_attachment.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAINTAIN = "attachments.maintain";
const BATCH = 100;
/** The lock that orders storing new content against collecting unused content. */
const CONTENT_LOCK = "content";

/** What an upload request names: the file's name and the media type it was sent as. */
export interface AttachmentFileInfo {
    readonly name: string;
    /** The request's `Content-Type`, as sent. */
    readonly contentType: string | undefined;
}

/** Where a chunk request puts its body. */
export type AttachmentChunkRange =
    /** No `Content-Range`: the body is the whole file. */
    | { readonly type: "whole" }
    // `bytes */size` with no body: where the upload stands.
    | { readonly type: "status"; readonly size: number }
    | {
          readonly type: "bytes";
          readonly start: number;
          readonly end: number;
          readonly size: number;
      };

/**
 * Files people attach to their messages. A file is uploaded to one conversation, whole or in
 * chunks that may arrive in any order, and is named by the SHA-256 of its bytes, so the same bytes
 * in one conversation are one attachment. Content is stored once per digest in a private folder.
 * `send` checks a message's files in its own transaction, and the model reads each through
 * `read_attachment` instead of receiving its bytes.
 */
export class AttachmentsModule implements AgentModule {
    readonly name = "attachments";
    readonly migrations = attachmentsMigrations;

    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #chatMedia: ChatMediaModule;
    readonly #compute: ComputeModule;
    readonly #locks = new Map<string, Promise<unknown>>();

    constructor(
        config: ConfigModule,
        durableFunctions: DurableFunctionsModule,
        chatMedia: ChatMediaModule,
        compute: ComputeModule,
    ) {
        this.#config = config;
        this.#durable = durableFunctions;
        this.#chatMedia = chatMedia;
        this.#compute = compute;
        // Expired uploads, unused content, and stray upload files go in one hourly pass that
        // survives restarts; a failed pass does not end the chain.
        durableFunctions.register({
            name: MAINTAIN,
            argumentsSchema: Type.Object({ at: Type.Integer({ minimum: 0 }) }),
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                const wait = call.arguments.at - Date.now();
                if (wait > 0) await delay(ctx, wait);
                try {
                    await this.maintain(ctx, Date.now());
                } catch (error) {
                    if (ctx.lifetime?.aborted === true) throw error;
                    ctx.log.error({ error }, "An attachment maintenance pass failed.");
                }
                return null;
            },
            onSuccess: async (ctx) => {
                await this.#schedule(ctx, Date.now() + HOUR);
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => [
            readAttachmentTool(
                this,
                this.#compute,
                await this.#compute.resolve(ctx, scope.agent.id),
                scope.agent.id,
            ),
        ],
        afterStart: async (ctx: Context) => {
            await this.#schedule(ctx, Date.now());
        },
        agentErasedTransact: async (ctx, _scope, agent: AgentModuleAgentLifecycle) => {
            await this.#erase(ctx, agent.id);
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    // Uploading

    /** Receive a whole file in one request. Bytes the conversation holds answer that attachment. */
    async upload(
        ctx: Context,
        agentId: string,
        uploader: AttachmentUploader,
        file: AttachmentFileInfo,
        body: AsyncIterable<Uint8Array>,
    ): Promise<AttachmentResource> {
        const name = fileName(file.name);
        const fileId = createId();
        const received = await receiveWholeFile(
            this.#config.attachmentUploadPath(fileId),
            MAX_ATTACHMENT_REQUEST_BYTES,
            body,
        );
        if (received === undefined) throw tooLarge();
        return await this.#serialized(
            uploadKey(agentId, received.sha256),
            async () =>
                await this.#keep(ctx, {
                    agentId,
                    id: received.sha256,
                    size: received.size,
                    fileId,
                    name,
                    contentType: specificContentType(file.contentType),
                    uploader,
                }),
        );
    }

    /**
     * Receive one chunk of a file uploaded in parts, or answer where its upload stands. Chunks may
     * arrive in any order and at the same time: each writes its own range, and only the
     * bookkeeping runs one request at a time. The last missing byte checks the file against its
     * ID and makes it the attachment.
     */
    async receive(
        ctx: Context,
        agentId: string,
        uploader: AttachmentUploader,
        attachmentId: string,
        file: AttachmentFileInfo,
        range: AttachmentChunkRange,
        body: AsyncIterable<Uint8Array>,
    ): Promise<AttachmentChunkResult> {
        const key = uploadKey(agentId, attachmentId);
        const name = fileName(file.name);
        if (range.type === "whole") {
            const held = await this.#serialized(key, () =>
                this.#holdIfPresent(ctx, agentId, attachmentId),
            );
            if (held !== undefined) return { attachment: held };
            const fileId = createId();
            const received = await receiveWholeFile(
                this.#config.attachmentUploadPath(fileId),
                MAX_ATTACHMENT_REQUEST_BYTES,
                body,
            );
            if (received === undefined) throw tooLarge();
            if (received.sha256 !== attachmentId) {
                await removeFile(this.#config.attachmentUploadPath(fileId));
                throw mismatch();
            }
            return {
                attachment: await this.#serialized(
                    key,
                    async () =>
                        await this.#keep(ctx, {
                            agentId,
                            id: attachmentId,
                            size: received.size,
                            fileId,
                            name,
                            contentType: specificContentType(file.contentType),
                            uploader,
                        }),
                ),
            };
        }
        if (range.size > MAX_ATTACHMENT_BYTES) throw tooLarge();
        if (range.type === "bytes") {
            if (range.end < range.start || range.end >= range.size) {
                throw new AttachmentError(
                    "invalid_request",
                    "The Content-Range is outside the file.",
                );
            }
            if (range.end - range.start + 1 > MAX_ATTACHMENT_REQUEST_BYTES) throw tooLarge();
        }
        const started = await this.#serialized(key, async () => {
            const result = await this.#start(ctx, {
                agentId,
                id: attachmentId,
                size: range.size,
                name,
                contentType: specificContentType(file.contentType),
                uploader,
            });
            if ("attachment" in result || range.type === "status") return result;
            return { upload: await this.#countChunk(ctx, result.upload) };
        });
        if ("attachment" in started || range.type === "status") return started;
        const upload = started.upload;
        const length = range.end - range.start + 1;
        const written = await writeUploadChunk(
            this.#config.attachmentUploadPath(upload.fileId),
            range.start,
            length,
            body,
        );
        if (written !== length) {
            throw new AttachmentError(
                "invalid_request",
                `The body holds ${written > length ? "more" : "fewer"} bytes than its Content-Range.`,
            );
        }
        return await this.#serialized(key, async () => {
            const current = await ctx.inTx((txCtx) =>
                store.queryUpload(txCtx, agentId, attachmentId),
            );
            if (current?.fileId !== upload.fileId) {
                // Another chunk may have finished the file meanwhile.
                const finished = await this.#holdIfPresent(ctx, agentId, attachmentId);
                if (finished !== undefined) return { attachment: finished };
                throw new AttachmentError(
                    "not_found",
                    "The upload was cancelled or expired; upload the file again.",
                );
            }
            const next: StoredUpload = {
                ...current,
                received: addByteRange(current.received, { start: range.start, end: range.end }),
                expiresAt: Date.now() + ATTACHMENT_LIFETIME_MS,
            };
            if (byteRangesComplete(next.received, next.size)) {
                return { attachment: await this.#finish(ctx, next) };
            }
            await ctx.inTx((txCtx) => store.updateUploadReceived(txCtx, next));
            return { upload: uploadResource(next) };
        });
    }

    /** A stored attachment's bytes, for anyone who may read the conversation. */
    async content(ctx: Context, agentId: string, attachmentId: string): Promise<AttachmentContent> {
        const row = await ctx.inTx((txCtx) => this.#live(txCtx, agentId, attachmentId));
        if (row === undefined) {
            throw new AttachmentError("not_found", "The attachment was not found.");
        }
        return contentOf(this.#config, row);
    }

    /**
     * Cancel an upload still receiving bytes, or discard an attachment no message has sent, with
     * its bytes. A sent attachment stays with its message.
     */
    async delete(ctx: Context, agentId: string, attachmentId: string): Promise<void> {
        await this.#serialized(uploadKey(agentId, attachmentId), async () => {
            const cancelled = await ctx.inTx(async (txCtx) => {
                const attachment = await store.queryAttachment(txCtx, agentId, attachmentId);
                if (attachment?.sentAt !== null && attachment?.sentAt !== undefined) {
                    throw new AttachmentError(
                        "conflict",
                        "A message has sent this attachment, so it stays with that message.",
                    );
                }
                const upload = await store.queryUpload(txCtx, agentId, attachmentId);
                if (attachment === undefined && upload === undefined) {
                    throw new AttachmentError("not_found", "The attachment was not found.");
                }
                if (attachment !== undefined) {
                    await store.deleteAttachment(txCtx, agentId, attachmentId);
                    await store.addAttachmentGarbage(txCtx, [attachmentId], Date.now());
                }
                if (upload !== undefined) await store.deleteUpload(txCtx, agentId, attachmentId);
                return upload;
            });
            if (cancelled !== undefined) {
                await removeFile(this.#config.attachmentUploadPath(cancelled.fileId));
            }
        });
    }

    // Sending

    /**
     * Resolve the files a person's message names, in the caller's transaction, and answer each as
     * the message's block. Each must be an attachment of this conversation; sending it ends its
     * 24 hours. The same attachment may be sent by any number of messages.
     */
    async send(
        ctx: Context,
        agentId: string,
        files: readonly FileRequestBlock[],
    ): Promise<readonly HistoryFileBlock[]> {
        if (files.length > MAX_MESSAGE_FILES) {
            throw new AttachmentError(
                "invalid_request",
                `A message names at most ${String(MAX_MESSAGE_FILES)} files.`,
            );
        }
        if (files.length === 0) return [];
        return await ctx.inTx(async (txCtx) => {
            const now = Date.now();
            const blocks: HistoryFileBlock[] = [];
            for (const file of files) {
                const row = await this.#live(txCtx, agentId, file.attachment);
                if (row === undefined) {
                    throw new AttachmentError(
                        "attachment_not_found",
                        "A file in the message was not uploaded to this conversation. It may have expired; attach it again.",
                    );
                }
                if (row.sentAt === null) {
                    await store.updateAttachmentLifetime(txCtx, {
                        agentId,
                        id: row.id,
                        sentAt: now,
                        expiresAt: null,
                    });
                }
                blocks.push(fileBlock(row, cleanName(file.name) ?? row.name));
            }
            return blocks;
        });
    }

    /** The line the model reads in place of one attached file. */
    note(block: HistoryFileBlock): string {
        return attachmentNote(block);
    }

    /**
     * A sent attachment of this conversation and its bytes, for the model. Undefined when there is
     * none, or its bytes are gone.
     */
    async readable(
        ctx: Context,
        agentId: string,
        attachmentId: string,
    ): Promise<
        { readonly attachment: AttachmentResource; readonly content: AttachmentContent } | undefined
    > {
        const row = await ctx.inTx((txCtx) => store.queryAttachment(txCtx, agentId, attachmentId));
        if (row?.sentAt === null || row === undefined) return undefined;
        const content = contentOf(this.#config, row);
        if (!(await fileExists(content.contentPath))) return undefined;
        return { attachment: attachmentResource(row), content };
    }

    // Maintenance

    /** Discard expired attachments and uploads, delete unused content, and sweep stray files. */
    async maintain(ctx: Context, now: number): Promise<void> {
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const count = await ctx.inTx(async (txCtx) => {
                const rows = await store.queryExpiredAttachments(txCtx, now, BATCH);
                for (const row of rows) await store.deleteAttachment(txCtx, row.agentId, row.id);
                await store.addAttachmentGarbage(
                    txCtx,
                    rows.map((row) => row.id),
                    now,
                );
                return rows.length;
            });
            if (count < BATCH) break;
        }
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const expired = await ctx.inTx(async (txCtx) => {
                const rows = await store.queryExpiredUploads(txCtx, now, BATCH);
                for (const row of rows) await store.deleteUpload(txCtx, row.agentId, row.id);
                return rows;
            });
            for (const row of expired) {
                await removeFile(this.#config.attachmentUploadPath(row.fileId));
            }
            if (expired.length < BATCH) break;
        }
        await this.collect(ctx, now);
        await this.#sweepStrays(ctx, now);
    }

    /** Delete stored content no conversation holds, once its wait is over. */
    async collect(ctx: Context, now: number): Promise<void> {
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const count = await this.#serialized(CONTENT_LOCK, async () =>
                ctx.inTx(async (txCtx) => {
                    const digests = await store.queryDueAttachmentGarbage(txCtx, now, BATCH);
                    for (const digest of digests) {
                        if (!(await store.queryAttachmentContentHeld(txCtx, digest))) {
                            await removeFile(this.#config.attachmentContentPath(digest));
                        }
                        await store.deleteAttachmentGarbage(txCtx, digest);
                    }
                    return digests.length;
                }),
            );
            if (count < BATCH) return;
        }
    }

    // Internals

    /** The conversation's attachment, kept another 24 hours when it is unsent. */
    async #holdIfPresent(
        ctx: Context,
        agentId: string,
        attachmentId: string,
    ): Promise<AttachmentResource | undefined> {
        return await ctx.inTx(async (txCtx) => {
            const row = await this.#live(txCtx, agentId, attachmentId);
            if (row === undefined) return undefined;
            if (row.sentAt === null) {
                await store.updateAttachmentLifetime(txCtx, {
                    ...row,
                    expiresAt: Date.now() + ATTACHMENT_LIFETIME_MS,
                });
            }
            return attachmentResource(row);
        });
    }

    /**
     * The upload of this ID, started now when there is none, or the attachment when the
     * conversation already holds it. A zero-byte file is done at once.
     */
    async #start(
        ctx: Context,
        input: {
            readonly agentId: string;
            readonly id: string;
            readonly size: number;
            readonly name: string;
            readonly contentType: string | null;
            readonly uploader: AttachmentUploader;
        },
    ): Promise<{ readonly attachment: AttachmentResource } | { readonly upload: StoredUpload }> {
        const held = await this.#holdIfPresent(ctx, input.agentId, input.id);
        if (held !== undefined) return { attachment: held };
        const now = Date.now();
        const existing = await ctx.inTx((txCtx) =>
            store.queryUpload(txCtx, input.agentId, input.id),
        );
        if (existing !== undefined && existing.expiresAt > now) {
            if (existing.size !== input.size) {
                throw new AttachmentError(
                    "invalid_request",
                    `The upload is ${String(existing.size)} bytes; the Content-Range says otherwise.`,
                );
            }
            return { upload: existing };
        }
        if (existing !== undefined) {
            await ctx.inTx((txCtx) => store.deleteUpload(txCtx, input.agentId, input.id));
            await removeFile(this.#config.attachmentUploadPath(existing.fileId));
        }
        const upload: StoredUpload = {
            agentId: input.agentId,
            id: input.id,
            fileId: createId(),
            name: input.name,
            contentType: input.contentType,
            size: input.size,
            received: [],
            chunks: 0,
            uploadedBy: input.uploader,
            createdAt: now,
            expiresAt: now + ATTACHMENT_LIFETIME_MS,
        };
        const path = this.#config.attachmentUploadPath(upload.fileId);
        await createUploadFile(path);
        try {
            await ctx.inTx((txCtx) => store.insertUpload(txCtx, upload));
        } catch (error) {
            await removeFile(path);
            throw error;
        }
        if (upload.size === 0) return { attachment: await this.#finish(ctx, upload) };
        return { upload };
    }

    /**
     * Count a request carrying bytes against its upload before any of them are written, refusing
     * it once the upload has taken its 4,096. The caller holds this ID's lock.
     */
    async #countChunk(ctx: Context, upload: StoredUpload): Promise<StoredUpload> {
        if (upload.chunks >= MAX_ATTACHMENT_CHUNKS) {
            throw new AttachmentError(
                "invalid_request",
                `An upload takes at most ${String(MAX_ATTACHMENT_CHUNKS)} requests carrying bytes; cancel it and upload the file again.`,
            );
        }
        const counted = { ...upload, chunks: upload.chunks + 1 };
        await ctx.inTx((txCtx) => store.updateUploadChunks(txCtx, counted));
        return counted;
    }

    /**
     * Check a complete upload against its ID and make it the attachment. A request that resent
     * a chunk may still be writing into the upload's file, so a copy is checked and stored, and
     * ending the upload removes the file the requests write.
     */
    async #finish(ctx: Context, upload: StoredUpload): Promise<AttachmentResource> {
        const fileId = createId();
        const path = this.#config.attachmentUploadPath(fileId);
        await snapshotUploadFile(this.#config.attachmentUploadPath(upload.fileId), path);
        if ((await hashFile(path)) !== upload.id) {
            await removeFile(path);
            await this.#endUpload(ctx, upload.agentId, upload.id);
            throw mismatch();
        }
        return await this.#keep(ctx, {
            agentId: upload.agentId,
            id: upload.id,
            size: upload.size,
            fileId,
            name: upload.name,
            contentType: upload.contentType,
            uploader: upload.uploadedBy,
        });
    }

    /**
     * Make a received file, whose digest is `id`, an attachment of the conversation: measure it,
     * store its bytes under their digest, and record it, ending any upload of the same ID. When
     * the conversation already holds it, the file is dropped and the attachment is kept another
     * 24 hours. The caller holds this ID's lock.
     */
    async #keep(
        ctx: Context,
        input: {
            readonly agentId: string;
            readonly id: string;
            readonly size: number;
            readonly fileId: string;
            readonly name: string;
            readonly contentType: string | null;
            readonly uploader: AttachmentUploader;
        },
    ): Promise<AttachmentResource> {
        const path = this.#config.attachmentUploadPath(input.fileId);
        const held = await this.#holdIfPresent(ctx, input.agentId, input.id);
        if (held !== undefined) {
            await this.#endUpload(ctx, input.agentId, input.id);
            await removeFile(path);
            return held;
        }
        const measured = await this.#chatMedia.describe(path, input.name, input.size);
        // Happy Cloud cannot decode AVIF, so an AVIF attachment is a plain file on every server.
        const description: ChatMediaDescription =
            measured.kind === "image" && measured.mimeType === "image/avif"
                ? { kind: "file", name: measured.name, mimeType: measured.mimeType }
                : measured;
        const now = Date.now();
        const row: StoredAttachment = {
            agentId: input.agentId,
            id: input.id,
            name: input.name,
            kind: description.kind,
            // A decoded picture is what its bytes say; anything else is what it was sent as.
            mimeType:
                description.kind === "image"
                    ? description.mimeType
                    : (input.contentType ?? description.mimeType),
            size: input.size,
            width: description.kind === "image" ? description.width : null,
            height: description.kind === "image" ? description.height : null,
            thumbhash: description.kind === "image" ? description.thumbhash : null,
            scale: description.kind === "image" ? (description.scale ?? null) : null,
            uploadedBy: input.uploader,
            createdAt: now,
            sentAt: null,
            expiresAt: now + ATTACHMENT_LIFETIME_MS,
        };
        await this.#serialized(CONTENT_LOCK, async () => {
            // Noted first, so content stored by an attempt that fails before its row is written is
            // still collected; the row then holds it.
            await ctx.inTx((txCtx) => store.addAttachmentGarbage(txCtx, [input.id], now));
            await storeUploadedContent(path, this.#config.attachmentContentPath(input.id));
            await ctx.inTx((txCtx) => store.insertAttachment(txCtx, row));
        });
        await this.#endUpload(ctx, input.agentId, input.id);
        return attachmentResource(row);
    }

    /** End an upload of this ID that the attachment now replaces, with its private file. */
    async #endUpload(ctx: Context, agentId: string, attachmentId: string): Promise<void> {
        const upload = await ctx.inTx(async (txCtx) => {
            const found = await store.queryUpload(txCtx, agentId, attachmentId);
            if (found !== undefined) await store.deleteUpload(txCtx, agentId, attachmentId);
            return found;
        });
        // The file chunk requests write into; what was stored is a copy of it.
        if (upload !== undefined) {
            await removeFile(this.#config.attachmentUploadPath(upload.fileId));
        }
    }

    /** One attachment of the conversation that has not expired. */
    async #live(
        ctx: Context,
        agentId: string,
        attachmentId: string,
    ): Promise<StoredAttachment | undefined> {
        const row = await store.queryAttachment(ctx, agentId, attachmentId);
        if (row === undefined || (row.expiresAt !== null && row.expiresAt <= Date.now())) {
            return undefined;
        }
        return row;
    }

    async #erase(ctx: Context, agentId: string): Promise<void> {
        const { digests, fileIds } = await store.deleteAgentAttachments(ctx, agentId);
        await store.addAttachmentGarbage(ctx, digests, Date.now());
        if (fileIds.length === 0) return;
        // A crash before this runs leaves the files to the stray sweep.
        afterCommit(ctx, async () => {
            for (const fileId of fileIds) {
                await removeFile(this.#config.attachmentUploadPath(fileId));
            }
        });
    }

    /** Files in the upload folder that no upload owns, left by an interrupted request. */
    async #sweepStrays(ctx: Context, now: number): Promise<void> {
        const folder = join(this.#config.attachmentsHome, "uploads");
        let names: string[];
        try {
            names = await readdir(folder);
        } catch {
            return;
        }
        for (const name of names.slice(0, 10_000)) {
            const path = join(folder, name);
            try {
                if ((await stat(path)).mtimeMs > now - DAY) continue;
            } catch {
                continue;
            }
            if (!(await ctx.inTx((txCtx) => store.queryUploadFileOwned(txCtx, name)))) {
                await removeFile(path);
            }
        }
    }

    async #schedule(ctx: Context, at: number): Promise<void> {
        await this.#durable.invoke(ctx, {
            function: MAINTAIN,
            arguments: { at },
            operationId: MAINTAIN,
            lockKeys: [MAINTAIN],
        });
    }

    async #serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.#locks.get(key) ?? Promise.resolve();
        const result = previous.then(work, work);
        const settled = result.catch(() => undefined);
        this.#locks.set(key, settled);
        void settled.then(() => {
            if (this.#locks.get(key) === settled) this.#locks.delete(key);
        });
        return await result;
    }
}

function uploadKey(agentId: string, attachmentId: string): string {
    return `${agentId}/${attachmentId}`;
}

function contentOf(config: ConfigModule, row: StoredAttachment): AttachmentContent {
    return {
        contentPath: config.attachmentContentPath(row.id),
        sha256: row.id,
        size: row.size,
        mimeType: row.mimeType,
        name: row.name,
    };
}

/** The block a message keeps for one sent attachment, under the name the message gave it. */
function fileBlock(row: StoredAttachment, name: string): HistoryFileBlock {
    return {
        type: "file",
        attachment: row.id,
        name,
        mimeType: row.mimeType,
        size: row.size,
        kind: row.kind,
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
        ...(row.thumbhash === null ? {} : { thumbhash: row.thumbhash }),
        ...(row.scale === null ? {} : { scale: row.scale }),
    };
}

/** A file name fit for display, or `invalid_request` when none is left. */
function fileName(name: string): string {
    const cleaned = cleanName(name);
    if (cleaned === undefined) {
        throw new AttachmentError(
            "invalid_request",
            "`name` is the file's name, 1-255 characters.",
        );
    }
    return cleaned;
}

/** A name without control characters, at most 255 characters; undefined when nothing is left. */
function cleanName(name: string): string | undefined {
    // oxlint-disable-next-line no-control-regex
    const cleaned = name.replaceAll(/[\u0000-\u001f\u007f]/gu, "").trim();
    const bounded = Array.from(cleaned).slice(0, 255).join("").trim();
    return bounded.length === 0 ? undefined : bounded;
}

/** A request's `Content-Type` when it names a specific media type; generic or missing is null. */
function specificContentType(header: string | undefined): string | null {
    const value = header?.split(";")[0]?.trim().toLowerCase();
    if (value === undefined || value === "application/octet-stream" || value.length > 255) {
        return null;
    }
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value) ? value : null;
}

function tooLarge(): AttachmentError {
    return new AttachmentError(
        "attachment_too_large",
        "An attachment is at most 1 GiB, and one request carries at most 25 MiB.",
    );
}

function mismatch(): AttachmentError {
    return new AttachmentError(
        "hash_mismatch",
        "The bytes do not match the attachment's SHA-256; the upload was discarded.",
    );
}
