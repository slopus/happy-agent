import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_IMAGE_OPERATION_CANONICAL_BYTES,
    MAX_IMAGE_OPERATION_CANONICAL_DEPTH,
    imageAssetWriteInputSchema,
    imageGenerationCreateResultSchema,
    imageGenerationProofSchema,
    imageFingerprintSchema,
    type AssetStoreGenerationProof,
    type AssetStoreSchema,
    type ImageGenerationProof,
    type ImageGenerationToolInput,
} from "../../sources/index.js";

function acceptsPublicTypes(
    toolInput: ImageGenerationToolInput,
    _store: AssetStoreSchema | undefined,
): ImageGenerationToolInput {
    return toolInput;
}

function acceptsProof(proof: AssetStoreGenerationProof): AssetStoreGenerationProof {
    return proof;
}

describe("ImageGeneration root exports", () => {
    it("exports the host write schema, create result schema, and public types", () => {
        const toolInput = acceptsPublicTypes({ prompt: "A blue moon" }, undefined);
        const stage = {
            stageId: "stage-1",
            agentId: "agent-1",
            operationId: "operation-1",
            fingerprint: "0".repeat(64),
            mediaType: "image/png",
            byteLength: 3,
        };
        const writeInput = {
            agentId: "agent-1",
            operationId: "operation-1",
            fingerprint: "0".repeat(64),
            prompt: toolInput.prompt,
            stage,
        };
        const result = {
            agentId: "agent-1",
            operationId: "operation-1",
            fingerprint: "0".repeat(64),
            prompt: toolInput.prompt,
            status: "completed" as const,
            createdAt: 1,
            updatedAt: 1,
            asset: {
                id: "asset-1",
                agentId: "agent-1",
                operationId: "operation-1",
                mediaType: "image/png",
                byteLength: 3,
                locator: "asset://asset-1",
            },
        };
        const proof: ImageGenerationProof = {
            agentId: "agent-1",
            operationId: "operation-1",
            fingerprint: "0".repeat(64),
            prompt: toolInput.prompt,
            result,
        };
        expect(acceptsProof(proof)).toEqual(proof);

        expect(Value.Check(imageAssetWriteInputSchema, writeInput)).toBe(true);
        expect(Value.Check(imageGenerationCreateResultSchema, result)).toBe(true);
        expect(Value.Check(imageGenerationProofSchema, proof)).toBe(true);
        expect(Value.Check(imageFingerprintSchema, "a".repeat(64))).toBe(true);
        expect(Value.Check(imageFingerprintSchema, "A".repeat(64))).toBe(false);
        expect(MAX_IMAGE_OPERATION_CANONICAL_DEPTH).toBe(8);
        expect(MAX_IMAGE_OPERATION_CANONICAL_BYTES).toBe(64 * 1024);
    });
});
