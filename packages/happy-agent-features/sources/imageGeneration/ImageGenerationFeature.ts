import { createHash } from "node:crypto";

import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    assetStoreSchema,
    assertImageAsset,
    assertImageGenerationProof,
    assertImageGenerationReceipt,
    assertImageGenerationStage,
    assertImageGenerationStatus,
    type AssetStore,
} from "./AssetStore.js";
import {
    imageAgentIdSchema,
    imageAssetQuerySchema,
    imageContextSchema,
    imageFingerprintSchema,
    imageGenerationInputSchema,
    imageGenerationProofSchema,
    imageGenerationReceiptSchema,
    imageOperationIdSchema,
    imageGenerationStageInputSchema as stageInputSchema,
    MAX_IMAGE_OPERATION_CANONICAL_BYTES,
    MAX_IMAGE_OPERATION_CANONICAL_DEPTH,
    MAX_IMAGE_METADATA_CHARACTERS,
    MAX_IMAGE_OPTIONS_CHARACTERS,
    MAX_IMAGE_OUTPUT_BYTES,
    MAX_IMAGE_OUTPUT_CHARACTERS,
    type ImageAsset,
    type ImageGenerationInput,
    type ImageGenerationOptions,
    type ImageGenerationProof,
    type ImageGenerationReceipt,
    type ImageGenerationStage,
    type ImageGenerationStatus,
} from "./ImageGeneration.js";
import {
    assertGeneratedImage,
    imageGeneratorRequestSchema,
    imageGeneratorSchema,
    type GeneratedImage,
    type ImageGenerator,
    type ImageGeneratorRequest,
} from "./ImageGenerator.js";
import {
    imageEventIdSchema,
    imageEventIdFactorySchema,
    imageGenerationEventSchema as eventSchema,
    imageGenerationListenerSchema,
    type ImageGenerationEvent,
    type ImageGenerationListener,
} from "./ImageGenerationEvent.js";
import { generateImageTool } from "./tools/generate_image.js";

const IMAGE_OPERATION_KV_KEY = "generation";
const MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS = MAX_IMAGE_OUTPUT_CHARACTERS;
const DEFAULT_MAX_OUTPUT_BYTES = MAX_IMAGE_OUTPUT_BYTES;
const DEFAULT_MAX_OUTPUT_CHARACTERS = MAX_IMAGE_OUTPUT_CHARACTERS;

const durableOperationStateSchema = Type.Object(
    {
        operationId: imageOperationIdSchema,
        fingerprint: imageFingerprintSchema,
    },
    { additionalProperties: false },
);

const operationIdFactorySchema = Type.Function(
    [imageContextSchema, imageAgentIdSchema],
    Type.Promise(imageOperationIdSchema),
);

const postCommitErrorSchema = Type.Function(
    [imageContextSchema, eventSchema, Type.Unknown()],
    Type.Promise(Type.Void()),
);

const imageGenerationFeatureOptionsSchema = Type.Object(
    {
        generator: imageGeneratorSchema,
        store: assetStoreSchema,
        idFactory: Type.Optional(operationIdFactorySchema),
        eventIdFactory: Type.Optional(imageEventIdFactorySchema),
        clock: Type.Optional(Type.Function([], Type.Integer({ minimum: 0 }))),
        listener: Type.Optional(imageGenerationListenerSchema),
        maxOutputBytes: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: MAX_IMAGE_OUTPUT_BYTES,
            }),
        ),
        maxOutputCharacters: Type.Optional(
            Type.Integer({
                minimum: 256,
                maximum: MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS,
            }),
        ),
        onPostCommitError: Type.Optional(postCommitErrorSchema),
    },
    { additionalProperties: false },
);

export { imageGenerationFeatureOptionsSchema };
export type ImageGenerationFeatureOptions = Static<typeof imageGenerationFeatureOptionsSchema>;

type Operation = {
    readonly agentId: string;
    readonly operationId: string;
    readonly fingerprint: string;
    readonly prompt: string;
    readonly options?: ImageGenerationOptions;
};

type StageState = {
    value: "pending" | "committing" | "committed" | "rolling_back" | "rolled_back";
};

/** One shared image capability backed entirely by host-owned generation and asset services. */
export class ImageGenerationFeature implements AgentFeature {
    readonly name = "image-generation";

    readonly #generator: ImageGenerator;
    readonly #store: AssetStore;
    readonly #idFactory: NonNullable<ImageGenerationFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<ImageGenerationFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<ImageGenerationFeatureOptions["clock"]>;
    readonly #listener: ImageGenerationListener | undefined;
    readonly #maxOutputBytes: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: ImageGenerationFeatureOptions["onPostCommitError"];

    constructor(options: ImageGenerationFeatureOptions) {
        assertImageGenerationFeatureOptions(options);
        this.#generator = options.generator;
        this.#store = options.store;
        this.#idFactory = options.idFactory ?? (async () => globalThis.crypto.randomUUID());
        this.#eventIdFactory =
            options.eventIdFactory ??
            (async () => {
                return globalThis.crypto.randomUUID();
            });
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        this.#onPostCommitError = options.onPostCommitError;
        assertOutputBounds(this.#maxOutputBytes, this.#maxOutputCharacters);
    }

    /** Generate one image and return the authoritative durable operation status. */
    async generate(
        ctx: Context,
        agentId: string,
        input: ImageGenerationInput,
    ): Promise<ImageGenerationStatus> {
        assertAgentId(agentId);
        const normalized = normalizeInput(input);
        const fingerprint = operationFingerprint(agentId, normalized);
        const operationId = await this.#operationId(
            ctx,
            agentId,
            normalized.operationId,
            fingerprint,
        );
        const operation: Operation = {
            agentId,
            operationId,
            fingerprint,
            prompt: normalized.prompt,
            ...(normalized.options === undefined ? {} : { options: normalized.options }),
        };

        const existing = await this.#transaction(ctx, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operationId);
            const proof = await this.#readGenerationProof(txCtx, agentId, operationId);
            if (receipt === undefined && proof !== undefined) {
                throw new Error(
                    "Image generation has an immutable proof without its replay receipt.",
                );
            }
            if (receipt !== undefined && proof === undefined) {
                throw new Error("Image generation receipt has no immutable generation proof.");
            }
            if (receipt !== undefined && proof !== undefined) {
                return await this.#replayReceipt(receipt, proof, operation);
            }
            const current = await this.#readStatus(txCtx, agentId, operationId);
            if (current === undefined) return undefined;
            throw new Error(
                "Image generation status exists without an immutable proof and replay receipt.",
            );
        });
        if (existing !== undefined) return structuredClone(existing);

        const expectedGeneratorRequest: ImageGeneratorRequest = deepFreeze({
            agentId: operation.agentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            prompt: operation.prompt,
            ...(operation.options === undefined
                ? {}
                : { options: structuredClone(operation.options) }),
        });
        if (!Value.Check(imageGeneratorRequestSchema, expectedGeneratorRequest)) {
            throw new Error("Image generation request is invalid.");
        }
        const generatorRequest = structuredClone(expectedGeneratorRequest);
        const generatedRaw = this.#generator.generate(ctx, generatorRequest);
        const generatedRawValue = await requirePromise(generatedRaw, "Image generator generate");
        assertGeneratedImage(generatedRawValue);
        const generated = deepFreeze(structuredClone(generatedRawValue));
        assertGeneratedBounds(generated, this.#maxOutputBytes);

        const stageInputValue = {
            agentId,
            operationId,
            fingerprint,
            prompt: operation.prompt,
            ...(operation.options === undefined ? {} : { options: operation.options }),
            bytes: generated.bytes,
            mediaType: generated.mediaType,
            ...(generated.width === undefined ? {} : { width: generated.width }),
            ...(generated.height === undefined ? {} : { height: generated.height }),
            ...(generated.metadata === undefined ? {} : { metadata: generated.metadata }),
        };
        if (!Value.Check(stageInputSchema, stageInputValue)) {
            throw new Error("Image generation stage input is invalid.");
        }
        const state: StageState = { value: "pending" };
        const expectedStageInput = deepFreeze(structuredClone(stageInputValue));
        const stageInput = structuredClone(expectedStageInput);
        let stage: ImageGenerationStage | undefined;
        try {
            const stageRaw = this.#store.stage(ctx, stageInput);
            const stageResult = await requirePromise(stageRaw, "Image asset store stage");
            assertImageGenerationStage(stageResult);
            // Detach the handle before any later store callback receives it.
            stage = deepFreeze(structuredClone(stageResult));
            if (!sameJson(stageInput, expectedStageInput)) {
                throw new Error("Image asset store mutated the staged image input.");
            }
            assertStageMatches(stage, expectedStageInput, generated);

            const expectedStage = stage;
            const outcome = await this.#transaction(ctx, async (txCtx) => {
                const racedReceipt = await this.#readReceipt(txCtx, agentId, operationId);
                const racedProof = await this.#readGenerationProof(txCtx, agentId, operationId);
                if (racedReceipt === undefined && racedProof !== undefined) {
                    throw new Error(
                        "Image generation has an immutable proof without its replay receipt.",
                    );
                }
                if (racedReceipt !== undefined && racedProof === undefined) {
                    throw new Error("Image generation receipt has no immutable generation proof.");
                }
                if (racedReceipt !== undefined && racedProof !== undefined) {
                    return {
                        status: await this.#replayReceipt(racedReceipt, racedProof, operation),
                        staged: false,
                    };
                }
                const racedStatus = await this.#readStatus(txCtx, agentId, operationId);
                if (racedStatus !== undefined) {
                    throw new Error(
                        "Image generation status exists without an immutable proof and replay receipt.",
                    );
                }

                const createInputExpected = deepFreeze(
                    structuredClone({
                        agentId,
                        operationId,
                        fingerprint,
                        prompt: operation.prompt,
                        ...(operation.options === undefined ? {} : { options: operation.options }),
                        stage: expectedStage,
                    }),
                );
                const createInput = structuredClone(createInputExpected);
                const createdRaw = this.#store.create(txCtx, createInput);
                const createdResult = await requirePromise(createdRaw, "Image asset store create");
                if (!sameJson(createInput, createInputExpected)) {
                    throw new Error("Image asset store mutated the image create input.");
                }
                assertImageGenerationStatus(createdResult);
                const created = deepFreeze(structuredClone(createdResult));
                assertStatusBounds(created);
                this.#assertCreated(created, operation, expectedStage);

                const authoritative = await this.#readStatus(txCtx, agentId, operationId);
                if (authoritative === undefined) {
                    throw new Error("Image asset store did not persist generation state.");
                }
                this.#assertStatusRequest(authoritative, operation);
                this.#assertCreated(authoritative, operation, expectedStage);
                if (!sameJson(authoritative, created)) {
                    throw new Error(
                        "Image asset store returned non-authoritative generation state.",
                    );
                }

                const receipt = this.#receiptFromStatus(authoritative, operation);
                await this.#writeGenerationProof(txCtx, this.#proofFromReceipt(receipt));
                await this.#writeReceipt(txCtx, receipt);
                const event = await this.#event(txCtx, operation, authoritative);
                await this.#observe(txCtx, event, expectedStage, state);
                return { status: authoritative, staged: true };
            });

            if (!outcome.staged) {
                await this.#rollbackStage(ctx, expectedStage, state);
            }
            return structuredClone(outcome.status);
        } catch (error: unknown) {
            if (stage !== undefined) {
                await this.#rollbackStage(ctx, stage, state);
            }
            throw error;
        }
    }

    /** Read one operation status; an unknown operation returns undefined. */
    async status(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<ImageGenerationStatus | undefined> {
        assertAgentId(agentId);
        assertOperationId(operationId);
        const value = await this.#readStatus(ctx, agentId, operationId);
        return value === undefined ? undefined : structuredClone(value);
    }

    /** Read bounded protocol-safe metadata for one generated asset. */
    async read(ctx: Context, agentId: string, assetId: string): Promise<ImageAsset | undefined> {
        assertAgentId(agentId);
        assertAssetId(assetId);
        const value = await this.#readAsset(ctx, agentId, assetId);
        return value === undefined ? undefined : structuredClone(value);
    }

    /** Remove one owned asset through the host store's transaction boundary. */
    async remove(ctx: Context, agentId: string, assetId: string): Promise<boolean> {
        assertAgentId(agentId);
        assertAssetId(assetId);
        return await this.#transaction(ctx, async (txCtx) => {
            const before = await this.#readAsset(txCtx, agentId, assetId);
            if (before !== undefined && before.agentId !== agentId) {
                throw new Error(`Agent "${agentId}" does not own image asset "${assetId}".`);
            }
            const removedRaw = this.#store.remove(txCtx, { agentId, assetId });
            const reportedRemoved = await requirePromise(removedRaw, "Image asset store remove");
            if (typeof reportedRemoved !== "boolean") {
                throw new Error("Image asset store remove returned an invalid result.");
            }
            const after = await this.#readAsset(txCtx, agentId, assetId);
            const removed = before !== undefined && after === undefined;
            if (before === undefined && after !== undefined) {
                throw new Error("Image asset store remove created the requested asset.");
            }
            if (reportedRemoved !== removed) {
                throw new Error("Image asset store remove result is not authoritative.");
            }
            if (!removed) {
                if (!sameJson(before, after)) {
                    throw new Error("Image asset store remove changed the asset during a no-op.");
                }
                return false;
            }
            const eventId = await this.#newEventId(txCtx, agentId, assetId);
            const event: ImageGenerationEvent = {
                type: "image_removed",
                eventId,
                at: this.#timestamp(),
                agentId,
                assetId,
            };
            assertEvent(event);
            const frozen = deepFreeze(structuredClone(event));
            await this.#observeRemoval(txCtx, frozen);
            return true;
        });
    }

    /** The common provider-neutral image generation tool available to every agent. */
    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        generateImageTool(this, scope.agent.id),
    ];

    /** Render bounded metadata the model can use without exposing host paths or image bytes. */
    formatForModel(
        status: ImageGenerationStatus,
        maxCharacters = this.#maxOutputCharacters,
    ): string {
        assertImageGenerationStatus(status);
        if (
            !Number.isInteger(maxCharacters) ||
            maxCharacters < 256 ||
            maxCharacters > MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS
        ) {
            throw new Error("Image generation output character bound is invalid.");
        }
        const identity =
            status.status === "completed"
                ? [
                      `Operation ID: ${status.operationId}`,
                      `Asset ID: ${status.asset.id}`,
                      `Media type: ${status.asset.mediaType}`,
                      `Locator: ${status.asset.locator}`,
                  ]
                : [`Image generation ${status.status}.`, `Operation ID: ${status.operationId}`];
        const required = identity.join("\n");
        if (required.length > maxCharacters) {
            throw new Error("Image generation identity cannot fit the output bound.");
        }
        const optional = [
            ...(status.status === "completed"
                ? ["Image generation completed."]
                : [`Status: ${status.status}`]),
            `Prompt: ${status.prompt}`,
            ...(status.options === undefined ? [] : [`Options: ${canonicalJson(status.options)}`]),
            ...(status.status === "completed"
                ? [`Size: ${String(status.asset.byteLength)} bytes`]
                : []),
            ...(status.status === "failed" ? [`Error: ${status.error}`] : []),
        ];
        let output = required;
        for (const line of optional) {
            const candidate = `${output}\n${line}`;
            if (candidate.length > maxCharacters) break;
            output = candidate;
        }
        return output;
    }

    async #operationId(
        ctx: Context,
        agentId: string,
        requested: string | undefined,
        fingerprint: string,
    ): Promise<string> {
        if (requested !== undefined) {
            assertOperationId(requested);
            return requested;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) return await this.#newOperationId(ctx, agentId);
        const value = await kv.update(ctx, IMAGE_OPERATION_KV_KEY, async (current) => {
            if (current !== undefined) {
                if (!Value.Check(durableOperationStateSchema, current)) {
                    throw new Error("Stored image generation operation identity is invalid.");
                }
                if (current.fingerprint !== fingerprint) {
                    throw new Error(
                        "The image generation call identity was reused with different input.",
                    );
                }
                return current;
            }
            return {
                operationId: await this.#newOperationId(ctx, agentId),
                fingerprint,
            };
        });
        if (!Value.Check(durableOperationStateSchema, value)) {
            throw new Error("Image generation operation identity is invalid.");
        }
        return value.operationId;
    }

    async #newOperationId(ctx: Context, agentId: string): Promise<string> {
        const value = this.#idFactory(ctx, agentId);
        const operationId = await requirePromise<string>(value, "Image operation ID factory");
        assertOperationId(operationId);
        return operationId;
    }

    async #newEventId(ctx: Context, agentId: string, operationId: string): Promise<string> {
        const value = this.#eventIdFactory(ctx, agentId, operationId);
        const eventId = await requirePromise<string>(value, "Image event ID factory");
        if (!Value.Check(imageEventIdSchema, eventId)) {
            throw new Error("Image event ID factory returned an invalid ID.");
        }
        return eventId;
    }

    #timestamp(): number {
        const at = this.#clock();
        if (!Value.Check(Type.Integer({ minimum: 0 }), at)) {
            throw new Error("Image generation clock returned an invalid timestamp.");
        }
        return at;
    }

    async #event(
        ctx: Context,
        operation: Operation,
        status: ImageGenerationStatus,
    ): Promise<ImageGenerationEvent> {
        const event = {
            type: "image_generation_changed" as const,
            eventId: await this.#newEventId(ctx, status.agentId, operation.operationId),
            at: this.#timestamp(),
            agentId: status.agentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            operation: structuredClone(status),
        };
        assertEvent(event);
        return deepFreeze(structuredClone(event));
    }

    async #observe(
        ctx: Context,
        event: ImageGenerationEvent,
        stage: ImageGenerationStage,
        state: StageState,
    ): Promise<void> {
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await requireVoid(
                transactional.call(this.#listener, ctx, event),
                "Image transactional listener",
            );
        }
        const afterCommitResult = this.#store.afterCommit(ctx, async (postCommitCtx) => {
            if (state.value === "pending") {
                state.value = "committing";
                try {
                    const expectedStage = deepFreeze(structuredClone(stage));
                    const commitInput = structuredClone(expectedStage);
                    await requireVoid(
                        this.#store.commit(postCommitCtx, commitInput),
                        "Image asset store commit",
                    );
                    if (!sameJson(commitInput, expectedStage)) {
                        throw new Error("Image asset store mutated the image commit input.");
                    }
                    state.value = "committed";
                } catch (error: unknown) {
                    await this.#rollbackStage(postCommitCtx, stage, state);
                    await this.#reportPostCommitError(postCommitCtx, event, error);
                    return;
                }
            }
            const listener = this.#listener?.onEvent;
            if (listener !== undefined) {
                try {
                    await requireVoid(
                        listener.call(this.#listener, postCommitCtx, event),
                        "Image post-commit listener",
                    );
                } catch (error: unknown) {
                    await this.#reportPostCommitError(postCommitCtx, event, error);
                }
            }
        });
        if (afterCommitResult !== undefined) {
            throw new Error("Image asset store afterCommit must register synchronously.");
        }
        const onRollbackResult = this.#store.onRollback(ctx, async (rollbackCtx) => {
            await this.#rollbackStage(rollbackCtx, stage, state);
        });
        if (onRollbackResult !== undefined) {
            throw new Error("Image asset store onRollback must register synchronously.");
        }
    }

    async #observeRemoval(ctx: Context, event: ImageGenerationEvent): Promise<void> {
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await requireVoid(
                transactional.call(this.#listener, ctx, event),
                "Image transactional listener",
            );
        }
        const result = this.#store.afterCommit(ctx, async (postCommitCtx) => {
            const listener = this.#listener?.onEvent;
            if (listener === undefined) return;
            try {
                await requireVoid(
                    listener.call(this.#listener, postCommitCtx, event),
                    "Image post-commit listener",
                );
            } catch (error: unknown) {
                await this.#reportPostCommitError(postCommitCtx, event, error);
            }
        });
        if (result !== undefined) {
            throw new Error("Image asset store afterCommit must register synchronously.");
        }
    }

    async #reportPostCommitError(
        ctx: Context,
        event: ImageGenerationEvent,
        error: unknown,
    ): Promise<void> {
        const report = this.#onPostCommitError;
        if (report === undefined) return;
        try {
            await requireVoid(
                report.call(this, ctx, event, safeError(error)),
                "Image post-commit error reporter",
            );
        } catch {
            // Reporting is advisory after durable state has settled.
        }
    }

    async #rollbackStage(
        ctx: Context,
        stage: ImageGenerationStage,
        state: StageState,
    ): Promise<void> {
        if (
            state.value === "committed" ||
            state.value === "rolling_back" ||
            state.value === "rolled_back"
        ) {
            return;
        }
        state.value = "rolling_back";
        try {
            await requireVoid(
                this.#store.rollback(ctx, structuredClone(stage)),
                "Image asset store rollback",
            );
        } finally {
            state.value = "rolled_back";
        }
    }

    async #readStatus(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<ImageGenerationStatus | undefined> {
        const value = await requirePromise(
            this.#store.status(ctx, { agentId, operationId }),
            "Image asset store status",
        );
        if (value === undefined || value === null) return undefined;
        assertImageGenerationStatus(value);
        assertStatusBounds(value);
        this.#assertStatusIdentity(value, agentId, operationId);
        return structuredClone(value);
    }

    async #readAsset(
        ctx: Context,
        agentId: string,
        assetId: string,
    ): Promise<ImageAsset | undefined> {
        const value = await requirePromise(
            this.#store.read(ctx, { agentId, assetId }),
            "Image asset store read",
        );
        if (value === undefined || value === null) return undefined;
        assertImageAsset(value);
        assertMetadataBound(value.metadata);
        if (value.id !== assetId || value.agentId !== agentId) {
            throw new Error("Image asset store returned an asset for a different owner or ID.");
        }
        return structuredClone(value);
    }

    async #readReceipt(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<ImageGenerationReceipt | undefined> {
        const value = await requirePromise(
            this.#store.readReceipt(ctx, { agentId, operationId }),
            "Image asset store readReceipt",
        );
        if (value === undefined) return undefined;
        assertImageGenerationReceipt(value);
        if (value.agentId !== agentId || value.operationId !== operationId) {
            throw new Error("Image generation receipt has a different owner or operation ID.");
        }
        return structuredClone(value);
    }

    async #readGenerationProof(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<ImageGenerationProof | undefined> {
        const value = await requirePromise(
            this.#store.readGenerationProof(ctx, { agentId, operationId }),
            "Image asset store readGenerationProof",
        );
        if (value === undefined) return undefined;
        assertImageGenerationProof(value);
        if (value.agentId !== agentId || value.operationId !== operationId) {
            throw new Error("Image generation proof has a different owner or operation ID.");
        }
        assertStatusBounds(value.result);
        this.#assertStatusIdentity(value.result, agentId, operationId);
        return structuredClone(value);
    }

    async #writeReceipt(ctx: Context, receipt: ImageGenerationReceipt): Promise<void> {
        const expected = deepFreeze(structuredClone(receipt));
        const value = this.#store.writeReceipt(ctx, structuredClone(expected));
        await requireVoid(value, "Image asset store writeReceipt");
        const persisted = await this.#readReceipt(ctx, expected.agentId, expected.operationId);
        if (persisted === undefined || !sameJson(persisted, expected)) {
            throw new Error("Image asset store did not durably persist the generation receipt.");
        }
    }

    async #writeGenerationProof(ctx: Context, proof: ImageGenerationProof): Promise<void> {
        assertImageGenerationProof(proof);
        const expected = deepFreeze(structuredClone(proof));
        this.#assertStatusIdentity(expected.result, expected.agentId, expected.operationId);
        assertStatusBounds(expected.result);

        const existing = await this.#readGenerationProof(
            ctx,
            expected.agentId,
            expected.operationId,
        );
        if (existing !== undefined) {
            if (!sameJson(existing, expected)) {
                throw new Error("Image generation immutable proof cannot be replaced.");
            }
            return;
        }

        const value = this.#store.writeGenerationProof(ctx, structuredClone(expected));
        await requireVoid(value, "Image asset store writeGenerationProof");
        const persisted = await this.#readGenerationProof(
            ctx,
            expected.agentId,
            expected.operationId,
        );
        if (persisted === undefined || !sameJson(persisted, expected)) {
            throw new Error(
                "Image asset store did not durably persist the immutable generation proof.",
            );
        }
    }

    async #replayReceipt(
        receipt: ImageGenerationReceipt,
        proof: ImageGenerationProof,
        operation: Operation,
    ): Promise<ImageGenerationStatus> {
        if (
            receipt.fingerprint !== operation.fingerprint ||
            receipt.prompt !== operation.prompt ||
            !sameOptional(receipt.options, operation.options)
        ) {
            throw new Error("Image generation operation identity was reused with different input.");
        }
        if (
            proof.agentId !== operation.agentId ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint ||
            proof.prompt !== operation.prompt ||
            !sameOptional(proof.options, operation.options)
        ) {
            throw new Error("Image generation immutable proof has a different request identity.");
        }
        this.#assertStatusIdentity(receipt.result, receipt.agentId, receipt.operationId);
        this.#assertStatusRequest(receipt.result, operation);
        this.#assertStatusIdentity(proof.result, proof.agentId, proof.operationId);
        this.#assertStatusRequest(proof.result, operation);
        if (!sameJson(receipt, proof)) {
            throw new Error(
                "Image generation receipt does not match the immutable generation proof.",
            );
        }
        return structuredClone(proof.result);
    }

    #receiptFromStatus(
        status: ImageGenerationStatus,
        operation: Operation,
    ): ImageGenerationReceipt {
        const receipt = {
            agentId: status.agentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            prompt: operation.prompt,
            ...(operation.options === undefined ? {} : { options: operation.options }),
            result: structuredClone(status),
        };
        if (!Value.Check(imageGenerationReceiptSchema, receipt)) {
            throw new Error("Image generation feature created an invalid receipt.");
        }
        return receipt;
    }

    #proofFromReceipt(receipt: ImageGenerationReceipt): ImageGenerationProof {
        const proof = structuredClone(receipt);
        if (!Value.Check(imageGenerationProofSchema, proof)) {
            throw new Error("Image generation feature created an invalid generation proof.");
        }
        return proof;
    }

    #assertStatusIdentity(
        status: ImageGenerationStatus,
        agentId: string,
        operationId: string,
    ): void {
        if (status.agentId !== agentId || status.operationId !== operationId) {
            throw new Error("Image asset store returned a different operation identity.");
        }
        if (status.status === "completed") {
            if (status.asset.agentId !== agentId || status.asset.operationId !== operationId) {
                throw new Error("Image asset store returned an asset for a different owner.");
            }
        }
    }

    #assertStatusRequest(status: ImageGenerationStatus, operation: Operation): void {
        this.#assertStatusIdentity(status, operation.agentId, operation.operationId);
        if (
            status.fingerprint !== operation.fingerprint ||
            status.prompt !== operation.prompt ||
            !sameOptional(status.options, operation.options)
        ) {
            throw new Error("Image asset store returned state for a different request.");
        }
    }

    #assertCreated(
        status: ImageGenerationStatus,
        operation: Operation,
        stage: ImageGenerationStage,
    ): void {
        if (status.status !== "completed") {
            throw new Error("Image asset store did not return a completed generation.");
        }
        assertStatusBounds(status);
        this.#assertStatusRequest(status, operation);
        if (
            status.asset.agentId !== operation.agentId ||
            status.asset.operationId !== operation.operationId ||
            status.asset.mediaType !== stage.mediaType ||
            status.asset.byteLength !== stage.byteLength ||
            status.asset.width !== stage.width ||
            status.asset.height !== stage.height ||
            !sameOptional(status.asset.metadata, stage.metadata)
        ) {
            throw new Error("Image asset store returned an asset that does not match the request.");
        }
    }

    async #transaction<Result>(
        ctx: Context,
        work: (txCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        let finished = false;
        let expected: Result | undefined;
        const raw = await requirePromise(
            this.#store.transaction(ctx, async (txCtx) => {
                const result = await work(txCtx);
                expected = deepFreeze(structuredClone(result));
                finished = true;
                return result;
            }),
            "Image asset store transaction",
        );
        if (!finished || !sameJson(raw, expected)) {
            throw new Error("Image asset store transaction returned a substituted result.");
        }
        return structuredClone(expected as Result);
    }
}

function normalizeInput(input: ImageGenerationInput): ImageGenerationInput {
    if (!Value.Check(imageGenerationInputSchema, input)) {
        throw new Error("Image generation input is invalid.");
    }
    const prompt = input.prompt.trim();
    const normalized = {
        prompt,
        ...(input.options === undefined ? {} : { options: structuredClone(input.options) }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    };
    if (!Value.Check(imageGenerationInputSchema, normalized)) {
        throw new Error("Image prompt must not be empty and must be within the character limit.");
    }
    if (encodedBytes(normalized.options) > MAX_IMAGE_OPTIONS_CHARACTERS) {
        throw new Error("Image generation options exceed the configured bound.");
    }
    return normalized;
}

function operationFingerprint(agentId: string, input: ImageGenerationInput): string {
    const value = canonicalJson({
        agentId,
        prompt: input.prompt,
        ...(input.options === undefined ? {} : { options: input.options }),
    });
    const digest = createHash("sha256").update(value, "utf8").digest("hex");
    if (!Value.Check(imageFingerprintSchema, digest)) {
        throw new Error("Image generation request fingerprint is invalid.");
    }
    return digest;
}

function assertOutputBounds(maxBytes: number, maxCharacters: number): void {
    if (
        !Value.Check(Type.Integer({ minimum: 1, maximum: MAX_IMAGE_OUTPUT_BYTES }), maxBytes) ||
        !Value.Check(
            Type.Integer({ minimum: 256, maximum: MAX_IMAGE_FEATURE_OUTPUT_CHARACTERS }),
            maxCharacters,
        )
    ) {
        throw new Error("Image generation output bounds are invalid.");
    }
}

function assertGeneratedBounds(generated: GeneratedImage, maxBytes: number): void {
    if (generated.bytes.byteLength > maxBytes) {
        throw new Error(`Image generator output exceeds the ${String(maxBytes)} byte limit.`);
    }
    if (encodedBytes(generated.metadata) > MAX_IMAGE_METADATA_CHARACTERS) {
        throw new Error("Image generator metadata exceeds the configured bound.");
    }
}

function assertStatusBounds(status: ImageGenerationStatus): void {
    if (status.updatedAt < status.createdAt) {
        throw new Error("Image generation status timestamps are out of order.");
    }
    if (encodedBytes(status.options) > MAX_IMAGE_OPTIONS_CHARACTERS) {
        throw new Error("Image generation options exceed the configured bound.");
    }
    if (status.status === "completed") {
        assertMetadataBound(status.asset.metadata);
    }
}

function assertMetadataBound(metadata: unknown): void {
    if (encodedBytes(metadata) > MAX_IMAGE_METADATA_CHARACTERS) {
        throw new Error("Image metadata exceeds the configured bound.");
    }
}

function assertStageMatches(
    stage: ImageGenerationStage,
    input: Static<typeof stageInputSchema>,
    generated: GeneratedImage,
): void {
    if (
        stage.agentId !== input.agentId ||
        stage.operationId !== input.operationId ||
        stage.fingerprint !== input.fingerprint ||
        stage.mediaType !== generated.mediaType ||
        stage.byteLength !== generated.bytes.byteLength ||
        stage.width !== generated.width ||
        stage.height !== generated.height ||
        !sameOptional(stage.metadata, generated.metadata)
    ) {
        throw new Error("Image asset store staged data for a different request.");
    }
}

function assertAgentId(agentId: string): void {
    if (!Value.Check(imageAgentIdSchema, agentId)) {
        throw new Error("Image generation agent ID is invalid.");
    }
}

function assertOperationId(operationId: string): void {
    if (!Value.Check(imageOperationIdSchema, operationId)) {
        throw new Error("Image generation operation ID is invalid.");
    }
}

function assertAssetId(assetId: string): void {
    if (!Value.Check(imageAssetQuerySchema.properties.assetId, assetId)) {
        throw new Error("Image asset ID is invalid.");
    }
}

function assertEvent(event: unknown): asserts event is ImageGenerationEvent {
    if (!Value.Check(eventSchema, event)) {
        throw new Error("Image generation feature created an invalid event.");
    }
}

function sameOptional(left: unknown, right: unknown): boolean {
    if (left === undefined || right === undefined) return left === right;
    return sameJson(left, right);
}

function canonicalJson(value: unknown): string {
    let encoded: string | undefined;
    try {
        encoded = JSON.stringify(canonicalize(value));
    } catch {
        throw new Error("Image generation input is not canonicalizable.");
    }
    if (encoded === undefined) throw new Error("Image generation input is not serializable.");
    if (new TextEncoder().encode(encoded).byteLength > MAX_IMAGE_OPERATION_CANONICAL_BYTES) {
        throw new Error("Image generation input exceeds the canonicalization byte bound.");
    }
    return encoded;
}

function encodedBytes(value: unknown): number {
    if (value === undefined) return 0;
    return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function canonicalize(value: unknown, seen = new Set<object>(), depth = 0): unknown {
    if (depth > MAX_IMAGE_OPERATION_CANONICAL_DEPTH) {
        throw new Error("Image generation input is too deeply nested.");
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error("cyclic image input");
        seen.add(value);
        const result = value.map((entry) => canonicalize(entry, seen, depth + 1));
        seen.delete(value);
        return result;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("cyclic image input");
    seen.add(value);
    const result = Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalize(nested, seen, depth + 1)]),
    );
    seen.delete(value);
    return result;
}

function sameJson(left: unknown, right: unknown): boolean {
    try {
        return sameStructuredValue(left, right, 0, new Map<object, object>());
    } catch {
        return false;
    }
}

/**
 * Compare values after their TypeBox boundary has already been checked.
 *
 * Request fingerprints use canonicalJson's deliberately small byte budget, but
 * receipts and proofs repeat the prompt and can therefore be larger while
 * remaining schema-valid. Keep this comparison structural so equality does not
 * accidentally impose the request-fingerprint limit on persisted envelopes.
 */
function sameStructuredValue(
    left: unknown,
    right: unknown,
    depth: number,
    seen: Map<object, object>,
): boolean {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
        return false;
    }
    if (depth > MAX_IMAGE_OPERATION_CANONICAL_DEPTH) return false;

    if (left instanceof Uint8Array || right instanceof Uint8Array) {
        if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
        if (left.byteLength !== right.byteLength) return false;
        for (let index = 0; index < left.byteLength; index += 1) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!sameStructuredValue(left[index], right[index], depth + 1, seen)) return false;
        }
        return true;
    }

    const previouslyCompared = seen.get(left);
    if (previouslyCompared !== undefined) return previouslyCompared === right;
    seen.set(left, right);

    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
        const key = leftKeys[index];
        const rightKey = rightKeys[index];
        if (key === undefined || rightKey === undefined || key !== rightKey) return false;
        if (
            !sameStructuredValue(
                (left as Record<string, unknown>)[key],
                (right as Record<string, unknown>)[key],
                depth + 1,
                seen,
            )
        ) {
            return false;
        }
    }
    return true;
}

function safeError(error: unknown): string {
    try {
        const message = error instanceof Error ? error.message : String(error);
        return message.slice(0, 512) || "Unknown image observer error.";
    } catch {
        return "Unknown image observer error.";
    }
}

function deepFreeze<T>(value: T): T {
    // JavaScript cannot freeze the indexed elements of a non-empty typed
    // array. The snapshot is still detached; callers receive a separate clone
    // and byte equality is checked after each staging callback.
    if (value instanceof Uint8Array) return value;
    if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value as Record<string, unknown>)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (
        ((typeof value === "object" && value !== null) || typeof value === "function") &&
        typeof (value as { then?: unknown }).then === "function"
    );
}

async function requirePromise<T>(value: unknown, operation: string): Promise<T> {
    if (!isPromiseLike(value)) throw new Error(`${operation} must return a Promise.`);
    return (await value) as T;
}

async function requireVoid(value: unknown, operation: string): Promise<void> {
    const resolved = await requirePromise<unknown>(value, operation);
    if (resolved !== undefined) throw new Error(`${operation} must resolve to undefined.`);
}

export function assertImageGenerationFeatureOptions(
    value: unknown,
): asserts value is ImageGenerationFeatureOptions {
    const candidate = featureOptionsValidationView(value);
    if (!Value.Check(imageGenerationFeatureOptionsSchema, candidate)) {
        throw new Error("Image generation feature options are invalid.");
    }
}

function featureOptionsValidationView(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return {
        ...object,
        generator: contractValidationView(object.generator, ["generate"]),
        store: contractValidationView(object.store, [
            "transaction",
            "afterCommit",
            "onRollback",
            "stage",
            "commit",
            "rollback",
            "create",
            "status",
            "read",
            "remove",
            "readReceipt",
            "writeReceipt",
            "readGenerationProof",
            "writeGenerationProof",
        ]),
        ...(object.listener === undefined
            ? {}
            : {
                  listener: contractValidationView(object.listener, [
                      "onEventTransactional",
                      "onEvent",
                  ]),
              }),
    };
}

function contractValidationView(value: unknown, keys: readonly string[]): unknown {
    if (value === null || typeof value !== "object") return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
