import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

export const artifactTypeSchema = Type.Union([
    Type.Literal("markdown"),
    Type.Literal("html"),
    Type.Literal("image"),
    Type.Literal("image_series"),
    Type.Literal("video"),
    Type.Literal("document"),
]);
export const artifactStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("deleted")]);
export const artifactTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});
export const artifactCounterSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** The minor part of a version's label, which a major version starts at 0. */
export const artifactMinorSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
/** A human display title: nonblank, without control characters. */
export const artifactTitleSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
/**
 * A file's place in an artifact: `/`-joined segments of 1–255 characters, none empty, `.`, or `..`,
 * and none holding `\` or a control character. A path can never leave the artifact.
 */
export const artifactPathSchema = Type.String({
    minLength: 1,
    maxLength: 1024,
    pattern:
        "^(?!\\.\\.?(?:/|$))(?!.*/\\.\\.?(?:/|$))[^/\\\\\\x00-\\x1f\\x7f]{1,255}(?:/[^/\\\\\\x00-\\x1f\\x7f]{1,255})*$",
});
/** A media type as stored: lowercase, without parameters. */
export const artifactMimeTypeSchema = Type.String({
    minLength: 3,
    maxLength: 255,
    pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
});
export const artifactSha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });
/**
 * The colour a client paints behind a version's content instead of a transparent slot: a
 * lowercase hexadecimal `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`, and never other CSS.
 */
export const artifactBackgroundSchema = Type.String({
    pattern: "^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$",
});
/**
 * How a version's author wants it shown in a chat: inline collapsed to its title, inline at its
 * full height, or as a card that opens it beside the chat.
 */
export const artifactDisplaySchema = Type.Union([
    Type.Literal("inline_compact"),
    Type.Literal("inline_expanded"),
    Type.Literal("side"),
]);
/** A background as someone names it: the same colours, in either case. */
export const artifactBackgroundInputSchema = Type.String({
    pattern: "^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
});

/** One file of one version, stored once by the digest of its bytes. */
export const artifactFileSchema = Type.Object(
    {
        path: artifactPathSchema,
        mimeType: artifactMimeTypeSchema,
        size: artifactCounterSchema,
        sha256: artifactSha256Schema,
    },
    { additionalProperties: false },
);

const botSourceSchema = Type.Object(
    { kind: Type.Literal("bot"), botId: cuid2Schema, agentId: Type.Optional(cuid2Schema) },
    { additionalProperties: false },
);
const taskSourceSchema = Type.Object(
    { kind: Type.Literal("task"), taskId: cuid2Schema, agentId: Type.Optional(cuid2Schema) },
    { additionalProperties: false },
);
const projectSourceSchema = Type.Object(
    { kind: Type.Literal("project"), projectId: cuid2Schema, agentId: Type.Optional(cuid2Schema) },
    { additionalProperties: false },
);
const agentSourceSchema = Type.Object(
    { kind: Type.Literal("agent"), agentId: cuid2Schema },
    { additionalProperties: false },
);

/**
 * Where an artifact or one of its versions was made. `agentId` is the conversation it came from,
 * absent when a person acted outside one. New kinds are added here as the product grows.
 */
export const artifactSourceSchema = Type.Union([
    botSourceSchema,
    taskSourceSchema,
    projectSourceSchema,
    Type.Object(
        {
            kind: Type.Literal("workspace"),
            workspaceId: cuid2Schema,
            projectId: cuid2Schema,
            agentId: Type.Optional(cuid2Schema),
        },
        { additionalProperties: false },
    ),
    agentSourceSchema,
]);

/**
 * A source someone names rather than one the module resolved: a workspace's project may be left
 * for the module to fill in from the workspace itself.
 */
export const artifactSourceInputSchema = Type.Union([
    botSourceSchema,
    taskSourceSchema,
    projectSourceSchema,
    Type.Object(
        {
            kind: Type.Literal("workspace"),
            workspaceId: cuid2Schema,
            projectId: Type.Optional(cuid2Schema),
            agentId: Type.Optional(cuid2Schema),
        },
        { additionalProperties: false },
    ),
    agentSourceSchema,
]);

/**
 * Who made a change. An agent names the bot it works for when it works for one; a person is a
 * team user, or no user ID at all for the one person of a standalone installation.
 */
export const artifactAuthorSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("agent"), agentId: cuid2Schema, botId: Type.Optional(cuid2Schema) },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("user"), userId: Type.Optional(cuid2Schema) },
        { additionalProperties: false },
    ),
]);

/** The most files one version holds. */
export const MAX_ARTIFACT_FILES = 256;

/**
 * The catalog row: the latest version's title, entry, and size, who made the artifact and where,
 * who changed it last, and its deletion. `revision` advances with every change and guards it.
 * The latest version's files themselves are read from the version.
 */
export const artifactRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        type: artifactTypeSchema,
        title: artifactTitleSchema,
        status: artifactStatusSchema,
        latestVersion: artifactCounterSchema,
        /** The latest version's `major.minor` label. */
        latestMajor: artifactCounterSchema,
        latestMinor: artifactMinorSchema,
        entry: artifactFileSchema,
        fileCount: Type.Integer({ minimum: 1, maximum: MAX_ARTIFACT_FILES }),
        size: artifactCounterSchema,
        /** The latest version's background; absent for a transparent slot. */
        background: Type.Optional(artifactBackgroundSchema),
        /** The latest version's display preference; absent leaves it to the client. */
        display: Type.Optional(artifactDisplaySchema),
        source: Type.Optional(artifactSourceSchema),
        createdBy: artifactAuthorSchema,
        createdAt: artifactTimestampSchema,
        updatedBy: artifactAuthorSchema,
        updatedSource: Type.Optional(artifactSourceSchema),
        updatedAt: artifactTimestampSchema,
        deletedBy: Type.Optional(artifactAuthorSchema),
        deletedSource: Type.Optional(artifactSourceSchema),
        deletedAt: Type.Optional(artifactTimestampSchema),
        revision: artifactCounterSchema,
    },
    { additionalProperties: false },
);

/**
 * One immutable version: the artifact as one change left it, by whom, where, and when. `files` is
 * the whole manifest in path order, and `entry` is the one of them a client opens.
 */
export const artifactVersionSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        number: artifactCounterSchema,
        /**
         * The version's `major.minor` label. Every change is the next minor of the same major,
         * unless it asks for the next major, which starts at minor 0.
         */
        major: artifactCounterSchema,
        minor: artifactMinorSchema,
        title: artifactTitleSchema,
        entry: artifactFileSchema,
        files: Type.Array(artifactFileSchema, { minItems: 1, maxItems: MAX_ARTIFACT_FILES }),
        /** The colour behind this version's content; absent for a transparent slot. */
        background: Type.Optional(artifactBackgroundSchema),
        /** How this version's author wants it shown; absent leaves it to the client. */
        display: Type.Optional(artifactDisplaySchema),
        createdBy: artifactAuthorSchema,
        source: Type.Optional(artifactSourceSchema),
        createdAt: artifactTimestampSchema,
    },
    { additionalProperties: false },
);

/**
 * Received bytes waiting for one creation or update to place them, until they expire. An upload
 * has no name or media type: both come from the path it is placed at. `utf8` says whether the
 * bytes are UTF-8 text, which a Markdown or HTML entry must be.
 */
export const artifactUploadSchema = Type.Object(
    {
        id: cuid2Schema,
        size: artifactCounterSchema,
        sha256: artifactSha256Schema,
        utf8: Type.Boolean(),
        createdAt: artifactTimestampSchema,
        expiresAt: artifactTimestampSchema,
    },
    { additionalProperties: false },
);

/** One staged upload placed at one path of a new version. */
export const artifactPlacementSchema = Type.Object(
    { path: artifactPathSchema, uploadId: cuid2Schema },
    { additionalProperties: false },
);

/** One file of a new version as a caller describes it: its whole text, or a staged upload. */
export const artifactFileInputSchema = Type.Union([
    Type.Object(
        { path: artifactPathSchema, text: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
    ),
    artifactPlacementSchema,
]);

export const createArtifactInputSchema = Type.Object(
    {
        /** The retry key: an artifact that already has this ID is returned unchanged. */
        id: Type.Optional(cuid2Schema),
        type: artifactTypeSchema,
        title: artifactTitleSchema,
        /** Every file of the first version; each upload is used up by the creation. */
        files: Type.Array(artifactPlacementSchema, { minItems: 1, maxItems: MAX_ARTIFACT_FILES }),
        /** The first version's background; absent for a transparent slot. */
        background: Type.Optional(artifactBackgroundInputSchema),
        /** The first version's display preference; absent leaves it to the client. */
        display: Type.Optional(artifactDisplaySchema),
        author: artifactAuthorSchema,
        source: Type.Optional(artifactSourceSchema),
    },
    { additionalProperties: false },
);

export const updateArtifactInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        /** Refuse the change unless the artifact is still at this revision. */
        expectedRevision: Type.Optional(artifactCounterSchema),
        /** A retry key: a version already made under it is not made again. */
        operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        title: Type.Optional(artifactTitleSchema),
        /** Files added at new paths or replacing the file already at a path. */
        files: Type.Optional(Type.Array(artifactPlacementSchema, { maxItems: MAX_ARTIFACT_FILES })),
        /** Paths taken out of the version. */
        remove: Type.Optional(Type.Array(artifactPathSchema, { maxItems: MAX_ARTIFACT_FILES })),
        /** Start from no files instead of the latest version's. */
        replaceAll: Type.Optional(Type.Boolean()),
        /** A colour sets the new version's background, `null` clears it, and absent keeps it. */
        background: Type.Optional(Type.Union([artifactBackgroundInputSchema, Type.Null()])),
        /** A preference sets the new version's display, `null` clears it, and absent keeps it. */
        display: Type.Optional(Type.Union([artifactDisplaySchema, Type.Null()])),
        /**
         * Make the new version this major one, `major.0`. It must be one more than the latest
         * major, and the latest version must be a minor one.
         */
        major: Type.Optional(Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER })),
        author: artifactAuthorSchema,
        source: Type.Optional(artifactSourceSchema),
    },
    { additionalProperties: false },
);

export const deleteArtifactInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        expectedRevision: Type.Optional(artifactCounterSchema),
        author: artifactAuthorSchema,
        source: Type.Optional(artifactSourceSchema),
    },
    { additionalProperties: false },
);

/** The largest page either list returns, and its size when the caller asks for none. */
export const MAX_ARTIFACT_PAGE_SIZE = 100;
export const DEFAULT_ARTIFACT_PAGE_SIZE = 50;

/**
 * A catalog filter, newest created first. Unknown types and kinds match nothing rather than
 * failing, so a filter written for a newer product reads as empty.
 */
export const artifactListQuerySchema = Type.Object(
    {
        type: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        sourceKind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        sourceId: Type.Optional(cuid2Schema),
        agentId: Type.Optional(cuid2Schema),
        authorKind: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        authorId: Type.Optional(cuid2Schema),
        includeDeleted: Type.Optional(Type.Boolean()),
        /** Continue after this artifact, exclusive. */
        after: Type.Optional(cuid2Schema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ARTIFACT_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

export const artifactVersionQuerySchema = Type.Object(
    {
        /** Continue with versions older than this number. */
        before: Type.Optional(artifactCounterSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ARTIFACT_PAGE_SIZE })),
    },
    { additionalProperties: false },
);

export type ArtifactType = Static<typeof artifactTypeSchema>;
export type ArtifactStatus = Static<typeof artifactStatusSchema>;
export type ArtifactDisplay = Static<typeof artifactDisplaySchema>;
export type ArtifactFile = Static<typeof artifactFileSchema>;
export type ArtifactSource = Static<typeof artifactSourceSchema>;
export type ArtifactSourceInput = Static<typeof artifactSourceInputSchema>;
export type ArtifactAuthor = Static<typeof artifactAuthorSchema>;
export type ArtifactRecord = Static<typeof artifactRecordSchema>;
export type ArtifactVersion = Static<typeof artifactVersionSchema>;
export type ArtifactUpload = Static<typeof artifactUploadSchema>;
export type ArtifactPlacement = Static<typeof artifactPlacementSchema>;
export type ArtifactFileInput = Static<typeof artifactFileInputSchema>;
export type CreateArtifactInput = Static<typeof createArtifactInputSchema>;
export type UpdateArtifactInput = Static<typeof updateArtifactInputSchema>;
export type DeleteArtifactInput = Static<typeof deleteArtifactInputSchema>;
export type ArtifactListQuery = Static<typeof artifactListQuerySchema>;
export type ArtifactVersionQuery = Static<typeof artifactVersionQuerySchema>;

export interface ArtifactPage {
    readonly artifacts: readonly ArtifactRecord[];
    /** The `after` that reads the next page; absent on the last one. */
    readonly nextAfter?: string;
}

export interface ArtifactVersionPage {
    readonly versions: readonly ArtifactVersion[];
    /** The `before` that reads the next page; absent on the last one. */
    readonly nextBefore?: number;
}

export interface ArtifactCreation {
    readonly artifact: ArtifactRecord;
    readonly created: boolean;
}

/** A version number, or whichever version is latest when the request is answered. */
export type ArtifactVersionSelector = number | "latest";

/** One stored file of one version, and where its bytes are on this machine. */
export interface ArtifactStoredFile {
    readonly file: ArtifactFile;
    /** The version the file was read from, `latest` resolved. */
    readonly version: number;
    /** Where the bytes are on the daemon's machine. */
    readonly contentPath: string;
}

export const ARTIFACT_UPLOAD_EXPIRY_FUNCTION = "artifacts.expire-upload";
export const artifactUploadExpirySchema = Type.Object(
    { uploadId: cuid2Schema, expiresAt: artifactTimestampSchema },
    { additionalProperties: false },
);

export class ArtifactInputError extends Error {
    constructor(message = "The artifact request is invalid.") {
        super(message);
        this.name = "ArtifactInputError";
    }
}

export class ArtifactNotFoundError extends Error {
    constructor(message = "The artifact was not found.") {
        super(message);
        this.name = "ArtifactNotFoundError";
    }
}

/** The artifact moved or was deleted before the change; it carries the artifact as it is now. */
export class ArtifactConflictError extends Error {
    readonly artifact: ArtifactRecord | undefined;

    constructor(message: string, artifact?: ArtifactRecord) {
        super(message);
        this.name = "ArtifactConflictError";
        this.artifact = artifact === undefined ? undefined : structuredClone(artifact);
    }
}

export class ArtifactTooLargeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ArtifactTooLargeError";
    }
}
