import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, truncate } from "node:fs/promises";

import { createId } from "@paralleldrive/cuid2";
import {
    VAULT_UPLOAD_MAX_CHUNK,
    type CreateVaultUploadRequest,
    type VaultUpload,
} from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../../config/index.js";
import { SurfaceError } from "../SurfaceError.js";
import * as store from "./persistence/vaultStore.js";
import { ContentWriter, fileExists, removeFile, storeContent } from "./vaultContentFiles.js";

const LIFETIME = 24 * 60 * 60 * 1000;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Running digests of uploads receiving bytes in order; anything else rehashes the file. */
const MAX_RUNNING_HASHES = 64;

/**
 * Resumable uploads. Bytes accumulate in a private file from the start; when the last byte
 * arrives the digest is recorded and the file becomes stored content. An upload holds its
 * content until it is used, cancelled, or expires.
 */
export class VaultUploads {
    readonly #running = new Map<string, { hash: Hash; at: number }>();
    readonly #locks = new Map<string, Promise<unknown>>();

    constructor(
        readonly config: ConfigModule,
        readonly ensureHome: () => Promise<void>,
        readonly collectLater: (ctx: Context) => Promise<void>,
    ) {}

    async create(ctx: Context, request: CreateVaultUploadRequest): Promise<VaultUpload> {
        await this.ensureHome();
        const now = Date.now();
        const id = createId();
        const path = this.config.vaultUploadPath(id);
        const writer = await ContentWriter.create(path);
        await writer.finish();
        if (request.size === 0) {
            if (request.sha256 !== undefined && request.sha256 !== EMPTY_SHA256) {
                await removeFile(path);
                throw new SurfaceError(
                    "hash_mismatch",
                    "The bytes do not match the expected SHA-256.",
                );
            }
            const upload = {
                id,
                size: 0,
                received: 0,
                expectedSha256: request.sha256 ?? null,
                sha256: EMPTY_SHA256,
                createdAt: now,
                expiresAt: now + LIFETIME,
            };
            await ctx.inTx((tx) => store.insertVaultUpload(tx, upload));
            await storeContent(path, this.config.vaultContentPath(EMPTY_SHA256));
            return resource(upload);
        }
        const upload = {
            id,
            size: request.size,
            received: 0,
            expectedSha256: request.sha256 ?? null,
            sha256: null,
            createdAt: now,
            expiresAt: now + LIFETIME,
        };
        try {
            await ctx.inTx((tx) => store.insertVaultUpload(tx, upload));
        } catch (error) {
            await removeFile(path);
            throw error;
        }
        return resource(upload);
    }

    async get(ctx: Context, uploadId: string): Promise<VaultUpload> {
        return resource(await ctx.inTx((tx) => this.#live(tx, uploadId)));
    }

    /** Discard an unused upload and its bytes. */
    async cancel(ctx: Context, uploadId: string): Promise<void> {
        await this.#serialized(uploadId, () =>
            ctx.inTx(async (tx) => {
                await this.#remove(tx, await this.#live(tx, uploadId));
            }),
        );
    }

    /**
     * Append one range of bytes. `range` is the parsed `Content-Range`, or undefined for the whole
     * upload from byte 0. Requests for one upload run one at a time.
     */
    async receive(
        ctx: Context,
        uploadId: string,
        range: { start: number; end: number; size: number } | undefined,
        body: AsyncIterable<Uint8Array>,
    ): Promise<VaultUpload> {
        return this.#serialized(uploadId, async () => {
            const upload = await ctx.inTx((tx) => this.#live(tx, uploadId));
            if (upload.sha256 !== null)
                throw new SurfaceError("conflict", "The upload is already complete.", {
                    upload: resource(upload),
                });
            const { start, end } = range ?? { start: 0, end: upload.size - 1 };
            if (range !== undefined && range.size !== upload.size)
                throw new SurfaceError(
                    "invalid_request",
                    "The Content-Range size differs from the upload's size.",
                );
            if (end < start || end >= upload.size)
                throw new SurfaceError(
                    "invalid_request",
                    "The Content-Range is outside the upload.",
                );
            const length = end - start + 1;
            if (length > VAULT_UPLOAD_MAX_CHUNK)
                throw new SurfaceError("too_large", "One request carries at most 256 MiB.");
            if (start !== upload.received)
                throw new SurfaceError(
                    "conflict",
                    `The upload has ${String(upload.received)} bytes; resume from there.`,
                    { upload: resource(upload) },
                );
            const path = this.config.vaultUploadPath(uploadId);
            const running = this.#running.get(uploadId);
            const hash = running?.at === start ? running.hash : undefined;
            this.#running.delete(uploadId);
            const file = await open(path, "r+");
            let written = 0;
            try {
                for await (const chunk of body) {
                    if (written + chunk.byteLength > length) {
                        written += chunk.byteLength;
                        break;
                    }
                    let offset = 0;
                    while (offset < chunk.byteLength) {
                        const { bytesWritten } = await file.write(
                            chunk,
                            offset,
                            chunk.byteLength - offset,
                            start + written + offset,
                        );
                        offset += bytesWritten;
                    }
                    hash?.update(chunk);
                    written += chunk.byteLength;
                }
                if (written === length) await file.sync();
            } catch (error) {
                // A broken connection leaves nothing past what the upload has received.
                await file.truncate(start);
                throw error;
            } finally {
                await file.close();
            }
            if (written !== length) {
                await truncate(path, start);
                throw new SurfaceError(
                    "invalid_request",
                    `The body holds ${written > length ? "more" : "fewer"} bytes than its Content-Range.`,
                );
            }
            const received = end + 1;
            const now = Date.now();
            const next = {
                ...upload,
                received,
                expiresAt: Math.max(upload.createdAt, now) + LIFETIME,
            };
            if (received < upload.size) {
                if (hash !== undefined || start === 0) {
                    const kept = hash ?? createHash("sha256");
                    if (hash === undefined) await hashInto(kept, path, 0, received);
                    this.#remember(uploadId, kept, received);
                }
                await ctx.inTx((tx) => store.updateVaultUpload(tx, next));
                return resource(next);
            }
            const digest = hash ?? createHash("sha256");
            if (hash === undefined) await hashInto(digest, path, 0, received);
            const sha256 = digest.digest("hex");
            if (upload.expectedSha256 !== null && upload.expectedSha256 !== sha256) {
                await ctx.inTx((tx) => this.#remove(tx, upload));
                throw new SurfaceError(
                    "hash_mismatch",
                    "The bytes do not match the expected SHA-256; the upload was discarded.",
                );
            }
            const complete = { ...next, sha256 };
            // The digest is recorded before the bytes are stored under it, so collection of the
            // same content always sees this upload holding it.
            await ctx.inTx((tx) => store.updateVaultUpload(tx, complete));
            await storeContent(path, this.config.vaultContentPath(sha256));
            return resource(complete);
        });
    }

    /** A complete, unexpired upload whose content is stored, without using it. */
    async requireComplete(ctx: Context, uploadId: string): Promise<store.StoredVaultUpload> {
        const upload = await this.#live(ctx, uploadId);
        if (upload.sha256 === null)
            throw new SurfaceError("conflict", "The upload is still receiving bytes.", {
                upload: resource(upload),
            });
        if (!(await fileExists(this.config.vaultContentPath(upload.sha256))))
            throw new SurfaceError(
                "not_found",
                "The uploaded content is missing; upload it again.",
            );
        return upload;
    }

    /** Use an upload up in the caller's transaction; its content passes to what placed it. */
    async use(ctx: Context, uploadId: string): Promise<store.StoredVaultUpload> {
        const upload = await this.requireComplete(ctx, uploadId);
        await store.deleteVaultUpload(ctx, uploadId);
        return upload;
    }

    /** Remove every expired upload, in bounded transactions. */
    async expire(ctx: Context, now: number): Promise<void> {
        for (;;) {
            ctx.lifetime?.throwIfAborted();
            const count = await ctx.inTx(async (tx) => {
                const expired = await store.listExpiredVaultUploads(tx, now, 100);
                for (const upload of expired) await this.#remove(tx, upload);
                return expired.length;
            });
            if (count < 100) return;
        }
    }

    async #live(ctx: Context, uploadId: string): Promise<store.StoredVaultUpload> {
        const upload = await store.readVaultUpload(ctx, uploadId);
        if (upload === undefined || upload.expiresAt <= Date.now())
            throw new SurfaceError(
                "not_found",
                "The upload was not found. It may have expired or been used already; upload the file again.",
            );
        return upload;
    }

    async #remove(ctx: Context, upload: store.StoredVaultUpload): Promise<void> {
        this.#running.delete(upload.id);
        await store.deleteVaultUpload(ctx, upload.id);
        await removeFile(this.config.vaultUploadPath(upload.id));
        if (upload.sha256 !== null) {
            await store.addVaultGarbage(ctx, [upload.sha256], Date.now());
            await this.collectLater(ctx);
        }
    }

    #remember(uploadId: string, hash: Hash, at: number): void {
        this.#running.set(uploadId, { hash, at });
        while (this.#running.size > MAX_RUNNING_HASHES)
            this.#running.delete(this.#running.keys().next().value!);
    }

    async #serialized<T>(uploadId: string, work: () => Promise<T>): Promise<T> {
        const previous = this.#locks.get(uploadId) ?? Promise.resolve();
        const result = previous.then(work, work);
        const settled = result.catch(() => undefined);
        this.#locks.set(uploadId, settled);
        void settled.then(() => {
            if (this.#locks.get(uploadId) === settled) this.#locks.delete(uploadId);
        });
        return result;
    }
}

function resource(upload: store.StoredVaultUpload): VaultUpload {
    const fields = {
        id: upload.id,
        size: upload.size,
        received: upload.sha256 === null ? upload.received : upload.size,
        createdAt: upload.createdAt,
        expiresAt: upload.expiresAt,
    };
    return upload.sha256 === null
        ? { ...fields, sha256: null, status: "receiving" }
        : { ...fields, sha256: upload.sha256, status: "complete" };
}

async function hashInto(hash: Hash, path: string, start: number, end: number): Promise<void> {
    if (end <= start) return;
    for await (const chunk of createReadStream(path, { start, end: end - 1 }))
        hash.update(chunk as Buffer);
}
