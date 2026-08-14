import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_APPLET_LIST_SIZE,
    MAX_APPLET_VERSIONS,
    appletAssetReadInputSchema,
    appletAssetResultSchema,
    appletAssetSchema,
    appletChangeDescriptionSchema,
    appletCurrentResultSchema,
    appletDescriptionSchema,
    appletFingerprintSchema,
    appletImportInputSchema,
    appletListPageSchema,
    appletListQuerySchema,
    appletNameSchema,
    appletPurposeSchema,
    appletRefSchema,
    appletSchema,
    appletSourceImportInputSchema,
    appletSourceImportResultSchema,
    appletUpdateInputSchema,
    appletVersionNumberSchema,
    appletVersionSchema,
    type Applet,
    type AppletAsset,
    type AppletCurrentResult,
    type AppletListPage,
    type AppletSourceImportResult,
} from "./Applet.js";

/**
 * Context is deliberately opaque to this package, but an object boundary is
 * still useful in the runtime contract.  `Unsafe<Context>` preserves the
 * published Context type for structural implementations without accepting
 * arbitrary primitive values.
 */
const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const unknownPromiseSchema = Type.Promise(Type.Unknown());
const transactionWorkSchema = Type.Function([opaqueContextSchema], unknownPromiseSchema);
const postCommitCallbackSchema = Type.Function(
    [opaqueContextSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
const synchronousVoidSchema = Type.Void();

const mutationIdentityFields = {
    name: appletNameSchema,
    operationId: appletRefSchema,
    /** The version this operation requested; zero is used by remove. */
    targetVersion: Type.Integer({ minimum: 0, maximum: MAX_APPLET_VERSIONS }),
    /** The current version after this operation; zero means removed. */
    currentVersion: Type.Integer({ minimum: 0, maximum: MAX_APPLET_VERSIONS }),
    changed: Type.Boolean(),
};

export const appletCatalogOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("revert"),
    Type.Literal("remove"),
]);

const appletCatalogMutationAppletFields = {
    ...mutationIdentityFields,
    applet: appletSchema,
};

export const appletCatalogCreateResultSchema = Type.Object(
    {
        ...appletCatalogMutationAppletFields,
        operation: Type.Literal("create"),
    },
    { additionalProperties: false },
);

export const appletCatalogUpdateResultSchema = Type.Object(
    {
        ...appletCatalogMutationAppletFields,
        operation: Type.Literal("update"),
    },
    { additionalProperties: false },
);

export const appletCatalogRevertResultSchema = Type.Object(
    {
        ...appletCatalogMutationAppletFields,
        operation: Type.Literal("revert"),
    },
    { additionalProperties: false },
);

export const appletCatalogRemoveResultSchema = Type.Object(
    {
        ...mutationIdentityFields,
        operation: Type.Literal("remove"),
        removed: Type.Boolean(),
        applet: Type.Optional(appletSchema),
    },
    { additionalProperties: false },
);

/**
 * Mutation results carry the requested identity and target explicitly.  A
 * schema-valid applet alone cannot tell a feature whether a broken adapter
 * applied a different operation, so every host mutation returns this envelope.
 */
export const appletCatalogMutationResultSchema = Type.Union([
    appletCatalogCreateResultSchema,
    appletCatalogUpdateResultSchema,
    appletCatalogRevertResultSchema,
    appletCatalogRemoveResultSchema,
]);

/**
 * Host-owned durable replay receipt. The feature supplies the canonical request
 * fingerprint and the catalog persists the exact mutation envelope; the
 * feature never keeps a receipt ledger in process memory.
 */
export const appletCatalogMutationReceiptSchema = Type.Object(
    {
        operation: appletCatalogOperationSchema,
        name: appletNameSchema,
        operationId: appletRefSchema,
        fingerprint: appletFingerprintSchema,
        /**
         * The catalog state immediately before this operation.  The compact
         * transition marker is durable receipt data rather than a feature
         * inference: after a remove the catalog no longer has a row, and after
         * a no-op revert the current row alone cannot tell whether the
         * operation changed anything.
         */
        beforeExists: Type.Boolean(),
        beforeCurrentVersion: Type.Integer({
            minimum: 0,
            maximum: MAX_APPLET_VERSIONS,
        }),
        result: appletCatalogMutationResultSchema,
    },
    { additionalProperties: false },
);

/**
 * An append-only host proof for a catalog mutation.  This is intentionally a
 * separate persistence surface from the mutable replay receipt: a receipt may
 * be returned to a client, while this proof is the host's durable record of
 * the exact transition that was committed.
 */
export const appletCatalogMutationProofSchema = Type.Object(
    {
        operation: appletCatalogOperationSchema,
        name: appletNameSchema,
        operationId: appletRefSchema,
        fingerprint: appletFingerprintSchema,
        beforeExists: Type.Boolean(),
        beforeCurrentVersion: Type.Integer({
            minimum: 0,
            maximum: MAX_APPLET_VERSIONS,
        }),
        result: appletCatalogMutationResultSchema,
    },
    { additionalProperties: false },
);

/** The catalog input for the initial metadata row and source version. */
export const appletCatalogCreateInputSchema = Type.Object(
    {
        name: appletImportInputSchema.properties.name,
        description: appletDescriptionSchema,
        purpose: appletPurposeSchema,
        authorSessionId: appletImportInputSchema.properties.authorSessionId,
        allowedScopes: Type.Optional(appletImportInputSchema.properties.allowedScopes),
        sourceDescription: Type.Optional(appletImportInputSchema.properties.sourceDescription),
        iconPath: Type.Optional(appletImportInputSchema.properties.iconPath),
        initialVersion: Type.Object(
            {
                version: Type.Literal(1),
                changeDescription: Type.Literal("Initial import"),
                createdAt: appletVersionSchema.properties.createdAt,
                operationId: appletRefSchema,
            },
            { additionalProperties: false },
        ),
        operationId: appletRefSchema,
    },
    { additionalProperties: false },
);

/** The catalog input for one newly imported version and optional metadata changes. */
export const appletCatalogUpdateInputSchema = Type.Object(
    {
        version: appletVersionNumberSchema,
        changeDescription: appletChangeDescriptionSchema,
        createdAt: appletVersionSchema.properties.createdAt,
        allowedScopes: Type.Optional(appletUpdateInputSchema.properties.allowedScopes),
        description: Type.Optional(appletUpdateInputSchema.properties.description),
        purpose: Type.Optional(appletUpdateInputSchema.properties.purpose),
        sourceDescription: Type.Optional(appletUpdateInputSchema.properties.sourceDescription),
        iconPath: Type.Optional(appletUpdateInputSchema.properties.iconPath),
        operationId: appletRefSchema,
    },
    { additionalProperties: false },
);

export const appletCatalogRevertInputSchema = Type.Object(
    {
        version: appletVersionNumberSchema,
        operationId: appletRefSchema,
    },
    { additionalProperties: false },
);

const catalogListQuerySchema = Type.Object(
    {
        limit: Type.Integer({ minimum: 1, maximum: MAX_APPLET_LIST_SIZE }),
        cursor: Type.Optional(appletListQuerySchema.properties.cursor),
    },
    { additionalProperties: false },
);

/**
 * Host-owned applet catalog. Every callable return is explicitly asynchronous
 * except the two registration methods, which must return `undefined`
 * synchronously so callback registration cannot race a transaction boundary.
 */
export const appletCatalogSchema = Type.Object(
    {
        transaction: Type.Function(
            [opaqueContextSchema, transactionWorkSchema],
            unknownPromiseSchema,
        ),
        afterCommit: Type.Function(
            [opaqueContextSchema, postCommitCallbackSchema],
            synchronousVoidSchema,
        ),
        onRollback: Type.Function(
            [opaqueContextSchema, postCommitCallbackSchema],
            synchronousVoidSchema,
        ),
        list: Type.Function(
            [opaqueContextSchema, catalogListQuerySchema],
            Type.Promise(appletListPageSchema),
        ),
        get: Type.Function(
            [opaqueContextSchema, appletNameSchema],
            Type.Promise(Type.Union([appletSchema, Type.Undefined()])),
        ),
        create: Type.Function(
            [opaqueContextSchema, appletCatalogCreateInputSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        update: Type.Function(
            [opaqueContextSchema, appletNameSchema, appletCatalogUpdateInputSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        revert: Type.Function(
            [opaqueContextSchema, appletNameSchema, appletCatalogRevertInputSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        remove: Type.Function(
            [opaqueContextSchema, appletNameSchema, appletRefSchema],
            Type.Promise(appletCatalogMutationResultSchema),
        ),
        readReceipt: Type.Function(
            [opaqueContextSchema, appletRefSchema],
            Type.Promise(Type.Union([appletCatalogMutationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [opaqueContextSchema, appletCatalogMutationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        readMutationProof: Type.Function(
            [opaqueContextSchema, appletRefSchema],
            Type.Promise(Type.Union([appletCatalogMutationProofSchema, Type.Undefined()])),
        ),
        writeMutationProof: Type.Function(
            [opaqueContextSchema, appletCatalogMutationProofSchema],
            Type.Promise(Type.Void()),
        ),
        current: Type.Function(
            [opaqueContextSchema, appletNameSchema],
            Type.Promise(appletCurrentResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type AppletCatalog = Static<typeof appletCatalogSchema>;
export type AppletCatalogSchema = AppletCatalog;
export type AppletCatalogCreateInput = Static<typeof appletCatalogCreateInputSchema>;
export type AppletCatalogUpdateInput = Static<typeof appletCatalogUpdateInputSchema>;
export type AppletCatalogRevertInput = Static<typeof appletCatalogRevertInputSchema>;
export type AppletCatalogMutationResult = Static<typeof appletCatalogMutationResultSchema>;
export type AppletCatalogMutationReceipt = Static<typeof appletCatalogMutationReceiptSchema>;
export type AppletCatalogMutationProof = Static<typeof appletCatalogMutationProofSchema>;
export type AppletCatalogOperation = Static<typeof appletCatalogOperationSchema>;
export type AppletCatalogCreateResult = Static<typeof appletCatalogCreateResultSchema>;
export type AppletCatalogUpdateResult = Static<typeof appletCatalogUpdateResultSchema>;
export type AppletCatalogRevertResult = Static<typeof appletCatalogRevertResultSchema>;
export type AppletCatalogRemoveResult = Static<typeof appletCatalogRemoveResultSchema>;

/** Host-owned source staging/copying with explicit compensating cleanup. */
export const sourceImporterSchema = Type.Object(
    {
        stage: Type.Function(
            [opaqueContextSchema, appletSourceImportInputSchema],
            Type.Promise(appletSourceImportResultSchema),
        ),
        commit: Type.Function(
            [opaqueContextSchema, appletSourceImportResultSchema],
            Type.Promise(synchronousVoidSchema),
        ),
        rollback: Type.Function(
            [opaqueContextSchema, appletSourceImportResultSchema],
            Type.Promise(synchronousVoidSchema),
        ),
    },
    { additionalProperties: false },
);

export type SourceImporter = Static<typeof sourceImporterSchema>;
export type SourceImporterSchema = SourceImporter;

const assetReaderInputSchema = Type.Object(
    {
        ...appletAssetReadInputSchema.properties,
        maxBytes: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
);

/** Host-owned bounded asset reader. */
export const assetReaderSchema = Type.Object(
    {
        readAsset: Type.Function(
            [opaqueContextSchema, assetReaderInputSchema],
            Type.Promise(appletAssetResultSchema),
        ),
    },
    { additionalProperties: false },
);

export type AssetReader = Static<typeof assetReaderSchema>;
export type AssetReaderSchema = AssetReader;
export type AppletAssetReaderInput = Static<typeof assetReaderInputSchema>;

export function assertApplet(value: unknown): asserts value is Applet {
    if (!Value.Check(appletSchema, value)) {
        throw new Error("Applet catalog returned an invalid applet.");
    }
    const applet = value as Applet;
    const seenVersions = new Set<number>();
    const seenOperations = new Set<string>();
    let previousCreatedAt = applet.createdAt;
    if (applet.versions[0]?.version !== 1) {
        throw new Error("Applet versions must start at version 1.");
    }
    for (const [index, version] of applet.versions.entries()) {
        if (version.version !== index + 1 || seenVersions.has(version.version)) {
            throw new Error("Applet versions must be contiguous and unique.");
        }
        seenVersions.add(version.version);
        if (version.createdAt < applet.createdAt || version.createdAt > applet.updatedAt) {
            throw new Error("Applet version timestamps are outside the applet lifetime.");
        }
        if (version.createdAt < previousCreatedAt) {
            throw new Error("Applet version timestamps must be ordered.");
        }
        previousCreatedAt = version.createdAt;
        if (seenOperations.has(version.operationId)) {
            throw new Error("Applet version operation identities must be unique.");
        }
        seenOperations.add(version.operationId);
    }
    if (!seenVersions.has(applet.currentVersion)) {
        throw new Error("Applet currentVersion does not identify a stored version.");
    }
    if (applet.updatedAt < applet.createdAt) {
        throw new Error("Applet updatedAt precedes createdAt.");
    }
}

export function assertAppletPage(value: unknown): asserts value is AppletListPage {
    if (!Value.Check(appletListPageSchema, value)) {
        throw new Error("Applet catalog returned an invalid applet page.");
    }
    const page = value as AppletListPage;
    const names = new Set<string>();
    for (const applet of page.applets) {
        assertApplet(applet);
        if (names.has(applet.name)) {
            throw new Error("Applet page contains duplicate names.");
        }
        names.add(applet.name);
    }
    if (page.hasMore && page.applets.length === 0) {
        throw new Error("A non-terminal applet page must make item progress.");
    }
}

export function assertAppletAsset(value: unknown): asserts value is AppletAsset {
    if (!Value.Check(appletAssetSchema, value)) {
        throw new Error("Applet asset reader returned an invalid asset.");
    }
}

export function assertAppletCurrent(value: unknown): asserts value is AppletCurrentResult {
    if (!Value.Check(appletCurrentResultSchema, value)) {
        throw new Error("Applet catalog returned an invalid current version.");
    }
}

export function assertAppletMutation(value: unknown): asserts value is AppletCatalogMutationResult {
    if (!Value.Check(appletCatalogMutationResultSchema, value)) {
        throw new Error("Applet catalog returned an invalid mutation result.");
    }
    const mutation = value as AppletCatalogMutationResult;
    if (mutation.operation !== "remove") {
        assertApplet(mutation.applet);
        if (mutation.applet.name !== mutation.name) {
            throw new Error("Applet mutation returned the wrong applet name.");
        }
        if (
            !mutation.applet.versions.some((version) => version.version === mutation.targetVersion)
        ) {
            throw new Error("Applet mutation target version is not present.");
        }
    } else if (mutation.applet !== undefined) {
        assertApplet(mutation.applet);
    }
    if (
        mutation.operation !== "remove" &&
        mutation.currentVersion !== mutation.applet.currentVersion
    ) {
        throw new Error("Applet mutation current version does not match the applet.");
    }
}

export function assertAppletMutationReceipt(
    value: unknown,
): asserts value is AppletCatalogMutationReceipt {
    if (!Value.Check(appletCatalogMutationReceiptSchema, value)) {
        throw new Error("Applet catalog returned an invalid mutation receipt.");
    }
    const receipt = value as AppletCatalogMutationReceipt;
    assertAppletMutation(receipt.result);
    if (
        receipt.operation !== receipt.result.operation ||
        receipt.name !== receipt.result.name ||
        receipt.operationId !== receipt.result.operationId
    ) {
        throw new Error("Applet mutation receipt does not match its result.");
    }
    if (
        (!receipt.beforeExists && receipt.beforeCurrentVersion !== 0) ||
        (receipt.beforeExists && receipt.beforeCurrentVersion < 1)
    ) {
        throw new Error("Applet mutation receipt has an invalid before-state marker.");
    }
    if (receipt.operation !== "remove" && !receipt.beforeExists && receipt.operation !== "create") {
        throw new Error("Applet mutation receipt is missing its before-state marker.");
    }
    if (
        receipt.operation === "create" &&
        (receipt.beforeExists || receipt.beforeCurrentVersion !== 0)
    ) {
        throw new Error("Applet create receipt has an invalid before-state marker.");
    }
    if (
        receipt.operation === "remove" &&
        receipt.result.operation === "remove" &&
        receipt.result.changed !== receipt.beforeExists
    ) {
        throw new Error("Applet remove receipt does not match its before-state marker.");
    }
}

export function assertAppletMutationProof(
    value: unknown,
): asserts value is AppletCatalogMutationProof {
    if (!Value.Check(appletCatalogMutationProofSchema, value)) {
        throw new Error("Applet catalog returned an invalid mutation proof.");
    }
    const proof = value as AppletCatalogMutationProof;
    assertAppletMutation(proof.result);
    if (
        proof.operation !== proof.result.operation ||
        proof.name !== proof.result.name ||
        proof.operationId !== proof.result.operationId
    ) {
        throw new Error("Applet mutation proof does not match its result.");
    }
    if (
        (!proof.beforeExists && proof.beforeCurrentVersion !== 0) ||
        (proof.beforeExists && proof.beforeCurrentVersion < 1)
    ) {
        throw new Error("Applet mutation proof has an invalid before-state marker.");
    }
    if (proof.operation === "remove" && proof.result.changed !== proof.beforeExists) {
        throw new Error("Applet remove proof does not match its before-state marker.");
    }
}

export function assertSourceStage(value: unknown): asserts value is AppletSourceImportResult {
    if (!Value.Check(appletSourceImportResultSchema, value)) {
        throw new Error("Applet source importer returned an invalid stage.");
    }
}
