import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    imageAssetQuerySchema,
    imageAssetSchema,
    imageContextSchema,
    imageAssetWriteInputSchema,
    imageGenerationCreateResultSchema,
    imageGenerationProofSchema,
    imageGenerationReceiptSchema,
    imageGenerationStageInputSchema,
    imageGenerationStageSchema,
    imageGenerationStatusQuerySchema,
    imageGenerationStatusResultSchema,
    imageGenerationStatusSchema,
    type ImageAssetQuery,
    type ImageAsset,
    type ImageGenerationCreateResult,
    type ImageGenerationReceipt,
    type ImageGenerationStage,
    type ImageGenerationStageInput,
    type ImageGenerationStatus,
    type ImageGenerationStatusQuery,
} from "./ImageGeneration.js";

const unknownPromiseSchema = Type.Promise(Type.Unknown());
const transactionWorkSchema = Type.Function([imageContextSchema], unknownPromiseSchema);
const afterCommitCallbackSchema = Type.Function([imageContextSchema], Type.Promise(Type.Void()));

/**
 * Host-owned generated-media catalog and external staging boundary.
 *
 * The feature never chooses a path, opens a file, or owns a storage client. `stage` may allocate
 * temporary external state; `commit` and `rollback` are the host's compensating boundary.
 */
export const assetStoreSchema = Type.Object(
    {
        transaction: Type.Function(
            [imageContextSchema, transactionWorkSchema],
            unknownPromiseSchema,
        ),
        /** Registration is synchronous and must belong to the host's outermost transaction. */
        afterCommit: Type.Function([imageContextSchema, afterCommitCallbackSchema], Type.Void()),
        /** Compensates a later outer rollback for data staged before the transaction. */
        onRollback: Type.Function([imageContextSchema, afterCommitCallbackSchema], Type.Void()),
        stage: Type.Function(
            [imageContextSchema, imageGenerationStageInputSchema],
            Type.Promise(imageGenerationStageSchema),
        ),
        commit: Type.Function(
            [imageContextSchema, imageGenerationStageSchema],
            Type.Promise(Type.Void()),
        ),
        rollback: Type.Function(
            [imageContextSchema, imageGenerationStageSchema],
            Type.Promise(Type.Void()),
        ),
        create: Type.Function(
            [imageContextSchema, imageAssetWriteInputSchema],
            Type.Promise(imageGenerationCreateResultSchema),
        ),
        status: Type.Function(
            [imageContextSchema, imageGenerationStatusQuerySchema],
            Type.Promise(imageGenerationStatusResultSchema),
        ),
        read: Type.Function(
            [imageContextSchema, imageAssetQuerySchema],
            Type.Promise(Type.Union([imageAssetSchema, Type.Undefined(), Type.Null()])),
        ),
        remove: Type.Function(
            [imageContextSchema, imageAssetQuerySchema],
            Type.Promise(Type.Boolean()),
        ),
        readReceipt: Type.Function(
            [imageContextSchema, imageGenerationStatusQuerySchema],
            Type.Promise(Type.Union([imageGenerationReceiptSchema, Type.Undefined()])),
        ),
        writeReceipt: Type.Function(
            [imageContextSchema, imageGenerationReceiptSchema],
            Type.Promise(Type.Void()),
        ),
        /**
         * Immutable proof/tombstone for one generation.  Hosts must retain it
         * even when mutable status and asset rows are removed, and must reject
         * replacement with different content.
         */
        readGenerationProof: Type.Function(
            [imageContextSchema, imageGenerationStatusQuerySchema],
            Type.Promise(Type.Union([imageGenerationProofSchema, Type.Undefined()])),
        ),
        writeGenerationProof: Type.Function(
            [imageContextSchema, imageGenerationProofSchema],
            Type.Promise(Type.Void()),
        ),
    },
    { additionalProperties: false },
);

export type AssetStore = Static<typeof assetStoreSchema>;
export type AssetStoreSchema = Static<typeof assetStoreSchema>;
export type AssetStoreStatus = ImageGenerationStatus;
export type AssetStoreStatusQuery = ImageGenerationStatusQuery;
export type AssetStoreAssetQuery = ImageAssetQuery;
export type AssetStoreCreateResult = ImageGenerationCreateResult;
export type AssetStoreReceipt = ImageGenerationReceipt;
export type AssetStoreGenerationProof = Static<typeof imageGenerationProofSchema>;
export type AssetStoreStageInput = ImageGenerationStageInput;
export type AssetStoreStage = ImageGenerationStage;

export function assertImageAsset(value: unknown): asserts value is ImageAsset {
    if (!Value.Check(imageAssetSchema, value)) {
        throw new Error("Asset store returned invalid image metadata.");
    }
}

export function assertImageGenerationStatus(
    value: unknown,
): asserts value is ImageGenerationStatus {
    if (!Value.Check(imageGenerationStatusSchema, value)) {
        throw new Error("Asset store returned invalid image generation status.");
    }
}

export function assertImageGenerationReceipt(
    value: unknown,
): asserts value is ImageGenerationReceipt {
    if (!Value.Check(imageGenerationReceiptSchema, value)) {
        throw new Error("Asset store returned invalid image generation receipt.");
    }
}

export function assertImageGenerationProof(
    value: unknown,
): asserts value is Static<typeof imageGenerationProofSchema> {
    if (!Value.Check(imageGenerationProofSchema, value)) {
        throw new Error("Asset store returned invalid image generation proof.");
    }
}

export function assertImageGenerationStage(value: unknown): asserts value is ImageGenerationStage {
    if (!Value.Check(imageGenerationStageSchema, value)) {
        throw new Error("Asset store returned invalid image generation stage.");
    }
}
