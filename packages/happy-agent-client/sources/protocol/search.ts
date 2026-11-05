/**
 * Search: one daemon route that finds everything in the node the caller can reach by name or
 * text — vault items, documents, conversation messages, todos, calendar events, artifacts,
 * Surfaces, conversations, projects, workspaces, people, and skills — each result a typed variant
 * with a stable `key` and its fused `rank`. Clients fuse it with their own local results through
 * `fuseSearchResults()`.
 */

import { type Static, type TProperties, Type } from "@sinclair/typebox";

import { Nullable, timestampSchema } from "./common.js";

const strict = { additionalProperties: false } as const;
const searchIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const searchTextSchema = Type.String({ maxLength: 4096 });

/** Every result type, in the daemon's provider order, which also breaks fused ties. */
export const SEARCH_TYPES = [
    "vault_file",
    "vault_folder",
    "document",
    "message",
    "todo",
    "calendar_event",
    "artifact",
    "surface",
    "agent",
    "project",
    "workspace",
    "user",
    "skill",
] as const;
export const searchTypeSchema = Type.Union(SEARCH_TYPES.map((type) => Type.Literal(type)));
export type SearchType = Static<typeof searchTypeSchema>;

/**
 * `POST /v0/search` JSON body. A daemon ignores types it does not know, so any non-empty name is
 * accepted.
 */
export const searchRequestSchema = Type.Object(
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
export type SearchRequest = Static<typeof searchRequestSchema>;

/** Where the words matched: the name or title, the text, or only the folders above. */
export const searchMatchSchema = Type.Union([
    Type.Literal("name"),
    Type.Literal("content"),
    Type.Literal("path"),
]);
export type SearchMatch = Static<typeof searchMatchSchema>;

const nameOrContent = Type.Union([Type.Literal("name"), Type.Literal("content")]);
const snippetSchema = Nullable(Type.String({ maxLength: 200 }));
const lineSchema = Nullable(Type.Integer({ minimum: 1 }));

function variant<const Name extends SearchType, Fields extends TProperties>(
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

export const searchVaultFileSchema = variant("vault_file", {
    surfaceId: searchIdSchema,
    fileId: searchIdSchema,
    name: searchTextSchema,
    path: searchTextSchema,
    kind: Type.Union([Type.Literal("file"), Type.Literal("artifact")]),
    match: searchMatchSchema,
    /** The file inside a vault app holding the text of a content match. */
    innerPath: Nullable(searchTextSchema),
    line: lineSchema,
    snippet: snippetSchema,
});
export const searchVaultFolderSchema = variant("vault_folder", {
    surfaceId: searchIdSchema,
    folderId: searchIdSchema,
    name: searchTextSchema,
    path: searchTextSchema,
    match: Type.Union([Type.Literal("name"), Type.Literal("path")]),
});
export const searchDocumentSchema = variant("document", {
    surfaceId: searchIdSchema,
    name: searchTextSchema,
    match: nameOrContent,
    line: lineSchema,
    snippet: snippetSchema,
});
export const searchMessageSchema = variant("message", {
    agentId: searchIdSchema,
    messageId: searchIdSchema,
    /** Who wrote it: the person, or an agent. */
    role: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
    /** At most 200 characters of the line where a query word first appears. */
    snippet: Type.String({ maxLength: 200 }),
    createdAt: timestampSchema,
    /** Where the conversation is, as on its `agent` result. */
    workspaceId: Nullable(searchIdSchema),
    projectId: Nullable(searchIdSchema),
});
export const searchTodoSchema = variant("todo", {
    surfaceId: searchIdSchema,
    todoId: searchIdSchema,
    text: searchTextSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("completed")]),
});
export const searchCalendarEventSchema = variant("calendar_event", {
    surfaceId: searchIdSchema,
    eventId: searchIdSchema,
    title: searchTextSchema,
    allDay: Type.Boolean(),
    /** The next occurrence's start, or the last one's when the series has ended. */
    start: timestampSchema,
    /** `"content"` when the words matched the notes or location rather than the title. */
    match: nameOrContent,
    snippet: snippetSchema,
});
export const searchArtifactSchema = variant("artifact", {
    artifactId: searchIdSchema,
    title: searchTextSchema,
    /** The artifact's `type`; the set grows. */
    artifactType: Type.String({ minLength: 1, maxLength: 64 }),
    match: nameOrContent,
    snippet: snippetSchema,
});
export const searchSurfaceSchema = variant("surface", {
    surfaceId: searchIdSchema,
    /** The catalog's Surface type; the set grows. */
    surfaceType: Type.String({ minLength: 1, maxLength: 64 }),
    name: searchTextSchema,
});
export const searchAgentSchema = variant("agent", {
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
export const searchProjectSchema = variant("project", {
    projectId: searchIdSchema,
    name: searchTextSchema,
    archived: Type.Boolean(),
});
export const searchWorkspaceSchema = variant("workspace", {
    workspaceId: searchIdSchema,
    projectId: searchIdSchema,
    name: searchTextSchema,
    archived: Type.Boolean(),
});

export const searchUserSchema = variant("user", {
    userId: searchIdSchema,
    name: searchTextSchema,
});
export const searchSkillSchema = variant("skill", {
    skillId: searchIdSchema,
    name: searchTextSchema,
    description: searchTextSchema,
});

export const searchResultSchema = Type.Union([
    searchVaultFileSchema,
    searchVaultFolderSchema,
    searchDocumentSchema,
    searchMessageSchema,
    searchTodoSchema,
    searchCalendarEventSchema,
    searchArtifactSchema,
    searchSurfaceSchema,
    searchAgentSchema,
    searchProjectSchema,
    searchWorkspaceSchema,
    searchUserSchema,
    searchSkillSchema,
]);
export type SearchResult = Static<typeof searchResultSchema>;

/**
 * `POST /v0/search` response. `partial` says a provider missed the time budget or failed.
 * The client keeps only results it recognizes, so a newer daemon may add types.
 */
export const searchResponseSchema = Type.Object({
    results: Type.Array(searchResultSchema),
    truncated: Type.Boolean(),
    partial: Type.Boolean(),
});
export type SearchResponse = Static<typeof searchResponseSchema>;
