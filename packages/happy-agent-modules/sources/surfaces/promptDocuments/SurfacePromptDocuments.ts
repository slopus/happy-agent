import {
    formatHappyReferenceUrl,
    type Surface,
    type SurfacePromptDocument,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { SurfaceError } from "../SurfaceError.js";
import {
    MAX_PROMPT_DOCUMENTS,
    markPromptDocumentInputSchema,
    type MarkPromptDocumentInput,
    type PromptDocument,
    type PromptDocumentChange,
} from "./PromptDocument.js";
import {
    deletePromptDocument,
    readPromptDocument,
    readPromptDocuments,
    writePromptDocument,
} from "./PromptDocumentsStore.js";

type ReadSurface = (ctx: Context, surfaceId: string) => Promise<Surface | undefined>;

/**
 * The installation's important documents: one list of document Surfaces every agent is told to
 * read before acting. Every operation runs in its caller's transaction; the module checks who
 * may change the list before calling here.
 */
export class SurfacePromptDocuments {
    constructor(readonly surface: ReadSurface) {}

    /** How a document Surface reports its place in the list: null when it is not marked. */
    async entry(ctx: Context, surfaceId: string): Promise<SurfacePromptDocument | null> {
        const record = await readPromptDocument(ctx, surfaceId);
        if (record === undefined) return null;
        return {
            description: record.description,
            ...(record.name === null ? {} : { name: record.name }),
        };
    }

    /**
     * Every marked document, oldest mark first. `readable` is false for a Surface that is
     * missing or no longer a document, which agents are not shown.
     */
    async list(ctx: Context): Promise<PromptDocument[]> {
        const documents: PromptDocument[] = [];
        for (const record of await readPromptDocuments(ctx)) {
            const surface = await this.surface(ctx, record.surfaceId);
            const readable = surface?.type === "document";
            documents.push({
                ...record,
                displayName: record.name ?? (readable ? surface.name : "Unavailable document"),
                link: formatHappyReferenceUrl({ kind: "surface", id: record.surfaceId }),
                readable,
            });
        }
        return documents;
    }

    /**
     * Mark a document, or replace the name and description of one already marked. Re-marking
     * keeps its first mark, so its place in the list does not move; the same name and
     * description again changes nothing.
     */
    async mark(
        ctx: Context,
        actingAgentId: string,
        input: MarkPromptDocumentInput,
    ): Promise<PromptDocumentChange> {
        if (!Value.Check(markPromptDocumentInputSchema, input))
            throw new SurfaceError("invalid_request", "The important document is invalid.");
        const surface = await this.surface(ctx, input.surfaceId);
        if (surface === undefined)
            throw new SurfaceError("not_found", "The Surface was not found.");
        if (surface.type !== "document")
            throw new SurfaceError(
                "invalid_request",
                "Only a document Surface can be an important document.",
            );
        const current = await readPromptDocuments(ctx);
        const existing = current.find((record) => record.surfaceId === input.surfaceId);
        const name = input.name ?? null;
        const changed = existing?.name !== name || existing.description !== input.description;
        if (changed) {
            if (existing === undefined && current.length >= MAX_PROMPT_DOCUMENTS)
                throw new SurfaceError(
                    "conflict",
                    `This installation already has ${String(MAX_PROMPT_DOCUMENTS)} important documents. Unmark one first.`,
                );
            const now = Date.now();
            await writePromptDocument(ctx, {
                surfaceId: input.surfaceId,
                name,
                description: input.description,
                markedAt: existing?.markedAt ?? now,
                markedByAgentId: existing?.markedByAgentId ?? actingAgentId,
                updatedAt: now,
            });
        }
        return { surfaceId: input.surfaceId, changed, documents: await this.list(ctx) };
    }

    /** Remove a document from the list; one that is not marked changes nothing. */
    async unmark(ctx: Context, surfaceId: string): Promise<PromptDocumentChange> {
        const changed = await deletePromptDocument(ctx, surfaceId);
        return { surfaceId, changed, documents: await this.list(ctx) };
    }
}
