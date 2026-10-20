import type { IncomingMessage, ServerResponse } from "node:http";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    ARTIFACT_DATA_LIMITS,
    ArtifactDataConflictError,
    ArtifactDataCursorUnavailableError,
    ArtifactDataDevelopment,
    ArtifactDataInputError,
    ArtifactDataModule,
    ArtifactDataNotFoundError,
    ArtifactDataTooLargeError,
    artifactDataVersionSchema,
    artifactDataWriteIdSchema,
    artifactLogBatchSchema,
    type ArtifactDataCondition,
    type ArtifactDataEntry,
    type ArtifactDataSignal,
} from "../artifactData/index.js";
import { artifactStandardFile } from "../artifactData/impl/artifactStandardFiles.js";
import { createSseWriter, type SseWriter } from "../transport/index.js";
import { ApiError, invalidRequest, notFound } from "./ApiError.js";

/** `/v0/artifacts/:artifactId/api/*`, matched on a pathname. */
export const ARTIFACT_DATA_ROUTE = /^\/v0\/artifacts\/([a-z][a-z0-9]*)\/api(?:\/|$)/;

const HEARTBEAT_MS = 15_000;
/** What one change stream may hold unsent before it is ended as too slow. */
const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STREAMS_PER_ARTIFACT = 64;
const MAX_STREAMS = 512;
/** Backlog pages a resuming stream sends before it goes live. */
const BACKLOG_PAGE_SIZE = 1_000;

const setBodySchema = Type.Object(
    { value: Type.Unknown(), writeId: Type.Optional(artifactDataWriteIdSchema) },
    { additionalProperties: false },
);
const deleteBodySchema = Type.Object(
    { writeId: Type.Optional(artifactDataWriteIdSchema) },
    { additionalProperties: false },
);
const integerPattern = /^[1-9][0-9]{0,5}$/;

/**
 * The data API every HTML artifact page reaches at `/api/*` of its own origin, which a client
 * forwards here unchanged. The caller's identity always comes from authentication, never from
 * what the page sends. `happy-agent artifact dev` serves the same routes over development data,
 * whose callers are made-up people.
 */
export class ApiArtifactData {
    readonly #data: ArtifactDataModule | ArtifactDataDevelopment;
    readonly #streams: Set<SseWriter>;
    #open = 0;

    /** `streams` is the server's own set of open event streams, which shutdown closes. */
    constructor(data: ArtifactDataModule | ArtifactDataDevelopment, streams: Set<SseWriter>) {
        this.#data = data;
        this.#streams = streams;
    }

    async handle(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
        // The raw target, never a parsed URL that has already resolved `.` and `..` segments.
        const target = request.url ?? "";
        const queryStart = target.indexOf("?");
        const pathname = queryStart < 0 ? target : target.slice(0, queryStart);
        const query = new URLSearchParams(queryStart < 0 ? "" : target.slice(queryStart + 1));
        const match = /^\/v0\/artifacts\/([a-z][a-z0-9]*)\/api\/v1\/(.+)$/.exec(pathname);
        if (match === null) throw notFound("The artifact API has no such route.");
        const artifactId = match[1] as string;
        const route = match[2] as string;
        const method = request.method ?? "GET";
        if (!(await this.#data.serves(ctx, artifactId)))
            throw notFound("The artifact was not found.");
        try {
            if (route === "client.js" && method === "GET") {
                return this.#sendClient(request, response);
            }
            const standard = artifactStandardFile(route);
            if (standard !== undefined && method === "GET") {
                return sendCached(
                    request,
                    response,
                    standard.bytes,
                    standard.etag,
                    standard.contentType,
                );
            }
            if (route === "me" && method === "GET") {
                return sendJson(response, 200, { user: await this.#data.me(ctx) });
            }
            if (route === "users" && method === "GET") {
                const ids = single(query, "ids");
                const list = ids === undefined || ids === "" ? [] : ids.split(",");
                return sendJson(response, 200, {
                    users: await this.#data.users(ctx, artifactId, list),
                });
            }
            const photo = /^users\/([a-z][a-z0-9]*)\/photo$/.exec(route);
            if (photo !== null && method === "GET") {
                return await this.#sendPhoto(ctx, request, response, photo[1] as string);
            }
            if (route === "kv" && method === "GET") {
                const limit = single(query, "limit");
                const after = single(query, "pageCursor");
                const prefix = single(query, "prefix");
                const page = await this.#data.list(ctx, artifactId, {
                    ...(prefix === undefined ? {} : { prefix }),
                    ...(after === undefined ? {} : { after }),
                    ...(limit === undefined ? {} : { limit: pageSize(limit) }),
                });
                return sendJson(response, 200, {
                    entries: page.entries,
                    nextPageCursor: page.nextAfter ?? null,
                    cursor: page.cursor,
                });
            }
            if (route === "kv/entry") {
                const key = single(query, "key");
                if (key === undefined) throw invalidRequest("Name the key with `key`.");
                if (method === "GET") {
                    const { entry, cursor } = await this.#data.get(ctx, artifactId, key);
                    return sendJson(response, 200, { entry: entry ?? null, cursor });
                }
                if (method === "PUT") {
                    const body = await readJson(request, false);
                    if (!Value.Check(setBodySchema, body) || !("value" in body)) {
                        throw invalidRequest("The body must be `{ value, writeId? }`.");
                    }
                    const condition = writeCondition(request);
                    const written = await this.#data.set(ctx, artifactId, {
                        key,
                        value: body.value,
                        author: { kind: "user", userId: await this.#data.userId(ctx) },
                        ...(body.writeId === undefined ? {} : { writeId: body.writeId }),
                        ...(condition === undefined ? {} : { condition }),
                    });
                    return sendJson(response, 200, written);
                }
                if (method === "DELETE") {
                    const body = await readJson(request, true);
                    if (!Value.Check(deleteBodySchema, body)) {
                        throw invalidRequest("The body must be empty or `{ writeId? }`.");
                    }
                    const condition = writeCondition(request);
                    const written = await this.#data.delete(ctx, artifactId, {
                        key,
                        author: { kind: "user", userId: await this.#data.userId(ctx) },
                        ...(body.writeId === undefined ? {} : { writeId: body.writeId }),
                        ...(condition === undefined ? {} : { condition }),
                    });
                    return sendJson(response, 200, written);
                }
            }
            if (route === "kv/changes" && method === "GET") {
                const since = single(query, "since");
                const prefix = single(query, "prefix");
                const limit = single(query, "limit");
                const page = await this.#data.changes(ctx, artifactId, {
                    ...(since === undefined ? {} : { since: version(since, "since") }),
                    ...(prefix === undefined ? {} : { prefix }),
                    ...(limit === undefined ? {} : { limit: pageSize(limit) }),
                });
                return sendJson(response, 200, page);
            }
            if (route === "kv/events" && method === "GET") {
                return await this.#stream(ctx, request, response, artifactId, query);
            }
            if (route === "debug/log" && method === "POST") {
                const body = await readJson(request, false);
                if (!Value.Check(artifactLogBatchSchema, body)) {
                    throw invalidRequest(
                        "The body must be `{ entries, url? }` with 1–50 valid entries.",
                    );
                }
                return sendJson(response, 200, await this.#data.appendLogs(ctx, artifactId, body));
            }
        } catch (error: unknown) {
            throw apiError(error);
        }
        throw notFound("The artifact API has no such route.");
    }

    #sendClient(request: IncomingMessage, response: ServerResponse): void {
        const { text, etag } = this.#data.clientScript();
        sendCached(
            request,
            response,
            Buffer.from(text, "utf8"),
            etag,
            "text/javascript; charset=utf-8",
        );
    }

    async #sendPhoto(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        userId: string,
    ): Promise<void> {
        const photo = await this.#data.userPhoto(ctx, userId);
        if (photo === undefined) throw notFound("The user has no photo.");
        const headers = {
            "cache-control": "private, max-age=3600, stale-while-revalidate=86400",
            etag: photo.etag,
            vary: "Authorization",
        };
        if (request.headers["if-none-match"] === photo.etag) {
            response.writeHead(304, headers);
            response.end();
            return;
        }
        response.writeHead(200, {
            ...headers,
            "content-length": photo.bytes.byteLength,
            "content-type": photo.contentType,
        });
        response.end(Buffer.from(photo.bytes));
    }

    /**
     * Server-Sent Events for one store. A stream that resumes from a version first sends every
     * change after it, then `ready`, then each committed change as it happens; a fresh stream
     * sends `ready` with the store's current cursor and then live changes. A cursor the store can
     * no longer resume from is `reset`, after which the client reads the store again.
     */
    async #stream(
        ctx: Context,
        request: IncomingMessage,
        response: ServerResponse,
        artifactId: string,
        query: URLSearchParams,
    ): Promise<void> {
        const lastEventId = request.headers["last-event-id"];
        const supplied =
            single(query, "since") ??
            (typeof lastEventId === "string" && lastEventId !== "" ? lastEventId : undefined);
        const since = supplied === undefined ? undefined : version(supplied, "since");
        const prefix = single(query, "prefix") ?? "";
        if (
            this.#open >= MAX_STREAMS ||
            this.#data.subscriberCount(artifactId) >= MAX_STREAMS_PER_ARTIFACT
        ) {
            response.setHeader("retry-after", "5");
            throw new ApiError(
                429,
                "too_many_streams",
                "Too many change streams are open for this artifact.",
            );
        }

        // Subscribe before reading, so nothing committed in between is missed; the backlog and
        // the live changes overlap and are told apart by version.
        const live: ArtifactDataSignal[] = [];
        let deliver: ((signal: ArtifactDataSignal) => void) | undefined;
        const unsubscribe = this.#data.subscribe(artifactId, (signal) => {
            if (deliver === undefined) live.push(signal);
            else deliver(signal);
        });
        let backlog: ArtifactDataEntry[] = [];
        let cursor: string | null;
        let reset = false;
        try {
            if (since === undefined) {
                cursor = (await this.#data.list(ctx, artifactId, { limit: 1 })).cursor;
            } else {
                let after = since;
                cursor = since;
                for (;;) {
                    const page = await this.#data.changes(ctx, artifactId, {
                        since: after,
                        prefix,
                        limit: BACKLOG_PAGE_SIZE,
                    });
                    backlog = backlog.concat(page.changes);
                    cursor = page.cursor;
                    if (!page.hasMore || page.cursor === null) break;
                    after = page.cursor;
                    if (backlog.length >= ARTIFACT_DATA_LIMITS.pageSize * 10) {
                        // Too far behind to replay: reading the store again is cheaper.
                        reset = true;
                        break;
                    }
                }
            }
        } catch (error: unknown) {
            if (!(error instanceof ArtifactDataCursorUnavailableError)) {
                unsubscribe();
                throw error;
            }
            reset = true;
            cursor = null;
        }

        response.writeHead(200, {
            "cache-control": "no-store",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            "x-accel-buffering": "no",
        });
        const writer = createSseWriter(request, response, {
            maxBufferedBytes: MAX_STREAM_BUFFER_BYTES,
            maxWritableBytes: MAX_STREAM_BUFFER_BYTES,
        });
        this.#streams.add(writer);
        this.#open += 1;
        let heartbeat: NodeJS.Timeout | undefined;
        void writer.done.then(() => {
            if (heartbeat !== undefined) clearInterval(heartbeat);
            unsubscribe();
            this.#streams.delete(writer);
            this.#open -= 1;
        });
        if (reset) {
            writer.write(frame("reset", { reason: "cursor_unavailable" }));
            writer.close();
            return;
        }
        for (const entry of backlog) {
            if (!writer.write(frame("change", entry, entry.version))) return;
        }
        let sent = cursor;
        if (!writer.write(frame("ready", { cursor: sent }))) return;
        deliver = (signal) => {
            if (writer.closed) return;
            if (signal.type === "closed") {
                writer.write(frame("closed", { reason: signal.reason }));
                writer.close();
                return;
            }
            const { entry } = signal;
            if (sent !== null && entry.version <= sent) return;
            if (!entry.key.startsWith(prefix)) return;
            sent = entry.version;
            writer.write(frame("change", entry, entry.version));
        };
        for (const signal of live.splice(0)) deliver(signal);
        heartbeat = setInterval(() => {
            writer.heartbeat(": ping\n\n");
        }, HEARTBEAT_MS);
        heartbeat.unref();
    }
}

function frame(event: string, data: unknown, id?: string): string {
    return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** `If-Match: "<version>"` asks for the key's current version; `If-None-Match: *` for none. */
function writeCondition(request: IncomingMessage): ArtifactDataCondition | undefined {
    const ifMatch = request.headers["if-match"];
    const ifNoneMatch = request.headers["if-none-match"];
    if (ifMatch !== undefined && ifNoneMatch !== undefined) {
        throw invalidRequest("Send `If-Match` or `If-None-Match`, not both.");
    }
    if (ifMatch !== undefined) {
        return { ifVersion: version(ifMatch.replace(/^"(.*)"$/, "$1"), "If-Match") };
    }
    if (ifNoneMatch !== undefined) {
        if (ifNoneMatch.trim() !== "*") throw invalidRequest("`If-None-Match` must be `*`.");
        return { ifAbsent: true };
    }
    return undefined;
}

function version(value: string, name: string): string {
    if (!Value.Check(artifactDataVersionSchema, value)) {
        throw invalidRequest(`\`${name}\` must be a version this store returned.`);
    }
    return value;
}

function pageSize(value: string): number {
    const limit = integerPattern.test(value) ? Number(value) : 0;
    if (limit < 1 || limit > ARTIFACT_DATA_LIMITS.pageSize) {
        throw invalidRequest(
            `\`limit\` must be from 1 to ${String(ARTIFACT_DATA_LIMITS.pageSize)}.`,
        );
    }
    return limit;
}

function single(query: URLSearchParams, name: string): string | undefined {
    const values = query.getAll(name);
    if (values.length > 1) throw invalidRequest(`Send \`${name}\` once.`);
    return values[0];
}

async function readJson(request: IncomingMessage, allowEmpty: boolean): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.byteLength;
        if (bytes > ARTIFACT_DATA_LIMITS.requestBytes) {
            throw new ApiError(413, "too_large", "The request body is larger than 1 MiB.");
        }
        chunks.push(buffer);
    }
    if (bytes === 0 && allowEmpty) return {};
    const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
        throw invalidRequest("The request content type must be application/json.");
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw invalidRequest("The request body must be valid JSON.");
    }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(encoded),
        "content-type": "application/json; charset=utf-8",
    });
    response.end(encoded);
}

function apiError(error: unknown): unknown {
    if (error instanceof ArtifactDataNotFoundError) return notFound(error.message);
    if (error instanceof ArtifactDataInputError) return invalidRequest(error.message);
    if (error instanceof ArtifactDataTooLargeError) {
        return new ApiError(error.code === "too_large" ? 413 : 507, error.code, error.message);
    }
    if (error instanceof ArtifactDataConflictError) {
        return new ApiError(409, "conflict", error.message, { entry: error.entry });
    }
    if (error instanceof ArtifactDataCursorUnavailableError) {
        return new ApiError(409, "cursor_unavailable", error.message);
    }
    return error;
}

/** A file served with its ETag, revalidated on every use, so it upgrades with the daemon. */
function sendCached(
    request: IncomingMessage,
    response: ServerResponse,
    bytes: Buffer,
    etag: string,
    contentType: string,
): void {
    const headers = { "cache-control": "no-cache", etag };
    if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();
        return;
    }
    response.writeHead(200, {
        ...headers,
        "content-length": bytes.byteLength,
        "content-type": contentType,
        "x-content-type-options": "nosniff",
    });
    response.end(bytes);
}
