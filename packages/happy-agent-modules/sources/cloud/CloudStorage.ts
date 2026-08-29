import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MAX_CLOUD_STORAGE_KEY_BYTES = 1_024;
/** Maximum binary value Happy Agent will hold for one Cloud storage operation. */
export const MAX_CLOUD_STORAGE_VALUE_BYTES = 100 * 1_024 * 1_024;

const exact = { additionalProperties: false } as const;

export const cloudStorageKeySchema = Type.String({
    minLength: 1,
    // UTF-8 adds bytes but never removes code units, so this is a cheap schema-level first bound.
    maxLength: MAX_CLOUD_STORAGE_KEY_BYTES,
});
export const cloudStorageSha256Schema = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const cloudStorageVersionSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const cloudStorageWriteResultSchema = Type.Object(
    {
        sha256: cloudStorageSha256Schema,
        version: cloudStorageVersionSchema,
    },
    exact,
);
export const cloudStorageValueSchema = Type.Object(
    {
        ...cloudStorageWriteResultSchema.properties,
        value: Type.Uint8Array({ maxByteLength: MAX_CLOUD_STORAGE_VALUE_BYTES }),
    },
    exact,
);
export const cloudStorageWriteConditionSchema = Type.Union([
    Type.Object({ kind: Type.Literal("any") }, exact),
    Type.Object({ kind: Type.Literal("empty") }, exact),
    Type.Object({ kind: Type.Literal("sha256"), sha256: cloudStorageSha256Schema }, exact),
]);

export const cloudStorageInvalidResponseSchema = Type.Object(
    { error: Type.Literal("invalid_storage_request") },
    exact,
);
export const cloudStorageNotFoundResponseSchema = Type.Object(
    { error: Type.Literal("not_found") },
    exact,
);
export const cloudStoragePreconditionFailedResponseSchema = Type.Union([
    Type.Object(
        {
            error: Type.Literal("precondition_failed"),
            sha256: Type.Null(),
            version: Type.Null(),
        },
        exact,
    ),
    Type.Object(
        {
            error: Type.Literal("precondition_failed"),
            ...cloudStorageWriteResultSchema.properties,
        },
        exact,
    ),
]);

export type CloudStorageValue = Readonly<Static<typeof cloudStorageValueSchema>>;
export type CloudStorageWriteCondition = Readonly<Static<typeof cloudStorageWriteConditionSchema>>;
export type CloudStorageWriteResult = Readonly<Static<typeof cloudStorageWriteResultSchema>>;

export function validCloudStorageKey(value: unknown): boolean {
    return (
        Value.Check(cloudStorageKeySchema, value) &&
        (value as string & { isWellFormed(): boolean }).isWellFormed() &&
        new TextEncoder().encode(value).byteLength <= MAX_CLOUD_STORAGE_KEY_BYTES
    );
}

export class CloudStorageInvalidRequestError extends Error {
    constructor() {
        super("Happy Cloud rejected the storage request.");
        this.name = "CloudStorageInvalidRequestError";
    }
}

export class CloudStoragePreconditionFailedError extends Error {
    readonly current: CloudStorageWriteResult | undefined;

    constructor(current: CloudStorageWriteResult | undefined) {
        super("The Happy Cloud storage value changed before it was written.");
        this.name = "CloudStoragePreconditionFailedError";
        this.current = current === undefined ? undefined : Object.freeze({ ...current });
    }
}
