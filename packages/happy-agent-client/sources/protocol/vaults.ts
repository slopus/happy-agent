/**
 * Vault Surfaces: a shared tree of folders and files, plain or artifacts (vault apps), whose files
 * have numbered versions kept under the vault's retention policy, a Trash, an activity log, and search. Bytes
 * arrive as resumable uploads and are stored once per SHA-256.
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
import { artifactFileSchema, artifactSha256Schema } from "./artifacts.js";
import {
    surfaceIdSchema,
    surfaceRevisionActorSchema,
    surfaceRevisionSourceSchema,
} from "./surfaces.js";
import { vaultRetentionSchema } from "./vaultRetention.js";

const strict = { additionalProperties: false } as const;

/**
 * One path segment: no `/`, `\`, or control character, and not `.` or `..`. The daemon also
 * NFC-normalizes it, limits it to 255 bytes of UTF-8, and keeps it unique among a folder's live
 * children, folders and files together, case-insensitively.
 */
export const vaultNameSchema = Type.String({
    minLength: 1,
    maxLength: 255,
    pattern: "^(?!\\.\\.?$)[^/\\\\\\x00-\\x1f\\x7f]+$",
});

/** `/` followed by names from the root down; resolved case-insensitively. */
export const vaultPathSchema = Type.String({ minLength: 2, maxLength: 16_384, pattern: "^/" });
export type VaultPath = Static<typeof vaultPathSchema>;

/** Who made a change, from trusted execution context; never from a request body. */
export const vaultActorSchema = surfaceRevisionActorSchema;
export type VaultActor = Static<typeof vaultActorSchema>;

export const vaultChangeSourceSchema = surfaceRevisionSourceSchema;
export type VaultChangeSource = Static<typeof vaultChangeSourceSchema>;

/** Every artifact's name ends in this, matched case-insensitively, and no other item's does. */
export const VAULT_ARTIFACT_SUFFIX = ".artifact";

/** Whether a name is an artifact's: whether it ends in `.artifact`, case-insensitively. */
export function isVaultArtifactName(name: string): boolean {
    return name.toLowerCase().endsWith(VAULT_ARTIFACT_SUFFIX);
}

/** A vault app's kind: `html` when `index.html` sits at its root, otherwise `markdown`. */
export const vaultArtifactTypeSchema = Type.Union([Type.Literal("html"), Type.Literal("markdown")]);
export type VaultArtifactType = Static<typeof vaultArtifactTypeSchema>;

export const vaultArtifactSummarySchema = Type.Object({
    entry: Type.Union([Type.Literal("index.html"), Type.Literal("index.md")]),
    fileCount: Type.Integer({ minimum: 1, maximum: 256 }),
    type: vaultArtifactTypeSchema,
});
export type VaultArtifactSummary = Static<typeof vaultArtifactSummarySchema>;

/** A version's whole bundle: every file in path order, as the artifact file object. */
export const vaultArtifactContentsSchema = Type.Object({
    ...vaultArtifactSummarySchema.properties,
    files: Type.Array(artifactFileSchema, { minItems: 1, maxItems: 256 }),
});
export type VaultArtifactContents = Static<typeof vaultArtifactContentsSchema>;

/** Where a `.artifact` file keeps its manifest: at the zip's root, beside the app's files. */
export const VAULT_ARTIFACT_MANIFEST_PATH = "artifact.json";

/**
 * `artifact.json` in a `.artifact` file. `entry` is the file `type` names, `index.html` or
 * `index.md`; fields not described here are ignored.
 */
export const vaultArtifactManifestSchema = Type.Object({
    entry: Type.Union([Type.Literal("index.html"), Type.Literal("index.md")]),
    format: Type.Literal("happy.artifact"),
    formatVersion: Type.Literal(1),
    type: vaultArtifactTypeSchema,
});
export type VaultArtifactManifest = Static<typeof vaultArtifactManifestSchema>;

/** The name a downloaded artifact is saved under: its own, which ends in `.artifact`. */
export function vaultArtifactDownloadName(file: { readonly name: string }): string {
    return isVaultArtifactName(file.name) ? file.name : `${file.name}${VAULT_ARTIFACT_SUFFIX}`;
}

const vaultItemFields = {
    createdAt: timestampSchema,
    createdBy: vaultActorSchema,
    /** When this item itself went to the Trash; items inside a deleted folder keep `null`. */
    deletedAt: Nullable(timestampSchema),
    /** Unique across the vault's folders and files. */
    id: cuid2Schema,
    name: vaultNameSchema,
    /** `null` at the vault's root, which is not a folder. */
    parentId: Nullable(cuid2Schema),
    surfaceId: surfaceIdSchema,
    /** The latest change of any kind: content, rename, move, Trash, or restore. */
    updatedAt: timestampSchema,
    updatedBy: vaultActorSchema,
    /** Covers every field and advances on every change; unrelated to numbered versions. */
    version: resourceVersionSchema,
};

/** A folder: it holds other items, may be empty, and has no versions. */
export const vaultFolderSchema = Type.Object({ ...vaultItemFields, kind: Type.Literal("folder") });
export type VaultFolder = Static<typeof vaultFolderSchema>;

/** A plain file or an artifact, with numbered versions. */
export const vaultFileSchema = Type.Union([
    Type.Object({
        ...vaultItemFields,
        artifact: Type.Null(),
        kind: Type.Literal("file"),
        latestVersion: Type.Integer({ minimum: 1 }),
        /** From the name's extension; `application/octet-stream` when unknown. */
        mediaType: Type.String({ minLength: 1 }),
        sha256: artifactSha256Schema,
        size: Type.Integer({ minimum: 0 }),
    }),
    Type.Object({
        ...vaultItemFields,
        artifact: vaultArtifactSummarySchema,
        kind: Type.Literal("artifact"),
        latestVersion: Type.Integer({ minimum: 1 }),
        mediaType: Type.Null(),
        sha256: Type.Null(),
        size: Type.Integer({ minimum: 1 }),
    }),
]);
export type VaultFile = Static<typeof vaultFileSchema>;

/** A folder or a file, told apart by `kind`; what listings, the tree, and search return. */
export const vaultItemSchema = Type.Union([vaultFolderSchema, ...vaultFileSchema.anyOf]);
export type VaultItem = Static<typeof vaultItemSchema>;
export type VaultItemKind = VaultItem["kind"];

export const vaultFolderResponseSchema = Type.Object({ folder: vaultFolderSchema });
export type VaultFolderResponse = Static<typeof vaultFolderResponseSchema>;

export const vaultFileResponseSchema = Type.Object({ file: vaultFileSchema });
export type VaultFileResponse = Static<typeof vaultFileResponseSchema>;

export const vaultAncestorSchema = Type.Object({ id: cuid2Schema, name: vaultNameSchema });
export type VaultAncestor = Static<typeof vaultAncestorSchema>;

const vaultLocationFields = {
    /** From the root down to the item's folder. */
    ancestors: Type.Array(vaultAncestorSchema),
    /** Whether the item or a folder above it is deleted. */
    inTrash: Type.Boolean(),
    path: vaultPathSchema,
};

/** `GET /folders/:folderId` — the folder with where it is. */
export const vaultFolderLocationResponseSchema = Type.Object({
    ...vaultLocationFields,
    folder: vaultFolderSchema,
});
export type VaultFolderLocationResponse = Static<typeof vaultFolderLocationResponseSchema>;

/** `GET /files/:fileId` — the file with where it is. */
export const vaultFileLocationResponseSchema = Type.Object({
    ...vaultLocationFields,
    file: vaultFileSchema,
});
export type VaultFileLocationResponse = Static<typeof vaultFileLocationResponseSchema>;

/** `GET /resolve` — `innerPath` names a file inside the artifact the path ran into, or is `null`. */
export const vaultResolveResponseSchema = Type.Object({
    ...vaultLocationFields,
    innerPath: Nullable(Type.String({ minLength: 1 })),
    item: vaultItemSchema,
});
export type VaultResolveResponse = Static<typeof vaultResolveResponseSchema>;

/** A listing page of folders and files; `cursor` is the event cursor captured before the first read. */
export const vaultItemPageResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    items: Type.Array(vaultItemSchema),
    nextPageCursor: Nullable(Type.String()),
});
export type VaultItemPageResponse = Static<typeof vaultItemPageResponseSchema>;

export const vaultItemSortSchema = Type.Union([
    Type.Literal("name"),
    Type.Literal("updatedAt"),
    Type.Literal("size"),
]);
export type VaultItemSort = Static<typeof vaultItemSortSchema>;

export const vaultSortOrderSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
export type VaultSortOrder = Static<typeof vaultSortOrderSchema>;

/** `GET /items` query; folders always come first. */
export const vaultItemListQuerySchema = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    order: Type.Optional(vaultSortOrderSchema),
    pageCursor: Type.Optional(Type.String()),
    parentId: Type.Optional(cuid2Schema),
    sort: Type.Optional(vaultItemSortSchema),
});
export type VaultItemListQuery = Static<typeof vaultItemListQuerySchema>;

/** `GET /tree` query: every live folder and file, in ID order. */
export const vaultTreeQuerySchema = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    pageCursor: Type.Optional(Type.String()),
});
export type VaultTreeQuery = Static<typeof vaultTreeQuerySchema>;

/** A Trash item: a deleted folder or file whose folders are all live, and where it was. */
export const vaultTrashItemSchema = Type.Object({ item: vaultItemSchema, path: vaultPathSchema });
export type VaultTrashItem = Static<typeof vaultTrashItemSchema>;

export const vaultTrashPageResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    items: Type.Array(vaultTrashItemSchema),
    nextPageCursor: Nullable(Type.String()),
});
export type VaultTrashPageResponse = Static<typeof vaultTrashPageResponseSchema>;

export const vaultTrashQuerySchema = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    pageCursor: Type.Optional(Type.String()),
});
export type VaultTrashQuery = Static<typeof vaultTrashQuerySchema>;

const vaultVersionFields = {
    actor: vaultActorSchema,
    createdAt: timestampSchema,
    fileId: cuid2Schema,
    number: Type.Integer({ minimum: 1 }),
    /** Pinned versions are never pruned; the only field that changes after creation. */
    pinned: Type.Boolean(),
    /** The version whose content this one copied, or `null`. */
    restoredFrom: Nullable(Type.Integer({ minimum: 1 })),
    source: vaultChangeSourceSchema,
    surfaceId: surfaceIdSchema,
};

/** One immutable content version, as history pages list it. */
export const vaultVersionSchema = Type.Union([
    Type.Object({
        ...vaultVersionFields,
        artifact: Type.Null(),
        sha256: artifactSha256Schema,
        size: Type.Integer({ minimum: 0 }),
    }),
    Type.Object({
        ...vaultVersionFields,
        artifact: vaultArtifactSummarySchema,
        sha256: Type.Null(),
        size: Type.Integer({ minimum: 1 }),
    }),
]);
export type VaultVersion = Static<typeof vaultVersionSchema>;

/** A single-version read: an artifact version carries its whole file list. */
export const vaultVersionDetailSchema = Type.Union([
    vaultVersionSchema.anyOf[0],
    Type.Object({
        ...vaultVersionFields,
        artifact: vaultArtifactContentsSchema,
        sha256: Type.Null(),
        size: Type.Integer({ minimum: 1 }),
    }),
]);
export type VaultVersionDetail = Static<typeof vaultVersionDetailSchema>;

/** A version number, or `latest` for whichever version is newest when the daemon answers. */
export type VaultVersionSelector = number | "latest";

/** `GET /files/:fileId/versions` — surviving versions, newest first, without their files. */
export const vaultVersionPageResponseSchema = Type.Object({
    nextPageCursor: Nullable(Type.String()),
    versions: Type.Array(vaultVersionSchema),
});
export type VaultVersionPageResponse = Static<typeof vaultVersionPageResponseSchema>;

export const vaultVersionPageQuerySchema = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    pageCursor: Type.Optional(Type.String()),
});
export type VaultVersionPageQuery = Static<typeof vaultVersionPageQuerySchema>;

export const vaultVersionDetailResponseSchema = Type.Object({ version: vaultVersionDetailSchema });
export type VaultVersionDetailResponse = Static<typeof vaultVersionDetailResponseSchema>;

/** Pinning answers with the version, without its manifest. */
export const vaultVersionResponseSchema = Type.Object({ version: vaultVersionSchema });
export type VaultVersionResponse = Static<typeof vaultVersionResponseSchema>;

const vaultActivityFields = {
    actor: vaultActorSchema,
    at: timestampSchema,
    /** A UUIDv7. */
    id: Type.String(),
    /** The folder or file the record belongs to. */
    itemId: cuid2Schema,
    source: vaultChangeSourceSchema,
};

/** One append-only history record. New kinds may be added; show an unknown one as "changed". */
export const vaultActivitySchema = Type.Union([
    Type.Object({
        ...vaultActivityFields,
        copiedFrom: Nullable(cuid2Schema),
        kind: Type.Literal("created"),
        name: vaultNameSchema,
        parentId: Nullable(cuid2Schema),
    }),
    Type.Object({
        ...vaultActivityFields,
        fromName: vaultNameSchema,
        fromParentId: Nullable(cuid2Schema),
        kind: Type.Literal("moved"),
        toName: vaultNameSchema,
        toParentId: Nullable(cuid2Schema),
    }),
    Type.Object({ ...vaultActivityFields, kind: Type.Literal("deleted") }),
    Type.Object({
        ...vaultActivityFields,
        kind: Type.Literal("restored"),
        name: vaultNameSchema,
        parentId: Nullable(cuid2Schema),
    }),
    Type.Object({
        ...vaultActivityFields,
        kind: Type.Literal("version_created"),
        number: Type.Integer({ minimum: 1 }),
        restoredFrom: Nullable(Type.Integer({ minimum: 1 })),
    }),
    Type.Object({
        ...vaultActivityFields,
        kind: Type.Union([Type.Literal("pinned"), Type.Literal("unpinned")]),
        number: Type.Integer({ minimum: 1 }),
    }),
]);
export type VaultActivity = Static<typeof vaultActivitySchema>;

export const vaultActivityPageResponseSchema = Type.Object({
    activity: Type.Array(vaultActivitySchema),
    nextPageCursor: Nullable(Type.String()),
});
export type VaultActivityPageResponse = Static<typeof vaultActivityPageResponseSchema>;

export const vaultSearchKindSchema = Type.Union([
    Type.Literal("name"),
    Type.Literal("content"),
    Type.Literal("all"),
]);
export type VaultSearchKind = Static<typeof vaultSearchKindSchema>;

/**
 * `GET /search` query. Words match by prefix, ranked by BM25, before substring matches; content
 * substring matching needs at least three characters.
 */
export const vaultSearchQuerySchema = Type.Object({
    kind: Type.Optional(vaultSearchKindSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    parentId: Type.Optional(cuid2Schema),
    q: Type.String({ minLength: 1, maxLength: 256 }),
});
export type VaultSearchQuery = Static<typeof vaultSearchQuerySchema>;

export const vaultSearchResultSchema = Type.Union([
    Type.Object({
        innerPath: Type.Null(),
        item: vaultItemSchema,
        line: Type.Null(),
        match: Type.Literal("name"),
        path: vaultPathSchema,
        snippet: Type.Null(),
    }),
    Type.Object({
        /** The artifact file holding the text, or `null` for a plain file. */
        innerPath: Nullable(Type.String({ minLength: 1 })),
        /** A content match is always a file. */
        item: vaultFileSchema,
        line: Type.Integer({ minimum: 1 }),
        match: Type.Literal("content"),
        path: vaultPathSchema,
        snippet: Type.String({ maxLength: 200 }),
    }),
]);
export type VaultSearchResult = Static<typeof vaultSearchResultSchema>;

/**
 * Name matches, then content matches, then path matches, then substring matches; `truncated` says
 * more exist.
 */
export const vaultSearchResponseSchema = Type.Object({
    results: Type.Array(vaultSearchResultSchema),
    truncated: Type.Boolean(),
});
export type VaultSearchResponse = Static<typeof vaultSearchResponseSchema>;

export const vaultSettingsSchema = Type.Object({
    retention: vaultRetentionSchema,
    surfaceId: surfaceIdSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type VaultSettings = Static<typeof vaultSettingsSchema>;

export const vaultSettingsSnapshotResponseSchema = Type.Object({
    cursor: eventCursorSchema,
    settings: vaultSettingsSchema,
});
export type VaultSettingsSnapshotResponse = Static<typeof vaultSettingsSnapshotResponseSchema>;

export const vaultSettingsResponseSchema = Type.Object({ settings: vaultSettingsSchema });
export type VaultSettingsResponse = Static<typeof vaultSettingsResponseSchema>;

/** Replaces the whole policy; the latest edit wins and pruning waits for the next pass. */
export const updateVaultSettingsRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema), retention: vaultRetentionSchema },
    strict,
);
export type UpdateVaultSettingsRequest = Static<typeof updateVaultSettingsRequestSchema>;

/** The largest upload, and so the largest file: 64 GiB. */
export const VAULT_UPLOAD_MAX_SIZE = 68_719_476_736;
/** The most bytes one `PUT` may carry: 256 MiB. */
export const VAULT_UPLOAD_MAX_CHUNK = 268_435_456;

const vaultUploadSizeSchema = Type.Integer({ minimum: 0, maximum: VAULT_UPLOAD_MAX_SIZE });
const vaultUploadFields = {
    createdAt: timestampSchema,
    /** 24 hours after creation or the last bytes received, whichever is later. */
    expiresAt: timestampSchema,
    id: cuid2Schema,
    /** Bytes received so far, always from the start; resume from here. */
    received: vaultUploadSizeSchema,
    size: vaultUploadSizeSchema,
};

/** Resumable bytes waiting to be placed once; global like artifact uploads. */
export const vaultUploadSchema = Type.Union([
    Type.Object({
        ...vaultUploadFields,
        sha256: Type.Null(),
        status: Type.Literal("receiving"),
    }),
    Type.Object({
        ...vaultUploadFields,
        sha256: artifactSha256Schema,
        status: Type.Literal("complete"),
    }),
]);
export type VaultUpload = Static<typeof vaultUploadSchema>;

/** A supplied digest is checked when the last byte arrives. */
export const createVaultUploadRequestSchema = Type.Object(
    { sha256: Type.Optional(artifactSha256Schema), size: vaultUploadSizeSchema },
    strict,
);
export type CreateVaultUploadRequest = Static<typeof createVaultUploadRequestSchema>;

export const vaultUploadResponseSchema = Type.Object({ upload: vaultUploadSchema });
export type VaultUploadResponse = Static<typeof vaultUploadResponseSchema>;

const vaultCreationFields = {
    /** The creation retry key: repeating it returns the existing folder or file unchanged. */
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    name: vaultNameSchema,
    parentId: Nullable(cuid2Schema),
};

/** `POST /folders`: a new, empty folder. */
export const createVaultFolderRequestSchema = Type.Object(vaultCreationFields, strict);
export type CreateVaultFolderRequest = Static<typeof createVaultFolderRequestSchema>;

/**
 * `POST /files`: a file from an upload or a copy. A name ending in `.artifact` makes an artifact,
 * whose upload is a `.artifact` file; any other name makes a plain file.
 */
export const createVaultFileRequestSchema = Type.Union([
    Type.Object({ ...vaultCreationFields, uploadId: cuid2Schema }, strict),
    Type.Object(
        {
            ...vaultCreationFields,
            fromFileId: cuid2Schema,
            /** Defaults to the source's newest version. */
            fromVersion: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        strict,
    ),
]);
export type CreateVaultFileRequest = Static<typeof createVaultFileRequestSchema>;

/** Rename, move (`parentId: null` is the root), or both, a folder or a file; requires `If-Match`. */
export const updateVaultItemRequestSchema = Type.Union([
    Type.Object(
        {
            mutationId: Type.Optional(mutationIdSchema),
            name: vaultNameSchema,
            parentId: Type.Optional(Nullable(cuid2Schema)),
        },
        strict,
    ),
    Type.Object(
        {
            mutationId: Type.Optional(mutationIdSchema),
            name: Type.Optional(vaultNameSchema),
            parentId: Nullable(cuid2Schema),
        },
        strict,
    ),
]);
export type UpdateVaultItemRequest = Static<typeof updateVaultItemRequestSchema>;

/** Restores a Trash item where it was, or into another live folder and under another name. */
export const restoreVaultItemRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        name: Type.Optional(vaultNameSchema),
        parentId: Type.Optional(Nullable(cuid2Schema)),
    },
    strict,
);
export type RestoreVaultItemRequest = Static<typeof restoreVaultItemRequestSchema>;

/** Delete, pin, and unpin accept this optional echo-only body. */
export const vaultMutationRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    strict,
);
export type VaultMutationRequest = Static<typeof vaultMutationRequestSchema>;

/**
 * Makes a version request safe to repeat: one per attempt, sent again unchanged when a response is
 * lost. A repeat on the same file answers with the first request's outcome and makes nothing new.
 */
export const vaultOperationIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export type VaultOperationId = Static<typeof vaultOperationIdSchema>;

/** New content from an upload (a `.artifact` file for an artifact) or an earlier version. */
export const createVaultVersionRequestSchema = Type.Union([
    Type.Object(
        {
            mutationId: Type.Optional(mutationIdSchema),
            operationId: Type.Optional(vaultOperationIdSchema),
            uploadId: cuid2Schema,
        },
        strict,
    ),
    Type.Object(
        {
            fromVersion: Type.Integer({ minimum: 1 }),
            mutationId: Type.Optional(mutationIdSchema),
            operationId: Type.Optional(vaultOperationIdSchema),
        },
        strict,
    ),
]);
export type CreateVaultVersionRequest = Static<typeof createVaultVersionRequestSchema>;

/** `version` is `null` when the content equalled the newest version and nothing changed. */
export const createVaultVersionResponseSchema = Type.Object({
    file: vaultFileSchema,
    version: Nullable(vaultVersionSchema),
});
export type CreateVaultVersionResponse = Static<typeof createVaultVersionResponseSchema>;
