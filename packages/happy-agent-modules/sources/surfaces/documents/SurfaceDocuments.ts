import type { AgentKV } from "@slopus/happy-agent-base";
import {
    surfaceDocumentChangeSchema,
    surfaceDocumentSchema,
    type Surface,
    type SurfaceDocument,
    type SurfaceDocumentChange,
    type SurfaceDocumentChangeListResponse,
    type SurfaceDocumentChangeSource,
    type SurfaceDocumentStateResponse,
} from "@slopus/happy-agent-client";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import * as Y from "yjs";
import { apiResourceVersion } from "../../utils/apiResourceVersion.js";
import type { SurfacesPersistence } from "../persistence/SurfacesPersistence.js";
import { SurfaceError } from "../SurfaceError.js";
import { agentDocumentChange } from "./agentDocumentChange.js";
import { documentCommentText } from "./documentCommentText.js";
import {
    markdownLengthBound,
    markdownToUpdate,
    readDocument,
    type DocumentReading,
} from "./readDocument.js";
import type { SurfaceDocumentLive } from "./SurfaceDocumentLive.js";

export type DocumentActor = SurfaceDocumentChange["actor"];

/** A document's current Markdown projection and what that Markdown leaves out. */
export type DocumentProjection = {
    document: SurfaceDocument & { seq: number };
    omitted: DocumentReading["omitted"];
};

const MAX_CHANGE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_LENGTH = 262_144;
/** A snapshot is taken after this many changes or bytes, so loading never replays a long tail. */
const SNAPSHOT_EVERY_CHANGES = 256;
const SNAPSHOT_EVERY_BYTES = 1024 * 1024;
/** Decoded current documents kept between changes; each is rebuilt from storage on a miss. */
const CACHED_DOCUMENTS = 16;

const headSchema = Type.Object({
    surfaceId: Type.String(),
    authorUserId: surfaceDocumentSchema.properties.authorUserId,
    lastEditorUserId: surfaceDocumentSchema.properties.lastEditorUserId,
    createdAt: Type.Integer({ minimum: 0 }),
    updatedAt: Type.Integer({ minimum: 0 }),
    seq: Type.Integer({ minimum: 0 }),
    /** The newest snapshot's `seq`, or 0 before the first. */
    snapshotSeq: Type.Integer({ minimum: 0 }),
    tailChanges: Type.Integer({ minimum: 0 }),
    tailBytes: Type.Integer({ minimum: 0 }),
    /** An upper bound on the encoded current state: the snapshot plus every later change. */
    stateBytes: Type.Integer({ minimum: 0 }),
});
type Head = Static<typeof headSchema>;

/**
 * Collaborative document content: an append-only log of Yjs changes, periodic snapshots, and the
 * head that names the latest `seq`. Every write happens in its caller's transaction; the change
 * reaches live streams and the decoded-document cache only after that transaction commits.
 */
export class SurfaceDocuments {
    readonly #cache = new Map<string, { seq: number; doc: Y.Doc }>();

    constructor(
        readonly store: SurfacesPersistence,
        readonly kv: AgentKV,
        readonly live: SurfaceDocumentLive,
    ) {}

    /** Start a new document, with optional Markdown as its first change. */
    async create(
        ctx: Context,
        surface: Surface,
        text: string | undefined,
        actor: DocumentActor,
        mutationId: string | null,
    ): Promise<void> {
        const now = Date.now();
        const head = emptyHead(surface.id, surface.creatorUserId ?? null, now);
        await this.kv.write(ctx, key(surface.id), head);
        const update = text === undefined ? undefined : markdownToUpdate(text);
        if (update === undefined) return;
        await this.#append(
            ctx,
            head,
            docOf(update),
            update,
            actor,
            source(actor),
            mutationId,
            true,
        );
    }

    /** The document's head, converting a document an earlier daemon stored as Markdown. */
    async head(ctx: Context, surface: Surface): Promise<Head> {
        const stored = await this.kv.read(ctx, key(surface.id));
        if (stored !== undefined) return checked(headSchema, stored);
        const legacy = await this.kv.read(ctx, `document.${surface.id}`);
        const old = legacy === undefined ? undefined : checked(surfaceDocumentSchema, legacy);
        const head = emptyHead(
            surface.id,
            old?.authorUserId ?? surface.creatorUserId ?? null,
            old?.createdAt ?? surface.updatedAt,
        );
        await this.kv.write(ctx, key(surface.id), head);
        const update = old === undefined ? undefined : markdownToUpdate(old.text);
        if (update === undefined) return head;
        const actor = { userId: null, agentId: null };
        return (
            await this.#append(ctx, head, docOf(update), update, actor, "conversion", null, false)
        ).head;
    }

    async projection(ctx: Context, surface: Surface, seq?: number): Promise<DocumentProjection> {
        const head = await this.head(ctx, surface);
        if (seq !== undefined && (seq < 1 || seq > head.seq))
            throw new SurfaceError("not_found", "That version of the document was not found.");
        const at = seq ?? head.seq;
        const reading = readDocument(
            at === head.seq
                ? await this.#currentState(ctx, head)
                : await this.#stateAt(ctx, head.surfaceId, at),
        );
        const entry =
            at === head.seq || at === 0 ? undefined : await this.#entry(ctx, head.surfaceId, at);
        const updatedAt = entry?.createdAt ?? head.updatedAt;
        return {
            document: {
                surfaceId: head.surfaceId,
                text: reading.text,
                authorUserId: head.authorUserId,
                lastEditorUserId: entry === undefined ? head.lastEditorUserId : entry.actor.userId,
                createdAt: head.createdAt,
                updatedAt,
                version: apiResourceVersion(updatedAt, at, head.surfaceId),
                seq: at,
            },
            omitted: reading.omitted,
        };
    }

    /** What search finds a document by: its Markdown text, and its comments' text. */
    async searchText(ctx: Context, surface: Surface): Promise<{ text: string; comments: string }> {
        const head = await this.head(ctx, surface);
        const doc = await this.#current(ctx, head);
        return {
            text: readDocument(Y.encodeStateAsUpdate(doc)).text,
            comments: documentCommentText(doc),
        };
    }

    async state(
        ctx: Context,
        surface: Surface,
        query: { stateVector?: string; seq?: number },
    ): Promise<SurfaceDocumentStateResponse> {
        if (query.stateVector !== undefined && query.seq !== undefined)
            throw new SurfaceError(
                "invalid_request",
                "Ask for a state vector's difference or a version, not both.",
            );
        const head = await this.head(ctx, surface);
        if (query.seq !== undefined) {
            if (query.seq < 1 || query.seq > head.seq)
                throw new SurfaceError(
                    "invalid_request",
                    "That version of the document does not exist.",
                );
            const state = await this.#stateAt(ctx, head.surfaceId, query.seq);
            return {
                seq: query.seq,
                update: base64(state),
                stateVector: base64(Y.encodeStateVectorFromUpdate(state)),
            };
        }
        let vector: Uint8Array | undefined;
        if (query.stateVector !== undefined && query.stateVector !== "") {
            vector = bytes(query.stateVector);
            try {
                Y.decodeStateVector(vector);
            } catch {
                throw new SurfaceError(
                    "invalid_request",
                    "The state vector is not a Yjs state vector.",
                );
            }
        }
        const doc = await this.#current(ctx, head);
        return {
            seq: head.seq,
            update: base64(Y.encodeStateAsUpdate(doc, vector)),
            stateVector: base64(Y.encodeStateVector(doc)),
        };
    }

    /**
     * Store one change and return its `seq`. A repeated mutation ID returns the change it first
     * named, and a change that adds nothing returns the current `seq`; neither appends.
     */
    async change(
        ctx: Context,
        surface: Surface,
        update: Uint8Array,
        actor: DocumentActor,
        mutationId: string | null,
    ): Promise<{ seq: number; appended: boolean }> {
        if (update.byteLength > MAX_CHANGE_BYTES)
            throw new SurfaceError("invalid_request", "A document change is at most 1 MiB.");
        try {
            Y.decodeUpdate(update);
        } catch {
            throw new SurfaceError("invalid_request", "The change is not a Yjs update.");
        }
        const head = await this.head(ctx, surface);
        if (mutationId !== null) {
            const seq = await this.store.documentSeqForMutation(ctx, head.surfaceId, mutationId);
            if (seq !== undefined) return { seq, appended: false };
        }
        const doc = this.#take(head) ?? (await this.#load(ctx, head.surfaceId, head.seq));
        let changed = false;
        const observe = (transaction: Y.Transaction) => {
            changed ||=
                transaction.deleteSet.clients.size > 0 ||
                !sameVector(transaction.beforeState, transaction.afterState);
        };
        doc.on("afterTransaction", observe);
        try {
            Y.applyUpdate(doc, update);
        } catch {
            doc.destroy();
            throw new SurfaceError("invalid_request", "The change is not a Yjs update.");
        } finally {
            doc.off("afterTransaction", observe);
        }
        if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
            doc.destroy();
            throw new SurfaceError(
                "invalid_request",
                "The change depends on changes this document does not have. Read its state and try again.",
            );
        }
        if (!changed) {
            // Nothing changed, but the caller's transaction may still hold its own earlier change.
            afterCommit(ctx, () => this.#put(head.surfaceId, head.seq, doc));
            return { seq: head.seq, appended: false };
        }
        return {
            seq: (
                await this.#append(ctx, head, doc, update, actor, source(actor), mutationId, true)
            ).head.seq,
            appended: true,
        };
    }

    /**
     * Apply an agent's full Markdown, written against version `seq`, as the difference from that
     * version. People's edits since then are kept.
     */
    async agentChange(
        ctx: Context,
        surface: Surface,
        seq: number,
        markdown: string,
        actor: DocumentActor,
    ): Promise<{ seq: number; appended: boolean }> {
        const head = await this.head(ctx, surface);
        if (seq < 0 || seq > head.seq)
            throw new SurfaceError(
                "invalid_request",
                `Version ${seq} of this document does not exist; its latest is ${head.seq}. Read it again.`,
            );
        const baseState = await this.#stateAt(ctx, head.surfaceId, seq);
        const base = readDocument(baseState);
        const current = seq === head.seq ? base : readDocument(await this.#currentState(ctx, head));
        if (base.outsideModel || current.outsideModel)
            throw new SurfaceError(
                "invalid_request",
                "This document contains content this version of Happy cannot represent, so rewriting it from Markdown would lose that content. Ask a person to make this edit in the document editor, or to update Happy.",
            );
        const work = docOf(baseState);
        const update = agentDocumentChange(work, base.root, markdown);
        work.destroy();
        if (update === undefined) return { seq: head.seq, appended: false };
        if (update.byteLength > MAX_CHANGE_BYTES)
            throw new SurfaceError(
                "invalid_request",
                "This edit is larger than one 1 MiB document change. Make it in smaller steps.",
            );
        return this.change(ctx, surface, update, actor, null);
    }

    async entries(
        ctx: Context,
        surface: Surface,
        afterSeq: number,
        limit: number,
    ): Promise<SurfaceDocumentChangeListResponse> {
        await this.head(ctx, surface);
        const rows = (await this.store.documentEntries(ctx, surface.id, afterSeq, limit + 1)).map(
            (row) => checked(surfaceDocumentChangeSchema, row),
        );
        const updates = rows.slice(0, limit);
        return { updates, nextAfterSeq: rows.length > limit ? updates.at(-1)!.seq : null };
    }

    async #append(
        ctx: Context,
        head: Head,
        doc: Y.Doc,
        update: Uint8Array,
        actor: DocumentActor,
        changeSource: SurfaceDocumentChangeSource,
        mutationId: string | null,
        checkMarkdown: boolean,
    ): Promise<{ head: Head }> {
        const size = update.byteLength;
        let stateBytes = head.stateBytes + size;
        let snapshot = false;
        if (stateBytes > MAX_STATE_BYTES) {
            stateBytes = Y.encodeStateAsUpdate(doc).byteLength;
            if (stateBytes > MAX_STATE_BYTES) {
                doc.destroy();
                throw new SurfaceError(
                    "invalid_request",
                    "A document's stored state is at most 16 MiB.",
                );
            }
            snapshot = true;
        }
        if (
            checkMarkdown &&
            markdownLengthBound(doc) > MAX_MARKDOWN_LENGTH &&
            readDocument(Y.encodeStateAsUpdate(doc)).text.length > MAX_MARKDOWN_LENGTH
        ) {
            doc.destroy();
            throw new SurfaceError(
                "invalid_request",
                "A document's Markdown is at most 262,144 characters.",
            );
        }
        const seq = head.seq + 1;
        const now = Date.now();
        const entry: SurfaceDocumentChange = {
            seq,
            actor,
            source: changeSource,
            mutationId,
            createdAt: now,
            size,
        };
        await this.store.appendDocumentChange(ctx, {
            surfaceId: head.surfaceId,
            seq,
            change: base64(update),
            entry,
            mutationId,
        });
        let next: Head = {
            ...head,
            seq,
            updatedAt: now,
            lastEditorUserId: actor.userId,
            tailChanges: head.tailChanges + 1,
            tailBytes: head.tailBytes + size,
            stateBytes,
        };
        if (
            snapshot ||
            next.tailChanges >= SNAPSHOT_EVERY_CHANGES ||
            next.tailBytes >= SNAPSHOT_EVERY_BYTES
        ) {
            const state = Y.encodeStateAsUpdate(doc);
            await this.store.writeDocumentSnapshot(ctx, head.surfaceId, seq, base64(state));
            next = {
                ...next,
                snapshotSeq: seq,
                tailChanges: 0,
                tailBytes: 0,
                stateBytes: state.byteLength,
            };
        }
        await this.kv.write(ctx, key(head.surfaceId), next);
        afterCommit(ctx, () => {
            this.#put(head.surfaceId, seq, doc);
            this.live.change({
                surfaceId: head.surfaceId,
                seq,
                update: base64(update),
                mutationId,
                actor,
                source: changeSource,
            });
        });
        return { head: next };
    }

    /** The current document, decoded once and reused while no change is in flight. */
    async #current(ctx: Context, head: Head): Promise<Y.Doc> {
        const cached = this.#cache.get(head.surfaceId);
        if (cached?.seq === head.seq) return cached.doc;
        const doc = await this.#load(ctx, head.surfaceId, head.seq);
        // Only committed state may be shared; a reader inside an open write sees its own copy.
        afterCommit(ctx, () => this.#put(head.surfaceId, head.seq, doc));
        return doc;
    }

    async #currentState(ctx: Context, head: Head): Promise<Uint8Array> {
        return Y.encodeStateAsUpdate(await this.#current(ctx, head));
    }

    /** The whole document as of `seq`, replayed from the nearest snapshot. */
    async #stateAt(ctx: Context, surfaceId: string, seq: number): Promise<Uint8Array> {
        const snapshot =
            seq === 0 ? undefined : await this.store.documentSnapshot(ctx, surfaceId, seq);
        const changes = await this.store.documentChanges(ctx, surfaceId, snapshot?.seq ?? 0, seq);
        const updates = [...(snapshot === undefined ? [] : [snapshot.state]), ...changes].map(
            bytes,
        );
        if (updates.length === 0) return Y.encodeStateAsUpdate(new Y.Doc());
        return updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
    }

    async #load(ctx: Context, surfaceId: string, seq: number): Promise<Y.Doc> {
        return docOf(await this.#stateAt(ctx, surfaceId, seq));
    }

    async #entry(ctx: Context, surfaceId: string, seq: number): Promise<SurfaceDocumentChange> {
        const [row] = await this.store.documentEntries(ctx, surfaceId, seq - 1, 1);
        return checked(surfaceDocumentChangeSchema, row);
    }

    /** Remove the cached current document so a change can be applied to it. */
    #take(head: Head): Y.Doc | undefined {
        const cached = this.#cache.get(head.surfaceId);
        if (cached === undefined) return undefined;
        this.#cache.delete(head.surfaceId);
        if (cached.seq === head.seq) return cached.doc;
        cached.doc.destroy();
        return undefined;
    }

    #put(surfaceId: string, seq: number, doc: Y.Doc): void {
        const cached = this.#cache.get(surfaceId);
        if (cached !== undefined) {
            if (cached.doc === doc) return;
            if (cached.seq > seq) {
                doc.destroy();
                return;
            }
            cached.doc.destroy();
            this.#cache.delete(surfaceId);
        }
        this.#cache.set(surfaceId, { seq, doc });
        for (const [oldest, entry] of this.#cache) {
            if (this.#cache.size <= CACHED_DOCUMENTS) break;
            entry.doc.destroy();
            this.#cache.delete(oldest);
        }
    }
}

function emptyHead(surfaceId: string, authorUserId: string | null, createdAt: number): Head {
    return {
        surfaceId,
        authorUserId,
        lastEditorUserId: null,
        createdAt,
        updatedAt: createdAt,
        seq: 0,
        snapshotSeq: 0,
        tailChanges: 0,
        tailBytes: 0,
        stateBytes: 0,
    };
}

function key(surfaceId: string): string {
    return `document-log.${surfaceId}`;
}

function source(actor: DocumentActor): SurfaceDocumentChangeSource {
    return actor.agentId === null ? "api" : "tool";
}

function docOf(state: Uint8Array): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
}

function sameVector(a: Map<number, number>, b: Map<number, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [client, clock] of a) if (b.get(client) !== clock) return false;
    return true;
}

function base64(value: Uint8Array): string {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
}

function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
    if (!Value.Check(schema, value))
        throw new SurfaceError("invalid_request", "The stored document is invalid.");
    return value as Static<S>;
}
