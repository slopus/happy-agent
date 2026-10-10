/**
 * Artifacts: finished work published to one global catalog, with every version kept. Each version
 * is a small tree of files under one URL prefix, so an entry's relative references resolve.
 */

import { type Static, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { userIdSchema } from "./userId.js";

/** What an artifact is. The set grows; a client offers an unknown type's entry for download. */
export const artifactTypeSchema = Type.Union([
    Type.Literal("markdown"),
    Type.Literal("html"),
    Type.Literal("image"),
    Type.Literal("image_series"),
    Type.Literal("video"),
    Type.Literal("document"),
]);
export type ArtifactType = Static<typeof artifactTypeSchema>;

/** A human display title: nonblank, bounded, and free of ASCII control characters. */
export const artifactTitleSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
export type ArtifactTitle = Static<typeof artifactTitleSchema>;

/**
 * A file's place in an artifact: `/`-joined segments of 1–255 characters, none empty, `.`, or `..`,
 * and none holding `\` or a control character. Case-sensitive.
 */
export const artifactPathSchema = Type.String({
    maxLength: 1024,
    minLength: 1,
    pattern:
        "^(?!\\.\\.?(?:/|$))(?!.*/\\.\\.?(?:/|$))[^/\\\\\\x00-\\x1f\\x7f]{1,255}(?:/[^/\\\\\\x00-\\x1f\\x7f]{1,255})*$",
});
export type ArtifactPath = Static<typeof artifactPathSchema>;

/** A lowercase hexadecimal SHA-256 digest. */
export const artifactSha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });

/** One file of one version. Equal digests mean equal content. */
export const artifactFileSchema = Type.Object({
    /** Decided by the daemon from the path's extension; `application/octet-stream` when unknown. */
    mimeType: Type.String(),
    path: artifactPathSchema,
    sha256: artifactSha256Schema,
    /** Bytes, at least 1. */
    size: Type.Integer({ minimum: 1 }),
});
export type ArtifactFile = Static<typeof artifactFileSchema>;

/** Created in a bot's conversation, or in work under it. */
export const artifactBotSourceSchema = Type.Object({
    agentId: Nullable(cuid2Schema),
    botId: cuid2Schema,
    kind: Type.Literal("bot"),
});

/** Created in a task's conversation, or in work under it. */
export const artifactTaskSourceSchema = Type.Object({
    agentId: Nullable(cuid2Schema),
    kind: Type.Literal("task"),
    taskId: cuid2Schema,
});

/** Created in a project's root folder. */
export const artifactProjectSourceSchema = Type.Object({
    agentId: Nullable(cuid2Schema),
    kind: Type.Literal("project"),
    projectId: cuid2Schema,
});

/** Created in a workspace below a project. */
export const artifactWorkspaceSourceSchema = Type.Object({
    agentId: Nullable(cuid2Schema),
    kind: Type.Literal("workspace"),
    projectId: cuid2Schema,
    workspaceId: cuid2Schema,
});

/** Created in a conversation that belongs to no bot, task, project, or workspace. */
export const artifactAgentSourceSchema = Type.Object({
    agentId: cuid2Schema,
    kind: Type.Literal("agent"),
});

/**
 * Where an artifact or one of its versions was made. New kinds may be added: a client treats an
 * unknown `kind` as "made elsewhere" and may still read `agentId`.
 */
export const artifactSourceSchema = Type.Union([
    artifactBotSourceSchema,
    artifactTaskSourceSchema,
    artifactProjectSourceSchema,
    artifactWorkspaceSourceSchema,
    artifactAgentSourceSchema,
]);
export type ArtifactSource = Static<typeof artifactSourceSchema>;
export type ArtifactSourceKind = ArtifactSource["kind"];

/** An agent; `botId` names the bot it works for, or is `null`. */
export const artifactAgentAuthorSchema = Type.Object({
    agentId: cuid2Schema,
    botId: Nullable(cuid2Schema),
    kind: Type.Literal("agent"),
});

/** A person; `null` for the one person of a standalone installation. */
export const artifactUserAuthorSchema = Type.Object({
    kind: Type.Literal("user"),
    userId: Nullable(userIdSchema),
});

/** Who made a change. New kinds may be added; a client shows an unknown one as someone else. */
export const artifactAuthorSchema = Type.Union([
    artifactAgentAuthorSchema,
    artifactUserAuthorSchema,
]);
export type ArtifactAuthor = Static<typeof artifactAuthorSchema>;
export type ArtifactAuthorKind = ArtifactAuthor["kind"];

/** The artifact as its latest version and lifecycle leave it. */
export const artifactSchema = Type.Object({
    createdAt: timestampSchema,
    createdBy: artifactAuthorSchema,
    deletedAt: Nullable(timestampSchema),
    deletedBy: Nullable(artifactAuthorSchema),
    deletedSource: Nullable(artifactSourceSchema),
    /** The latest version's entry: the file a client opens to show the artifact. */
    entry: artifactFileSchema,
    /** How many files the latest version holds. */
    fileCount: Type.Integer({ minimum: 1 }),
    id: cuid2Schema,
    /** The number of the latest version, from 1. */
    latestVersion: Type.Integer({ minimum: 1 }),
    /** The latest version's files' bytes together. */
    size: Type.Integer({ minimum: 1 }),
    /** Where the artifact was created. */
    source: Nullable(artifactSourceSchema),
    status: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
    title: artifactTitleSchema,
    type: artifactTypeSchema,
    updatedAt: timestampSchema,
    /** Who made the latest change: a version, or the deletion. */
    updatedBy: artifactAuthorSchema,
    updatedSource: Nullable(artifactSourceSchema),
    version: resourceVersionSchema,
});
export type Artifact = Static<typeof artifactSchema>;

/** One immutable version and its whole manifest. */
export const artifactVersionSchema = Type.Object({
    artifactId: cuid2Schema,
    createdAt: timestampSchema,
    createdBy: artifactAuthorSchema,
    /** One of `files`: the file a client opens to show this version. */
    entry: artifactFileSchema,
    /** Every file, in `path` order by Unicode code point. */
    files: Type.Array(artifactFileSchema),
    number: Type.Integer({ minimum: 1 }),
    source: Nullable(artifactSourceSchema),
    title: artifactTitleSchema,
});
export type ArtifactVersion = Static<typeof artifactVersionSchema>;

/**
 * Bytes waiting to be placed by one creation or update; they expire unused after 24 hours. An
 * upload has no name or media type: both come from the path it is placed at.
 */
export const artifactUploadSchema = Type.Object({
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    id: cuid2Schema,
    sha256: artifactSha256Schema,
    size: Type.Integer({ minimum: 1 }),
});
export type ArtifactUpload = Static<typeof artifactUploadSchema>;

/** `GET /v0/artifacts` query parameters. */
export const artifactListQuerySchema = Type.Object({
    /** Only artifacts whose `source.agentId` is this conversation. */
    agentId: Type.Optional(cuid2Schema),
    /** Requires `authorKind`; the creator's `agentId` or `userId`. */
    authorId: Type.Optional(Type.String()),
    /** Matches `createdBy.kind`. */
    authorKind: Type.Optional(Type.String()),
    includeDeleted: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    pageCursor: Type.Optional(Type.String()),
    /** Requires `sourceKind`; the source's `botId`, `taskId`, `projectId`, `workspaceId`, or `agentId`. */
    sourceId: Type.Optional(Type.String()),
    sourceKind: Type.Optional(Type.String()),
    type: Type.Optional(Type.String()),
});
export type ArtifactListQuery = Static<typeof artifactListQuerySchema>;

/** `GET /v0/artifacts` — newest created first. */
export const artifactListResponseSchema = Type.Object({
    artifacts: Type.Array(artifactSchema),
    /** The event cursor captured before the first read. */
    cursor: eventCursorSchema,
    nextPageCursor: Nullable(Type.String()),
});
export type ArtifactListResponse = Static<typeof artifactListResponseSchema>;

/** Every single-artifact route answers with the artifact. */
export const artifactResponseSchema = Type.Object({ artifact: artifactSchema });
export type ArtifactResponse = Static<typeof artifactResponseSchema>;

/** `GET /v0/artifacts/:artifactId/versions` query parameters. */
export const artifactVersionListQuerySchema = Type.Object({
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    pageCursor: Type.Optional(Type.String()),
});
export type ArtifactVersionListQuery = Static<typeof artifactVersionListQuerySchema>;

/** `GET /v0/artifacts/:artifactId/versions` — newest first. */
export const artifactVersionListResponseSchema = Type.Object({
    nextPageCursor: Nullable(Type.String()),
    versions: Type.Array(artifactVersionSchema),
});
export type ArtifactVersionListResponse = Static<typeof artifactVersionListResponseSchema>;

/** A version number, or `latest` for whichever version is latest when the request is answered. */
export type ArtifactVersionSelector = number | "latest";

/** `GET /v0/artifacts/:artifactId/versions/:number` */
export const artifactVersionResponseSchema = Type.Object({ version: artifactVersionSchema });
export type ArtifactVersionResponse = Static<typeof artifactVersionResponseSchema>;

/** `POST /v0/artifact-uploads` */
export const artifactUploadResponseSchema = Type.Object({ upload: artifactUploadSchema });
export type ArtifactUploadResponse = Static<typeof artifactUploadResponseSchema>;

/**
 * A source a person names when creating or changing an artifact. `agentId` may be omitted
 * except on an `agent` source.
 */
export const artifactSourceInputSchema = Type.Union([
    Type.Object({
        agentId: Type.Optional(Nullable(cuid2Schema)),
        botId: cuid2Schema,
        kind: Type.Literal("bot"),
    }),
    Type.Object({
        agentId: Type.Optional(Nullable(cuid2Schema)),
        kind: Type.Literal("task"),
        taskId: cuid2Schema,
    }),
    Type.Object({
        agentId: Type.Optional(Nullable(cuid2Schema)),
        kind: Type.Literal("project"),
        projectId: cuid2Schema,
    }),
    Type.Object({
        agentId: Type.Optional(Nullable(cuid2Schema)),
        kind: Type.Literal("workspace"),
        projectId: Type.Optional(cuid2Schema),
        workspaceId: cuid2Schema,
    }),
    Type.Object({ agentId: cuid2Schema, kind: Type.Literal("agent") }),
]);
export type ArtifactSourceInput = Static<typeof artifactSourceInputSchema>;

/** One file placed at a path in a new version: its whole text, or an upload's bytes. */
export const artifactFileInputSchema = Type.Union([
    Type.Object({ path: artifactPathSchema, text: Type.String({ minLength: 1 }) }),
    Type.Object({ path: artifactPathSchema, uploadId: cuid2Schema }),
]);
export type ArtifactFileInput = Static<typeof artifactFileInputSchema>;

/** `POST /v0/artifacts` */
export const createArtifactRequestSchema = Type.Object({
    /** Every file of the first version, in any order. */
    files: Type.Array(artifactFileInputSchema, { maxItems: 256, minItems: 1 }),
    /** The retry key: repeating it returns the existing artifact unchanged. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    source: Type.Optional(artifactSourceInputSchema),
    title: artifactTitleSchema,
    type: artifactTypeSchema,
});
export type CreateArtifactRequest = Static<typeof createArtifactRequestSchema>;

/**
 * `PATCH /v0/artifacts/:artifactId` — requires `If-Match` and at least one of `title`, `files`,
 * `remove`, and `replaceAll`. The new version starts from the latest one's files, or from none
 * with `replaceAll`; `files` adds or replaces paths and `remove` takes paths out.
 */
export const updateArtifactRequestSchema = Type.Object({
    files: Type.Optional(Type.Array(artifactFileInputSchema, { maxItems: 256 })),
    mutationId: Type.Optional(mutationIdSchema),
    remove: Type.Optional(Type.Array(artifactPathSchema, { maxItems: 256 })),
    replaceAll: Type.Optional(Type.Boolean()),
    /** Where this change is being made. */
    source: Type.Optional(artifactSourceInputSchema),
    title: Type.Optional(artifactTitleSchema),
});
export type UpdateArtifactRequest = Static<typeof updateArtifactRequestSchema>;

/** `POST /v0/artifacts/:artifactId/delete` — requires `If-Match`. */
export const deleteArtifactRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    /** Where the deletion is being made. */
    source: Type.Optional(artifactSourceInputSchema),
});
export type DeleteArtifactRequest = Static<typeof deleteArtifactRequestSchema>;
