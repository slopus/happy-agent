import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

export interface FileSearchResult {
    fileName: string;
    path: string;
}

export interface SearchFilesResponse {
    files: readonly FileSearchResult[];
}

export interface ListProjectFilePathsResponse {
    /** Every file in the checkout, relative to it, with POSIX separators, sorted. */
    paths: readonly string[];
    /** True when the checkout holds more files than `paths` carries, so a client can say so. */
    truncated: boolean;
}

export interface ReadProjectFileResponse {
    /** Base64-encoded file bytes. */
    content: string;
    /** SHA-256 of the returned bytes, used to guard a later write. */
    hash: string;
}

export interface ReadProjectFileRevisionResponse {
    /** Base64-encoded file bytes at that revision, or `null` when the revision has no such file. */
    content: string | null;
    /** SHA-256 of the returned bytes, or `null` when the revision has no such file. */
    hash: string | null;
}

export const listFileTreeRequestSchema = Type.Object(
    {
        cursor: Type.Optional(Type.String({ maxLength: 32 * 1024, minLength: 1 })),
        limit: Type.Optional(Type.Integer({ maximum: 500, minimum: 1 })),
        path: Type.String({
            maxLength: 4 * 1024,
            pattern: "^(?:|[^/\\\\\\u0000]+(?:/[^/\\\\\\u0000]+)*)$",
        }),
    },
    exact,
);

export type ListFileTreeRequest = Static<typeof listFileTreeRequestSchema>;

export const fileTreeEntrySchema = Type.Object(
    {
        modified: Type.Number({ minimum: 0 }),
        name: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1 }),
        size: Type.Integer({ minimum: 0 }),
        type: Type.Union([
            Type.Literal("directory"),
            Type.Literal("file"),
            Type.Literal("symlink"),
            Type.Literal("other"),
        ]),
    },
    exact,
);

export type FileTreeEntry = Static<typeof fileTreeEntrySchema>;

export const listFileTreeResponseSchema = Type.Object(
    {
        entries: Type.Array(fileTreeEntrySchema, { maxItems: 500 }),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
        path: Type.String(),
    },
    exact,
);

export type ListFileTreeResponse = Static<typeof listFileTreeResponseSchema>;

export const writeProjectFileRequestSchema = Type.Object(
    {
        /** Base64-encoded replacement bytes. */
        content: Type.String(),
        /** `null` creates a new file; a hash replaces exactly the version that was read. */
        expectedHash: Type.Union([Type.String(), Type.Null()]),
        path: Type.String({ minLength: 1 }),
    },
    exact,
);

export type WriteProjectFileRequest = Static<typeof writeProjectFileRequestSchema>;

export interface WriteProjectFileResponse {
    hash: string;
}
