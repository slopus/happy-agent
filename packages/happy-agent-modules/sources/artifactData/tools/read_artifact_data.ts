import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    ARTIFACT_DATA_LIMITS,
    ArtifactDataInputError,
    artifactDataKeySchema,
    artifactDataPrefixSchema,
    artifactDataVersionSchema,
    DEFAULT_ARTIFACT_DATA_PAGE_SIZE,
} from "../ArtifactData.js";
import type { ArtifactDataModule } from "../ArtifactDataModule.js";
import {
    ARTIFACT_DATA_TOOL_CAPABILITY,
    artifactDataAuthorViewSchema,
    artifactDataEntriesResultSchema,
    authorViews,
    formatArtifactDataEntry,
} from "./common.js";

/** How much of one value a listing shows, and how much reading one key shows. */
const LIST_VALUE_BYTES = 4 * 1024;
const KEY_VALUE_BYTES = 64 * 1024;

const readArtifactDataToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        key: Type.Optional(
            Type.String({ ...artifactDataKeySchema, description: "Read this one key" }),
        ),
        prefix: Type.Optional(
            Type.String({
                ...artifactDataPrefixSchema,
                description: 'List only keys that start with this, such as "todos/"',
            }),
        ),
        limit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: ARTIFACT_DATA_LIMITS.pageSize,
                description: `Keys per page, default ${String(DEFAULT_ARTIFACT_DATA_PAGE_SIZE)}`,
            }),
        ),
        pageCursor: Type.Optional(
            Type.String({
                ...artifactDataKeySchema,
                description: "The nextPageCursor of the previous page",
            }),
        ),
    },
    { additionalProperties: false },
);
type ReadArtifactDataToolInput = Static<typeof readArtifactDataToolInputSchema>;

const artifactDataReadSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        key: Type.Optional(Type.String()),
        entries: artifactDataEntriesResultSchema,
        nextPageCursor: Type.Union([Type.String(), Type.Null()]),
        cursor: Type.Union([artifactDataVersionSchema, Type.Null()]),
        authors: Type.Array(artifactDataAuthorViewSchema),
    },
    { additionalProperties: false },
);
type ArtifactDataRead = Static<typeof artifactDataReadSchema>;

/** Read the live data an HTML artifact's pages share: one key, or the keys under a prefix. */
export function readArtifactDataTool(data: ArtifactDataModule) {
    return defineAgentTool({
        name: "read_artifact_data",
        defer: true,
        capabilities: [ARTIFACT_DATA_TOOL_CAPABILITY],
        searchKeywords: [
            "artifact data",
            "artifact app data",
            "poll results",
            "read artifact store",
            "html app state",
        ],
        description: [
            "Read the live data of an HTML artifact app: the key-value store its pages share through /api/v1/client.js, shared by every version of the artifact and everyone who opens it. Use it to see what people entered, such as poll votes, to-dos, or scores.",
            `Name one key to read it alone, with up to ${String(KEY_VALUE_BYTES / 1024)} KiB of its value, or list keys in key order, all or under a prefix, ${String(DEFAULT_ARTIFACT_DATA_PAGE_SIZE)} at a time by default. Each entry shows its JSON value, its version, and who wrote it and when. Change data with write_artifact_data.`,
        ].join("\n\n"),
        parameters: readArtifactDataToolInputSchema,
        returnType: artifactDataReadSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (
            ctx: Context,
            input: ReadArtifactDataToolInput,
        ): Promise<ArtifactDataRead> => {
            if (
                input.key !== undefined &&
                (input.prefix !== undefined ||
                    input.limit !== undefined ||
                    input.pageCursor !== undefined)
            ) {
                throw new ArtifactDataInputError(
                    "Name one key, or list with prefix, limit, and pageCursor, not both.",
                );
            }
            let read: Omit<ArtifactDataRead, "authors">;
            if (input.key !== undefined) {
                const { entry, cursor } = await data.get(ctx, input.artifactId, input.key);
                read = {
                    artifactId: input.artifactId,
                    key: input.key,
                    entries: entry === undefined ? [] : [entry],
                    nextPageCursor: null,
                    cursor,
                };
            } else {
                const page = await data.list(ctx, input.artifactId, {
                    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
                    ...(input.pageCursor === undefined ? {} : { after: input.pageCursor }),
                    ...(input.limit === undefined ? {} : { limit: input.limit }),
                });
                read = {
                    artifactId: input.artifactId,
                    entries: [...page.entries],
                    nextPageCursor: page.nextAfter ?? null,
                    cursor: page.cursor,
                };
            }
            const ids = [...new Set(read.entries.map((entry) => entry.updatedBy))];
            const authors: ArtifactDataRead["authors"] = [];
            for (let index = 0; index < ids.length; index += 100) {
                authors.push(
                    ...authorViews(
                        await data.users(ctx, input.artifactId, ids.slice(index, index + 100)),
                    ),
                );
            }
            return { ...read, authors };
        },
        toLLM: (read) => [{ type: "text", text: formatArtifactDataRead(read) }],
    });
}

function formatArtifactDataRead(read: ArtifactDataRead): string {
    const authors = new Map(read.authors.map((author) => [author.id, author]));
    if (read.key !== undefined) {
        const entry = read.entries[0];
        if (entry === undefined) {
            return `Artifact ${read.artifactId} holds no value at ${JSON.stringify(read.key)}.`;
        }
        return [
            `Artifact ${read.artifactId}, key ${JSON.stringify(read.key)}:`,
            formatArtifactDataEntry(entry, authors, KEY_VALUE_BYTES),
        ].join("\n");
    }
    if (read.entries.length === 0) {
        return `Artifact ${read.artifactId} holds no data${read.nextPageCursor === null ? "" : " on this page"}.`;
    }
    const lines = [
        `Artifact ${read.artifactId} data, ${String(read.entries.length)} ${read.entries.length === 1 ? "key" : "keys"}:`,
        ...read.entries.map((entry) => formatArtifactDataEntry(entry, authors, LIST_VALUE_BYTES)),
    ];
    if (read.nextPageCursor !== null) {
        lines.push(
            `More keys follow; pass pageCursor ${JSON.stringify(read.nextPageCursor)} for the next page.`,
        );
    }
    return lines.join("\n");
}
