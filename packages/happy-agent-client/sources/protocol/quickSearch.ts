/**
 * Quick search: one daemon route that finds vault items, Surfaces, todos, documents, calendar
 * events, artifacts, conversations, projects, and workspaces by name or text, each result a typed
 * variant with a stable `key` and its fused `rank`. Clients fuse it with their own local results
 * through `fuseQuickSearchResults()`.
 */

import { type Static, type TProperties, Type } from "@sinclair/typebox";

import { Nullable, timestampSchema } from "./common.js";

const strict = { additionalProperties: false } as const;
const searchIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const searchTextSchema = Type.String({ maxLength: 4096 });

/** Every result type, in the daemon's provider order, which also breaks fused ties. */
export const QUICK_SEARCH_TYPES = [
    "vault_file",
    "vault_folder",
    "document",
    "todo",
    "calendar_event",
    "artifact",
    "surface",
    "agent",
    "project",
    "workspace",
] as const;
export const quickSearchTypeSchema = Type.Union(
    QUICK_SEARCH_TYPES.map((type) => Type.Literal(type)),
);
export type QuickSearchType = Static<typeof quickSearchTypeSchema>;

/**
 * `GET /v0/quick-search` request. `types` travels comma-separated; a daemon ignores types it does
 * not know, so any non-empty name is accepted.
 */
export const quickSearchRequestSchema = Type.Object(
    {
        q: Type.String({ minLength: 1, maxLength: 256 }),
        types: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z_]+$" }), {
                minItems: 1,
                maxItems: 32,
            }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    strict,
);
export type QuickSearchRequest = Static<typeof quickSearchRequestSchema>;

/** Where the words matched: the name or title, the text, or only the folders above. */
export const quickSearchMatchSchema = Type.Union([
    Type.Literal("name"),
    Type.Literal("content"),
    Type.Literal("path"),
]);
export type QuickSearchMatch = Static<typeof quickSearchMatchSchema>;

const nameOrContent = Type.Union([Type.Literal("name"), Type.Literal("content")]);
const snippetSchema = Nullable(Type.String({ maxLength: 200 }));
const lineSchema = Nullable(Type.Integer({ minimum: 1 }));

function variant<const Name extends QuickSearchType, Fields extends TProperties>(
    type: Name,
    fields: Fields,
) {
    return Type.Object(
        {
            type: Type.Literal(type),
            /** `<type>:<id>`, stable for as long as the thing exists. */
            key: Type.String({ minLength: type.length + 2, maxLength: 256 }),
            /** 1-based position in the fused list. */
            rank: Type.Integer({ minimum: 1 }),
            ...fields,
        },
        // A newer daemon may add fields; an older client keeps the result and ignores them.
        { additionalProperties: true },
    );
}

export const quickSearchVaultFileSchema = variant("vault_file", {
    surfaceId: searchIdSchema,
    fileId: searchIdSchema,
    name: searchTextSchema,
    path: searchTextSchema,
    kind: Type.Union([Type.Literal("file"), Type.Literal("artifact")]),
    match: quickSearchMatchSchema,
    /** The file inside a vault app holding the text of a content match. */
    innerPath: Nullable(searchTextSchema),
    line: lineSchema,
    snippet: snippetSchema,
});
export const quickSearchVaultFolderSchema = variant("vault_folder", {
    surfaceId: searchIdSchema,
    folderId: searchIdSchema,
    name: searchTextSchema,
    path: searchTextSchema,
    match: Type.Union([Type.Literal("name"), Type.Literal("path")]),
});
export const quickSearchDocumentSchema = variant("document", {
    surfaceId: searchIdSchema,
    name: searchTextSchema,
    match: nameOrContent,
    line: lineSchema,
    snippet: snippetSchema,
});
export const quickSearchTodoSchema = variant("todo", {
    surfaceId: searchIdSchema,
    todoId: searchIdSchema,
    text: searchTextSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("completed")]),
});
export const quickSearchCalendarEventSchema = variant("calendar_event", {
    surfaceId: searchIdSchema,
    eventId: searchIdSchema,
    title: searchTextSchema,
    allDay: Type.Boolean(),
    /** The next occurrence's start, or the last one's when the series has ended. */
    start: timestampSchema,
});
export const quickSearchArtifactSchema = variant("artifact", {
    artifactId: searchIdSchema,
    title: searchTextSchema,
    /** The artifact's `type`; the set grows. */
    artifactType: Type.String({ minLength: 1, maxLength: 64 }),
    match: nameOrContent,
    snippet: snippetSchema,
});
export const quickSearchSurfaceSchema = variant("surface", {
    surfaceId: searchIdSchema,
    /** The catalog's Surface type; the set grows. */
    surfaceType: Type.String({ minLength: 1, maxLength: 64 }),
    name: searchTextSchema,
});
export const quickSearchAgentSchema = variant("agent", {
    agentId: searchIdSchema,
    title: searchTextSchema,
    kind: Type.Union([
        Type.Literal("chat"),
        Type.Literal("task"),
        Type.Literal("subtask"),
        Type.Literal("bot"),
    ]),
    archived: Type.Boolean(),
    /**
     * The workspace holding the conversation, as `GET /v0/agents` reports it; a project's root
     * workspace has the project's ID.
     */
    workspaceId: Nullable(searchIdSchema),
    /** The project owning that workspace; `null` for bots, tasks, and their subtasks. */
    projectId: Nullable(searchIdSchema),
});
export const quickSearchProjectSchema = variant("project", {
    projectId: searchIdSchema,
    name: searchTextSchema,
    archived: Type.Boolean(),
});
export const quickSearchWorkspaceSchema = variant("workspace", {
    workspaceId: searchIdSchema,
    projectId: searchIdSchema,
    name: searchTextSchema,
    archived: Type.Boolean(),
});

export const quickSearchResultSchema = Type.Union([
    quickSearchVaultFileSchema,
    quickSearchVaultFolderSchema,
    quickSearchDocumentSchema,
    quickSearchTodoSchema,
    quickSearchCalendarEventSchema,
    quickSearchArtifactSchema,
    quickSearchSurfaceSchema,
    quickSearchAgentSchema,
    quickSearchProjectSchema,
    quickSearchWorkspaceSchema,
]);
export type QuickSearchResult = Static<typeof quickSearchResultSchema>;

/**
 * `GET /v0/quick-search` response. `partial` says a provider missed the time budget or failed.
 * The client keeps only results it recognizes, so a newer daemon may add types.
 */
export const quickSearchResponseSchema = Type.Object({
    results: Type.Array(quickSearchResultSchema),
    truncated: Type.Boolean(),
    partial: Type.Boolean(),
});
export type QuickSearchResponse = Static<typeof quickSearchResponseSchema>;
