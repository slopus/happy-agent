import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    secretAgentIdSchema,
    secretAttachReferenceResultSchema,
    secretAttachInputSchema,
    secretIdSchema,
    secretListInputSchema,
    secretListQuerySchema,
    secretMutationOptionsSchema,
    secretOperationFingerprintSchema,
    secretOperationIdSchema,
    secretOperationStateSchema,
    secretRegistrationInputSchema,
    secretRegistrationSchema,
    secretScopeRefSchema,
    secretUpdateInputSchema,
    type SecretAgentId,
    type SecretAttachReferenceResult,
    type SecretAttachInput,
    type SecretAttachment,
    type SecretHostEnvironment,
    type SecretId,
    type SecretListInput,
    type SecretListQuery,
    type SecretMutationOperation,
    type SecretMutationOptions,
    type SecretOperationFingerprint,
    type SecretOperationId,
    type SecretOperationState,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretRegistrationInput,
    type SecretScopeRef,
    type SecretUpdateInput,
} from "./Secret.js";
import {
    secretAuthorizationSchema,
    secretAuthorizationOperationSchema,
    secretMutationRequestSchema,
    secretStoreSchema,
    assertSecretAttachment,
    assertSecretHostEnvironment,
    assertSecretMutationProof,
    assertSecretOperationReceipt,
    assertSecretPage,
    assertSecretReference,
    assertSecretStoreMutationResult,
    type SecretAuthorization,
    type SecretAttachProof,
    type SecretDetachProof,
    type SecretMutationProof,
    type SecretOperationReceipt,
    type SecretRemoveProof,
    type SecretStore,
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreMutationResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./SecretStore.js";
import {
    secretContextSchema,
    secretEventIdSchema,
    secretEventSchema,
    secretEventTimestampSchema,
    secretFeatureListenerSchema,
    type SecretEvent,
    type SecretFeatureListener,
} from "./SecretEvent.js";
import { attachSecretTool } from "./tools/attach_secret.js";
import { detachSecretTool } from "./tools/detach_secret.js";
import { listSecretsTool } from "./tools/list_secrets.js";
import { referenceSecretTool } from "./tools/reference_secret.js";

const DEFAULT_MAX_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAX_OUTPUT_CHARACTERS = 12_000;
const MAX_OUTPUT_CHARACTERS = 100_000;
const MAX_SECRET_LIST_ITEMS = 256;
const MAX_FINGERPRINT_INPUT_BYTES = 256_000;
const MAX_FINGERPRINT_INPUT_DEPTH = 32;
const REGISTER_ID_KEY = "register_secret_id";

const identityResultSchema = Type.Union([
    secretIdSchema,
    secretOperationIdSchema,
    Type.Promise(Type.Union([secretIdSchema, secretOperationIdSchema])),
]);

const identityFactorySchema = Type.Function(
    [secretContextSchema, secretAgentIdSchema],
    identityResultSchema,
);

const eventFactorySchema = Type.Function(
    [secretContextSchema, secretAgentIdSchema],
    Type.Union([secretEventIdSchema, Type.Promise(secretEventIdSchema)]),
);

const clockSchema = Type.Function([], secretEventTimestampSchema);

const postCommitErrorSchema = Type.Function(
    [secretContextSchema, secretEventSchema, Type.Unknown()],
    Type.Union([Type.Void(), Type.Promise(Type.Unknown())]),
);

const secretFeatureOptionsSchema = Type.Object(
    {
        store: secretStoreSchema,
        idFactory: Type.Optional(identityFactorySchema),
        mutationIdFactory: Type.Optional(identityFactorySchema),
        eventIdFactory: Type.Optional(eventFactorySchema),
        clock: Type.Optional(clockSchema),
        listener: Type.Optional(secretFeatureListenerSchema),
        authorize: Type.Optional(secretAuthorizationSchema),
        onPostCommitError: Type.Optional(postCommitErrorSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
        maxOutputCharacters: Type.Optional(
            Type.Integer({
                minimum: 256,
                maximum: MAX_OUTPUT_CHARACTERS,
            }),
        ),
    },
    { additionalProperties: false },
);

/** Public constructor validation schema. */
export { secretFeatureOptionsSchema };
export type SecretsFeatureOptions = Static<typeof secretFeatureOptionsSchema>;

type SecretIdentityFactory = Static<typeof identityFactorySchema>;
type SecretEventFactory = Static<typeof eventFactorySchema>;
type SecretClock = Static<typeof clockSchema>;
type SecretPostCommitError = Static<typeof postCommitErrorSchema>;

type SecretChange<Result> = {
    readonly result: Result;
    readonly event?: SecretEvent | undefined;
};

type SecretOperation = {
    readonly kind: SecretMutationOperation;
    readonly operationId: SecretOperationId;
    readonly fingerprint: SecretOperationFingerprint;
};

/**
 * Host-owned secret metadata and attachment management.
 *
 * The feature never stores secret values, opens a database, edits `process.env`, or decides how a
 * host applies resolved values. `resolveForHost` is intentionally not exposed as a model tool.
 */
export class SecretsFeature implements AgentFeature {
    readonly name = "secrets";

    readonly #store: SecretStore;
    readonly #idFactory: SecretIdentityFactory;
    readonly #mutationIdFactory: SecretIdentityFactory;
    readonly #eventIdFactory: SecretEventFactory;
    readonly #clock: SecretClock;
    readonly #listener: SecretFeatureListener | undefined;
    readonly #authorize: SecretAuthorization | undefined;
    readonly #onPostCommitError: SecretPostCommitError | undefined;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;

    constructor(options: SecretsFeatureOptions) {
        assertSecretsFeatureOptions(options);
        this.#store = options.store;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#mutationIdFactory =
            options.mutationIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? (() => Date.now());
        this.#listener = options.listener;
        this.#authorize = options.authorize;
        this.#onPostCommitError = options.onPostCommitError;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
        if (!Value.Check(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE }), this.#maxPageSize)) {
            throw new Error("Secrets max page size is invalid.");
        }
        if (
            !Value.Check(
                Type.Integer({ minimum: 256, maximum: MAX_OUTPUT_CHARACTERS }),
                this.#maxOutputCharacters,
            )
        ) {
            throw new Error("Secrets max model output size is invalid.");
        }
    }

    /** Return a bounded page of safe secret metadata, optionally filtered by an opaque scope. */
    async list(
        ctx: Context,
        actingAgentId: string,
        query: SecretListInput = {},
    ): Promise<SecretPage> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertInput(secretListInputSchema, query, "list query");
        await this.#authorizeOperation(ctx, actingAgentId, "list", query.scopeRef);
        const normalized = this.#listQuery(query);
        for (let limit = normalized.limit; limit >= 1; limit -= 1) {
            const page = await this.#readPage(ctx, actingAgentId, {
                ...normalized,
                limit,
            });
            if (this.#formatPage(page, true).length <= this.#maxOutputCharacters) return page;
        }
        throw new Error("Secret metadata cannot fit a complete model-facing page.");
    }

    /** Read one safe reference. This method never returns registration values. */
    async reference(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
    ): Promise<SecretReference | undefined> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        await this.#authorizeOperation(ctx, actingAgentId, "reference");
        const value = await this.#store.reference(ctx, actingAgentId, secretId);
        if (value === undefined) return undefined;
        const reference = this.#normalizeReference(value);
        if (reference.id !== secretId) {
            throw new Error("Secret store returned a different reference identity.");
        }
        return reference;
    }

    /** Register a host-owned secret and return safe metadata only. */
    async register(
        ctx: Context,
        actingAgentId: string,
        input: SecretRegistrationInput,
        options: SecretMutationOptions = {},
    ): Promise<SecretReference> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertInput(secretRegistrationInputSchema, input, "registration");
        this.#assertOptions(options);
        await this.#authorizeOperation(ctx, actingAgentId, "register");
        const normalizedInput = normalizeRegistrationInput(input);
        const requestedFingerprint = fingerprint({
            kind: "register",
            actingAgentId,
            input: withoutRegistrationId(normalizedInput),
        });
        const id = await this.#registrationId(
            ctx,
            actingAgentId,
            normalizedInput.id,
            requestedFingerprint,
        );
        const registration = this.#normalizeRegistration({ ...normalizedInput, id });
        const operation = await this.#operation(
            ctx,
            actingAgentId,
            "register",
            "register",
            options.operationId,
            {
                id,
                input: withoutRegistrationId(registration),
            },
        );
        const eventId = await this.#eventId(ctx, actingAgentId, operation);
        const at = this.#now();

        return await this.#runTransaction(ctx, "register", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, actingAgentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayRegister(
                        txCtx,
                        actingAgentId,
                        operation,
                        receipt,
                        registration,
                    ),
                };
            }

            const before = await this.reference(txCtx, actingAgentId, registration.id);
            const raw = await this.#store.register(
                txCtx,
                actingAgentId,
                structuredClone(registration),
                this.#metadata(operation),
            );
            const mutation = this.#asRegisterResult(raw, operation);
            const authoritative = await this.#requiredReference(
                txCtx,
                actingAgentId,
                registration.id,
                "register",
            );
            const changed = this.#reconcileRegister(mutation, registration, authoritative, before);
            const result = this.#registerResult(operation, changed, authoritative);
            await this.#writeReceipt(txCtx, actingAgentId, operation, result);
            return {
                result: authoritative,
                event: changed
                    ? this.#event(
                          {
                              type: "secret_registered",
                              secret: authoritative,
                          },
                          actingAgentId,
                          operation,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Update host-owned values or description and return safe metadata only. */
    async update(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
        input: SecretUpdateInput,
        options: SecretMutationOptions = {},
    ): Promise<SecretReference | undefined> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        this.#assertInput(secretUpdateInputSchema, input, "update");
        this.#assertOptions(options);
        await this.#authorizeOperation(ctx, actingAgentId, "update");
        const normalizedInput = normalizeUpdateInput(input);
        const operation = await this.#operation(
            ctx,
            actingAgentId,
            "update",
            `update:${secretId}`,
            options.operationId,
            { secretId, input: normalizedInput },
        );
        const eventId = await this.#eventId(ctx, actingAgentId, operation);
        const at = this.#now();

        return await this.#runTransaction(ctx, "update", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, actingAgentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayUpdate(
                        txCtx,
                        actingAgentId,
                        operation,
                        receipt,
                        secretId,
                    ),
                };
            }

            const before = await this.reference(txCtx, actingAgentId, secretId);
            if (before === undefined) {
                const raw = await this.#store.update(
                    txCtx,
                    actingAgentId,
                    secretId,
                    structuredClone(normalizedInput),
                    this.#metadata(operation),
                );
                const mutation = this.#asUpdateResult(raw, operation, secretId);
                const after = await this.reference(txCtx, actingAgentId, secretId);
                if (mutation.changed || mutation.reference !== undefined || after !== undefined) {
                    throw new Error("Secret update returned a mutation for a missing secret.");
                }
                const result = this.#updateResult(operation, false, secretId, undefined);
                await this.#writeReceipt(txCtx, actingAgentId, operation, result);
                return { result: undefined };
            }

            const raw = await this.#store.update(
                txCtx,
                actingAgentId,
                secretId,
                structuredClone(normalizedInput),
                this.#metadata(operation),
            );
            const mutation = this.#asUpdateResult(raw, operation, secretId);
            const authoritative = await this.#requiredReference(
                txCtx,
                actingAgentId,
                secretId,
                "update",
            );
            const changed = this.#reconcileUpdate(
                mutation,
                before,
                authoritative,
                secretId,
                normalizedInput,
            );
            const result = this.#updateResult(operation, changed, secretId, authoritative);
            await this.#writeReceipt(txCtx, actingAgentId, operation, result);
            return {
                result: authoritative,
                event: changed
                    ? this.#event(
                          {
                              type: "secret_updated",
                              secret: authoritative,
                          },
                          actingAgentId,
                          operation,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Remove one secret and let the host store remove its attachments atomically. */
    async remove(
        ctx: Context,
        actingAgentId: string,
        secretId: string,
        options: SecretMutationOptions = {},
    ): Promise<boolean> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertSecretId(secretId);
        this.#assertOptions(options);
        await this.#authorizeOperation(ctx, actingAgentId, "remove");
        const operation = await this.#operation(
            ctx,
            actingAgentId,
            "remove",
            `remove:${secretId}`,
            options.operationId,
            { secretId },
        );
        const eventId = await this.#eventId(ctx, actingAgentId, operation);
        const at = this.#now();

        return await this.#runTransaction(ctx, "remove", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, actingAgentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayRemove(
                        txCtx,
                        actingAgentId,
                        operation,
                        receipt,
                        secretId,
                    ),
                };
            }

            const persistedProof = await this.#readMutationProof(txCtx, actingAgentId, operation);
            if (persistedProof !== undefined) {
                throw new Error("Secret store has an immutable remove proof without its receipt.");
            }

            const before = await this.reference(txCtx, actingAgentId, secretId);
            const raw = await this.#store.remove(
                txCtx,
                actingAgentId,
                secretId,
                this.#metadata(operation),
            );
            const mutation = this.#asRemoveResult(raw, operation, secretId);
            this.#reconcileRemove(mutation, before, secretId);
            const after = await this.reference(txCtx, actingAgentId, secretId);
            if (before === undefined && after !== undefined) {
                throw new Error("Secret store remove created a missing secret.");
            }
            if (mutation.removed !== (before !== undefined && after === undefined)) {
                throw new Error("Secret store remove result is not authoritative.");
            }
            const proof = this.#removeProof(operation, actingAgentId, secretId, before, mutation);
            await this.#writeMutationProof(txCtx, actingAgentId, proof);
            const result = this.#removeResult(operation, mutation.removed, secretId, before);
            await this.#writeReceipt(txCtx, actingAgentId, operation, result);
            return {
                result: mutation.removed,
                event: mutation.removed
                    ? this.#event(
                          { type: "secret_removed", secretId },
                          actingAgentId,
                          operation,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Attach one safe reference to an opaque host scope. */
    async attach(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
        options?: SecretMutationOptions,
    ): Promise<SecretAttachment>;
    async attach(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
        options?: SecretMutationOptions,
    ): Promise<SecretAttachment>;
    async attach(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretIdOrOptions?: string | SecretMutationOptions,
        maybeOptions: SecretMutationOptions = {},
    ): Promise<SecretAttachment> {
        const result = await this.#attachInternal(
            ctx,
            actingAgentId,
            scopeOrInput,
            secretIdOrOptions,
            maybeOptions,
        );
        return result.attachment;
    }

    /**
     * Attach one reference and retain the bounded safe reference snapshot needed
     * by durable tool replay. The snapshot is persisted in the host receipt, so
     * replay never depends on the secret still being registered.
     */
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
        options?: SecretMutationOptions,
    ): Promise<SecretAttachReferenceResult>;
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
        options?: SecretMutationOptions,
    ): Promise<SecretAttachReferenceResult>;
    async attachWithReference(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretIdOrOptions?: string | SecretMutationOptions,
        maybeOptions: SecretMutationOptions = {},
    ): Promise<SecretAttachReferenceResult> {
        return await this.#attachInternal(
            ctx,
            actingAgentId,
            scopeOrInput,
            secretIdOrOptions,
            maybeOptions,
        );
    }

    async #attachInternal(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretIdOrOptions?: string | SecretMutationOptions,
        maybeOptions: SecretMutationOptions = {},
    ): Promise<SecretAttachReferenceResult> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        const { input, options } = this.#attachArguments(
            scopeOrInput,
            secretIdOrOptions,
            maybeOptions,
        );
        this.#assertOptions(options);
        await this.#authorizeOperation(ctx, actingAgentId, "attach", input.scopeRef);
        const operation = await this.#operation(
            ctx,
            actingAgentId,
            "attach",
            `attach:${input.scopeRef}:${input.secretId}`,
            options.operationId,
            input,
        );
        const eventId = await this.#eventId(ctx, actingAgentId, operation);
        const at = this.#now();

        return await this.#runTransaction(ctx, "attach", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, actingAgentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayAttach(
                        txCtx,
                        actingAgentId,
                        operation,
                        receipt,
                        input,
                    ),
                };
            }

            const persistedProof = await this.#readMutationProof(txCtx, actingAgentId, operation);
            if (persistedProof !== undefined) {
                throw new Error("Secret store has an immutable attach proof without its receipt.");
            }

            const reference = await this.reference(txCtx, actingAgentId, input.secretId);
            if (reference === undefined) {
                throw new Error("The secret reference does not exist.");
            }
            const before = await this.#attachment(txCtx, actingAgentId, input);
            const raw = await this.#store.attach(
                txCtx,
                actingAgentId,
                structuredClone(input),
                this.#metadata(operation),
            );
            const mutation = this.#asAttachResult(raw, operation, input);
            const authoritative = await this.#requiredAttachment(
                txCtx,
                actingAgentId,
                input,
                "attach",
            );
            this.#reconcileAttach(mutation, before, authoritative, input, reference);
            const result = this.#attachResult(
                operation,
                mutation.changed,
                authoritative,
                reference,
            );
            const proof = this.#attachProof(
                operation,
                actingAgentId,
                input,
                mutation,
                authoritative,
                reference,
            );
            await this.#writeMutationProof(txCtx, actingAgentId, proof);
            await this.#writeReceipt(txCtx, actingAgentId, operation, result);
            const toolResult: SecretAttachReferenceResult = {
                attachment: structuredClone(authoritative),
                secret: structuredClone(reference),
            };
            if (!Value.Check(secretAttachReferenceResultSchema, toolResult)) {
                throw new Error("Secrets feature created an invalid attach result.");
            }
            return {
                result: toolResult,
                event: mutation.changed
                    ? this.#event(
                          {
                              type: "secret_attached",
                              attachment: authoritative,
                          },
                          actingAgentId,
                          operation,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /** Detach one safe reference from an opaque host scope. */
    async detach(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretId: string,
        options?: SecretMutationOptions,
    ): Promise<boolean>;
    async detach(
        ctx: Context,
        actingAgentId: string,
        input: SecretAttachInput,
        options?: SecretMutationOptions,
    ): Promise<boolean>;
    async detach(
        ctx: Context,
        actingAgentId: string,
        scopeOrInput: string | SecretAttachInput,
        secretIdOrOptions?: string | SecretMutationOptions,
        maybeOptions: SecretMutationOptions = {},
    ): Promise<boolean> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        const { input, options } = this.#attachArguments(
            scopeOrInput,
            secretIdOrOptions,
            maybeOptions,
        );
        this.#assertOptions(options);
        await this.#authorizeOperation(ctx, actingAgentId, "detach", input.scopeRef);
        const operation = await this.#operation(
            ctx,
            actingAgentId,
            "detach",
            `detach:${input.scopeRef}:${input.secretId}`,
            options.operationId,
            input,
        );
        const eventId = await this.#eventId(ctx, actingAgentId, operation);
        const at = this.#now();

        return await this.#runTransaction(ctx, "detach", async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, actingAgentId, operation);
            if (receipt !== undefined) {
                return {
                    result: await this.#replayDetach(
                        txCtx,
                        actingAgentId,
                        operation,
                        receipt,
                        input,
                    ),
                };
            }

            const persistedProof = await this.#readMutationProof(txCtx, actingAgentId, operation);
            if (persistedProof !== undefined) {
                throw new Error("Secret store has an immutable detach proof without its receipt.");
            }

            const before = await this.#attachment(txCtx, actingAgentId, input);
            const raw = await this.#store.detach(
                txCtx,
                actingAgentId,
                structuredClone(input),
                this.#metadata(operation),
            );
            const mutation = this.#asDetachResult(raw, operation, input);
            const after = await this.#attachment(txCtx, actingAgentId, input);
            if (before === undefined && after !== undefined) {
                throw new Error("Secret store detach created a missing attachment.");
            }
            if (mutation.detached !== (before !== undefined && after === undefined)) {
                throw new Error("Secret store detach result is not authoritative.");
            }
            if (!mutation.detached && mutation.attachment !== undefined) {
                throw new Error("Secret store detach returned an attachment for a no-op.");
            }
            const proof = this.#detachProof(operation, actingAgentId, input, before, mutation);
            await this.#writeMutationProof(txCtx, actingAgentId, proof);
            const result = this.#detachResult(operation, mutation.detached, input, before);
            await this.#writeReceipt(txCtx, actingAgentId, operation, result);
            return {
                result: mutation.detached,
                event: mutation.detached
                    ? this.#event(
                          {
                              type: "secret_detached",
                              scopeRef: input.scopeRef,
                              secretId: input.secretId,
                          },
                          actingAgentId,
                          operation,
                          eventId,
                          at,
                      )
                    : undefined,
            };
        });
    }

    /**
     * Resolve attached values for a trusted host operation.
     *
     * This is deliberately not a tool and its result is never converted into model-facing text.
     */
    async resolveForHost(
        ctx: Context,
        actingAgentId: string,
        scopeRef: string,
        secretIds?: readonly string[],
    ): Promise<SecretHostEnvironment> {
        this.#assertContext(ctx);
        this.#assertAgentId(actingAgentId);
        this.#assertScopeRef(scopeRef);
        await this.#authorizeOperation(ctx, actingAgentId, "resolve", scopeRef);
        if (
            secretIds !== undefined &&
            (!Array.isArray(secretIds) ||
                secretIds.length > MAX_SECRET_LIST_ITEMS ||
                new Set(secretIds).size !== secretIds.length ||
                secretIds.some((secretId) => !Value.Check(secretIdSchema, secretId)))
        ) {
            throw new Error("Secret resolver selection is invalid.");
        }
        const environment = await this.#store.resolveForHost(
            ctx,
            actingAgentId,
            scopeRef,
            secretIds === undefined ? undefined : structuredClone(secretIds),
        );
        assertSecretHostEnvironment(environment);
        return structuredClone(environment);
    }

    /** Common provider-neutral tools. None can call the raw host resolver. */
    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        listSecretsTool(this, scope.agent.id),
        referenceSecretTool(this, scope.agent.id),
        attachSecretTool(this, scope.agent.id),
        detachSecretTool(this, scope.agent.id),
    ];

    /** Tell the model that metadata is available while values remain host-only. */
    readonly instructions = async (): Promise<string> =>
        "Secret tools expose references and environment-variable names only. Secret values are available only to the host and must never be requested in chat, tool arguments, or model output.";

    /** Render safe metadata for a model without ever reading host values. */
    formatForModel(page: SecretPage): string {
        const normalized = this.#normalizePage(page);
        const output = this.#formatPage(normalized, false);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret model output cannot fit complete metadata identities.");
        }
        return output;
    }

    /** Render a page and retain its opaque continuation cursor for the model. */
    formatPageForModel(page: SecretPage): string {
        const normalized = this.#normalizePage(page);
        const output = this.#formatPage(normalized, true);
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret page output cannot fit complete metadata and cursor.");
        }
        return output;
    }

    /** Format an attachment result without allowing tool-added context to exceed the cap. */
    formatAttachmentForModel(scopeRef: SecretScopeRef, secret: SecretReference): string {
        this.#assertScopeRef(scopeRef);
        const normalized = this.#normalizeReference(secret);
        const detailed = `Attached ${JSON.stringify(normalized.id)} to scope ${JSON.stringify(scopeRef)}.\n${this.#formatPage(
            {
                secrets: [normalized],
                limit: 1,
            },
            false,
        )}`;
        const output =
            detailed.length <= this.#maxOutputCharacters
                ? detailed
                : `attach\nscope=${scopeRef}\nsecret=${normalized.id}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret attachment output cannot fit complete metadata.");
        }
        return output;
    }

    /** Format a detach result without allowing long opaque identities to bypass the cap. */
    formatDetachForModel(detached: boolean, scopeRef: SecretScopeRef, secretId: SecretId): string {
        this.#assertScopeRef(scopeRef);
        this.#assertSecretId(secretId);
        const detailed = detached
            ? `Detached ${JSON.stringify(secretId)} from scope ${JSON.stringify(scopeRef)}.`
            : `Secret ${JSON.stringify(secretId)} was not attached to scope ${JSON.stringify(scopeRef)}.`;
        const output =
            detailed.length <= this.#maxOutputCharacters
                ? detailed
                : detached
                  ? `attached\nscope=${scopeRef}\nsecret=${secretId}`
                  : `not attached\nscope=${scopeRef}\nsecret=${secretId}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Secret detach output cannot fit complete identities.");
        }
        return output;
    }

    async #readPage(
        ctx: Context,
        actingAgentId: SecretAgentId,
        query: SecretListQuery,
    ): Promise<SecretPage> {
        const raw = await this.#store.list(ctx, actingAgentId, query);
        assertSecretPage(raw);
        if (raw.limit !== query.limit || raw.secrets.length > query.limit) {
            throw new Error("Secret store returned a page outside the requested bounds.");
        }
        if (raw.nextCursor !== undefined) {
            if (
                raw.secrets.length === 0 ||
                !cursorProgressed(query.cursor, raw.nextCursor, raw.secrets.length)
            ) {
                throw new Error("Secret store returned a non-progressing secret cursor.");
            }
        }
        const page = this.#normalizePage({
            secrets: raw.secrets,
            limit: query.limit,
            ...(raw.nextCursor === undefined ? {} : { nextCursor: raw.nextCursor }),
        });
        if (query.scopeRef !== undefined) {
            for (const secret of page.secrets) {
                const attachment = await this.#attachment(ctx, actingAgentId, {
                    scopeRef: query.scopeRef,
                    secretId: secret.id,
                });
                if (attachment === undefined) {
                    throw new Error(
                        "Secret store returned a reference that is not attached to the requested scope.",
                    );
                }
            }
        }
        return page;
    }

    #formatPage(page: SecretPage, includeCursor: boolean): string {
        const withCursor = (rows: string): string =>
            includeCursor && page.nextCursor !== undefined
                ? `${rows}\nnext=${page.nextCursor}`
                : rows;
        const detailedRows =
            page.secrets.length === 0
                ? "No secret references."
                : page.secrets.map((secret) => this.#formatReference(secret)).join("\n");
        const detailed = withCursor(detailedRows);
        if (detailed.length <= this.#maxOutputCharacters) return detailed;
        const compactRows =
            page.secrets.length === 0
                ? "No secret references."
                : page.secrets.map((secret) => `secret id=${secret.id}`).join("\n");
        return withCursor(compactRows);
    }

    async #runTransaction<Result>(
        ctx: Context,
        operation: string,
        work: (txCtx: Context) => Promise<SecretChange<Result>>,
    ): Promise<Result> {
        let expected: SecretChange<Result> | undefined;
        const raw = await this.#store.transaction(ctx, async (txCtx) => {
            const change = await work(txCtx);
            if (change.event !== undefined) {
                await this.#observe(txCtx, change.event);
            }
            expected = structuredClone(change);
            return structuredClone(change);
        });
        if (expected === undefined || !sameJson(raw, expected)) {
            throw new Error(`Secret ${operation} transaction returned a substituted result.`);
        }
        return structuredClone(expected.result);
    }

    async #observe(ctx: Context, event: SecretEvent): Promise<void> {
        if (!Value.Check(secretEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Secrets feature created an invalid unfrozen event.");
        }
        const transactional = this.#listener?.onEventTransactional;
        if (transactional !== undefined) {
            await transactional.call(this.#listener, ctx, event);
        }
        const registration = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, event),
        );
        if (registration !== undefined) {
            throw new Error("Secret store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: SecretEvent): Promise<void> {
        try {
            const listener = this.#listener?.onEvent;
            if (listener !== undefined) {
                await listener.call(this.#listener, ctx, event);
            }
        } catch (error: unknown) {
            try {
                await this.#onPostCommitError?.(ctx, event, error);
            } catch {
                // Reporting is advisory after durable state has settled.
            }
        }
    }

    async #readReceipt(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
    ): Promise<SecretOperationReceipt | undefined> {
        const raw = await this.#store.readReceipt(ctx, actingAgentId, operation.operationId);
        if (raw === undefined) return undefined;
        assertSecretOperationReceipt(raw);
        this.#assertReceiptIdentity(raw, actingAgentId, operation);
        return structuredClone(raw);
    }

    async #writeReceipt(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        result: SecretStoreMutationResult,
    ): Promise<void> {
        this.#assertResultIdentity(result, operation);
        const receipt: SecretOperationReceipt = {
            agentId: actingAgentId,
            operation: operation.kind,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            result: structuredClone(result),
        };
        assertSecretOperationReceipt(receipt);
        const returned = await this.#store.writeReceipt(ctx, actingAgentId, receipt);
        if (returned !== undefined) {
            throw new Error("Secret store writeReceipt must resolve to undefined.");
        }
        const persisted = await this.#store.readReceipt(ctx, actingAgentId, operation.operationId);
        if (persisted === undefined) {
            throw new Error("Secret store did not persist the operation receipt.");
        }
        assertSecretOperationReceipt(persisted);
        this.#assertReceiptIdentity(persisted, actingAgentId, operation);
        if (!sameJson(persisted, receipt)) {
            throw new Error("Secret store persisted a different operation receipt.");
        }
    }

    async #readMutationProof(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
    ): Promise<SecretMutationProof | undefined> {
        const raw = await this.#store.readMutationProof(ctx, actingAgentId, operation.operationId);
        if (raw === undefined) return undefined;
        assertSecretMutationProof(raw);
        this.#assertMutationProofIdentity(raw, actingAgentId, operation);
        return structuredClone(raw);
    }

    async #writeMutationProof(
        ctx: Context,
        actingAgentId: SecretAgentId,
        proof: SecretMutationProof,
    ): Promise<void> {
        assertSecretMutationProof(proof);
        const operation: SecretOperation = {
            kind: proof.operation,
            operationId: proof.operationId,
            fingerprint: proof.fingerprint,
        };
        this.#assertMutationProofIdentity(proof, actingAgentId, operation);
        const returned = await this.#store.writeMutationProof(
            ctx,
            actingAgentId,
            structuredClone(proof),
        );
        if (returned !== undefined) {
            throw new Error("Secret store writeMutationProof must resolve to undefined.");
        }
        const persisted = await this.#store.readMutationProof(
            ctx,
            actingAgentId,
            proof.operationId,
        );
        if (persisted === undefined) {
            throw new Error("Secret store did not persist the immutable mutation proof.");
        }
        assertSecretMutationProof(persisted);
        this.#assertMutationProofIdentity(persisted, actingAgentId, operation);
        if (!sameJson(persisted, proof)) {
            throw new Error("Secret store persisted a different immutable mutation proof.");
        }
    }

    #metadata(operation: SecretOperation) {
        const metadata = {
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
        };
        if (!Value.Check(secretMutationRequestSchema, metadata)) {
            throw new Error("Secrets feature created an invalid mutation request.");
        }
        return metadata;
    }

    #registerResult(
        operation: SecretOperation,
        changed: boolean,
        reference: SecretReference,
    ): SecretStoreRegisterResult {
        return {
            operation: "register",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            reference: structuredClone(reference),
        };
    }

    #updateResult(
        operation: SecretOperation,
        changed: boolean,
        secretId: SecretId,
        reference: SecretReference | undefined,
    ): SecretStoreUpdateResult {
        return {
            operation: "update",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            secretId,
            ...(reference === undefined ? {} : { reference: structuredClone(reference) }),
        };
    }

    #removeResult(
        operation: SecretOperation,
        removed: boolean,
        secretId: SecretId,
        reference: SecretReference | undefined,
    ): SecretStoreRemoveResult {
        return {
            operation: "remove",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            removed,
            secretId,
            ...(reference === undefined ? {} : { reference: structuredClone(reference) }),
        };
    }

    #removeProof(
        operation: SecretOperation,
        actingAgentId: SecretAgentId,
        secretId: SecretId,
        before: SecretReference | undefined,
        mutation: SecretStoreRemoveResult,
    ): SecretRemoveProof {
        const proof: SecretRemoveProof = {
            agentId: actingAgentId,
            operation: "remove",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            secretId,
            before: before === undefined ? null : structuredClone(before),
            removed: mutation.removed,
        };
        assertSecretMutationProof(proof);
        return proof;
    }

    #attachResult(
        operation: SecretOperation,
        changed: boolean,
        attachment: SecretAttachment,
        reference: SecretReference,
    ): SecretStoreAttachResult {
        return {
            operation: "attach",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            changed,
            attachment: structuredClone(attachment),
            reference: structuredClone(reference),
        };
    }

    #attachProof(
        operation: SecretOperation,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
        mutation: SecretStoreAttachResult,
        attachment: SecretAttachment,
        reference: SecretReference,
    ): SecretAttachProof {
        const proof: SecretAttachProof = {
            agentId: actingAgentId,
            operation: "attach",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            scopeRef: input.scopeRef,
            secretId: input.secretId,
            changed: mutation.changed,
            attachment: structuredClone(attachment),
            reference: structuredClone(reference),
        };
        assertSecretMutationProof(proof);
        return proof;
    }

    #detachResult(
        operation: SecretOperation,
        detached: boolean,
        input: SecretAttachInput,
        attachment: SecretAttachment | undefined,
    ): SecretStoreDetachResult {
        return {
            operation: "detach",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            detached,
            ...(attachment === undefined ? {} : { attachment: structuredClone(attachment) }),
        };
    }

    #detachProof(
        operation: SecretOperation,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
        before: SecretAttachment | undefined,
        mutation: SecretStoreDetachResult,
    ): SecretDetachProof {
        const proof: SecretDetachProof = {
            agentId: actingAgentId,
            operation: "detach",
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
            scopeRef: input.scopeRef,
            secretId: input.secretId,
            before: before === undefined ? null : structuredClone(before),
            detached: mutation.detached,
        };
        assertSecretMutationProof(proof);
        return proof;
    }

    #asRegisterResult(value: unknown, operation: SecretOperation): SecretStoreRegisterResult {
        assertSecretStoreMutationResult(value);
        this.#assertResultIdentity(value, operation);
        if (value.operation !== "register") {
            throw new Error("Secret store register returned the wrong operation.");
        }
        return value;
    }

    #asUpdateResult(
        value: unknown,
        operation: SecretOperation,
        secretId: SecretId,
    ): SecretStoreUpdateResult {
        assertSecretStoreMutationResult(value);
        this.#assertResultIdentity(value, operation);
        if (value.operation !== "update" || value.secretId !== secretId) {
            throw new Error("Secret store update returned a different secret identity.");
        }
        return value;
    }

    #asRemoveResult(
        value: unknown,
        operation: SecretOperation,
        secretId: SecretId,
    ): SecretStoreRemoveResult {
        assertSecretStoreMutationResult(value);
        this.#assertResultIdentity(value, operation);
        if (value.operation !== "remove" || value.secretId !== secretId) {
            throw new Error("Secret store remove returned a different secret identity.");
        }
        return value;
    }

    #asAttachResult(
        value: unknown,
        operation: SecretOperation,
        input: SecretAttachInput,
    ): SecretStoreAttachResult {
        assertSecretStoreMutationResult(value);
        this.#assertResultIdentity(value, operation);
        if (
            value.operation !== "attach" ||
            value.attachment.scopeRef !== input.scopeRef ||
            value.attachment.secretId !== input.secretId
        ) {
            throw new Error("Secret store attach returned a different attachment.");
        }
        return value;
    }

    #asDetachResult(
        value: unknown,
        operation: SecretOperation,
        input: SecretAttachInput,
    ): SecretStoreDetachResult {
        assertSecretStoreMutationResult(value);
        this.#assertResultIdentity(value, operation);
        if (value.operation !== "detach") {
            throw new Error("Secret store detach returned the wrong operation.");
        }
        if (
            value.attachment !== undefined &&
            (value.attachment.scopeRef !== input.scopeRef ||
                value.attachment.secretId !== input.secretId)
        ) {
            throw new Error("Secret store detach returned a different attachment.");
        }
        return value;
    }

    #assertResultIdentity(value: SecretStoreMutationResult, operation: SecretOperation): void {
        if (
            value.operation !== operation.kind ||
            value.operationId !== operation.operationId ||
            value.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Secret store returned a different requested operation.");
        }
    }

    #assertReceiptIdentity(
        receipt: SecretOperationReceipt,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
    ): void {
        if (
            receipt.agentId !== actingAgentId ||
            receipt.operation !== operation.kind ||
            receipt.operationId !== operation.operationId ||
            receipt.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Secret operation identity was reused with different input.");
        }
        this.#assertResultIdentity(receipt.result, operation);
    }

    #assertMutationProofIdentity(
        proof: SecretMutationProof,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
    ): void {
        if (
            proof.agentId !== actingAgentId ||
            proof.operation !== operation.kind ||
            proof.operationId !== operation.operationId ||
            proof.fingerprint !== operation.fingerprint
        ) {
            throw new Error("Secret immutable mutation proof has a different operation identity.");
        }
    }

    #reconcileRegister(
        mutation: SecretStoreRegisterResult,
        request: SecretRegistration,
        authoritative: SecretReference,
        before: SecretReference | undefined,
    ): boolean {
        if (mutation.reference.id !== request.id || authoritative.id !== request.id) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        if (
            authoritative.description !== request.description ||
            !sameEnvironmentNames(authoritative.environmentVariables, request.environment)
        ) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        const mutationReference = this.#normalizeReference(mutation.reference);
        const changed = before === undefined || !sameReference(before, authoritative);
        if (mutation.changed !== changed || !sameReference(mutationReference, authoritative)) {
            throw new Error("Secret store did not authoritatively persist the registration.");
        }
        return changed;
    }

    #reconcileUpdate(
        mutation: SecretStoreUpdateResult,
        before: SecretReference,
        authoritative: SecretReference,
        secretId: SecretId,
        request: SecretUpdateInput,
    ): boolean {
        const expectedDescription = request.description ?? before.description;
        const expectedEnvironmentNames = applyEnvironmentPatch(
            before.environmentVariables,
            request.environment,
        );
        if (
            authoritative.description !== expectedDescription ||
            !sameStrings(authoritative.environmentVariables, expectedEnvironmentNames)
        ) {
            throw new Error("Secret store did not authoritatively persist the update.");
        }
        const mutationReference =
            mutation.reference === undefined
                ? undefined
                : this.#normalizeReference(mutation.reference);
        const changed = !sameReference(before, authoritative);
        if (
            mutationReference === undefined ||
            mutationReference.id !== secretId ||
            !sameReference(mutationReference, authoritative) ||
            mutation.changed !== changed
        ) {
            throw new Error("Secret store did not authoritatively persist the update.");
        }
        return changed;
    }

    #reconcileRemove(
        mutation: SecretStoreRemoveResult,
        before: SecretReference | undefined,
        secretId: SecretId,
    ): void {
        if (
            mutation.secretId !== secretId ||
            mutation.removed !== (before !== undefined) ||
            (mutation.reference !== undefined &&
                (before === undefined || !sameReference(mutation.reference, before)))
        ) {
            throw new Error("Secret store remove result is not authoritative.");
        }
    }

    #reconcileAttach(
        mutation: SecretStoreAttachResult,
        before: SecretAttachment | undefined,
        authoritative: SecretAttachment,
        input: SecretAttachInput,
        reference: SecretReference,
    ): void {
        if (
            mutation.attachment.scopeRef !== input.scopeRef ||
            mutation.attachment.secretId !== input.secretId ||
            !sameJson(mutation.attachment, authoritative) ||
            mutation.changed !== (before === undefined) ||
            (mutation.reference !== undefined &&
                !sameReference(this.#normalizeReference(mutation.reference), reference))
        ) {
            throw new Error("Secret store did not authoritatively persist the attachment.");
        }
    }

    async #replayRegister(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        receipt: SecretOperationReceipt,
        request: SecretRegistration,
    ): Promise<SecretReference> {
        this.#assertReceiptIdentity(receipt, actingAgentId, operation);
        if (receipt.result.operation !== "register" || receipt.result.reference.id !== request.id) {
            throw new Error("Secret registration receipt has a different identity.");
        }
        const current = await this.#requiredReference(
            ctx,
            actingAgentId,
            request.id,
            "registration replay",
        );
        return current;
    }

    async #replayUpdate(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        receipt: SecretOperationReceipt,
        secretId: SecretId,
    ): Promise<SecretReference | undefined> {
        this.#assertReceiptIdentity(receipt, actingAgentId, operation);
        if (
            receipt.result.operation !== "update" ||
            receipt.result.secretId !== secretId ||
            (receipt.result.reference !== undefined && receipt.result.reference.id !== secretId)
        ) {
            throw new Error("Secret update receipt has a different identity.");
        }
        const current = await this.reference(ctx, actingAgentId, secretId);
        return current;
    }

    async #replayRemove(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        receipt: SecretOperationReceipt,
        secretId: SecretId,
    ): Promise<boolean> {
        this.#assertReceiptIdentity(receipt, actingAgentId, operation);
        if (
            receipt.result.operation !== "remove" ||
            receipt.result.secretId !== secretId ||
            (receipt.result.reference !== undefined && receipt.result.reference.id !== secretId)
        ) {
            throw new Error("Secret remove receipt has a different identity.");
        }
        const proof = await this.#readMutationProof(ctx, actingAgentId, operation);
        if (proof === undefined) {
            throw new Error("Secret remove replay has no immutable mutation proof.");
        }
        if (proof.operation !== "remove") {
            throw new Error("Secret remove replay has the wrong immutable proof.");
        }
        if (
            receipt.result.removed !== proof.removed ||
            (proof.before === null
                ? receipt.result.reference !== undefined
                : receipt.result.reference === undefined ||
                  !sameReference(receipt.result.reference, proof.before))
        ) {
            throw new Error("Secret remove receipt does not match its immutable mutation proof.");
        }
        return this.#replayRemoveProof(actingAgentId, operation, proof, secretId);
    }

    async #replayRemoveProof(
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        proof: SecretMutationProof,
        secretId: SecretId,
    ): Promise<boolean> {
        this.#assertMutationProofIdentity(proof, actingAgentId, operation);
        if (
            proof.operation !== "remove" ||
            proof.secretId !== secretId ||
            proof.removed !== (proof.before !== null) ||
            (proof.before !== null && proof.before.id !== secretId)
        ) {
            throw new Error("Secret remove immutable mutation proof is not authoritative.");
        }
        return proof.removed;
    }

    async #replayAttach(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        receipt: SecretOperationReceipt,
        input: SecretAttachInput,
    ): Promise<SecretAttachReferenceResult> {
        this.#assertReceiptIdentity(receipt, actingAgentId, operation);
        if (
            receipt.result.operation !== "attach" ||
            receipt.result.attachment.scopeRef !== input.scopeRef ||
            receipt.result.attachment.secretId !== input.secretId ||
            receipt.result.reference === undefined
        ) {
            throw new Error("Secret attach receipt has a different identity.");
        }
        const proof = await this.#readMutationProof(ctx, actingAgentId, operation);
        if (proof === undefined) {
            throw new Error("Secret attach replay has no immutable mutation proof.");
        }
        if (proof.operation !== "attach") {
            throw new Error("Secret attach replay has the wrong immutable proof.");
        }
        if (
            proof.scopeRef !== input.scopeRef ||
            proof.secretId !== input.secretId ||
            proof.changed !== receipt.result.changed ||
            !sameJson(proof.attachment, receipt.result.attachment) ||
            !sameReference(proof.reference, receipt.result.reference) ||
            proof.reference.id !== input.secretId
        ) {
            throw new Error("Secret attach receipt does not match its immutable mutation proof.");
        }
        const result: SecretAttachReferenceResult = {
            attachment: structuredClone(proof.attachment),
            secret: structuredClone(proof.reference),
        };
        if (!Value.Check(secretAttachReferenceResultSchema, result)) {
            throw new Error("Secret attach receipt has an invalid safe reference snapshot.");
        }
        return result;
    }

    async #replayDetach(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        receipt: SecretOperationReceipt,
        input: SecretAttachInput,
    ): Promise<boolean> {
        this.#assertReceiptIdentity(receipt, actingAgentId, operation);
        if (
            receipt.result.operation !== "detach" ||
            (receipt.result.attachment !== undefined &&
                (receipt.result.attachment.scopeRef !== input.scopeRef ||
                    receipt.result.attachment.secretId !== input.secretId))
        ) {
            throw new Error("Secret detach receipt has the wrong operation.");
        }
        const proof = await this.#readMutationProof(ctx, actingAgentId, operation);
        if (proof === undefined) {
            throw new Error("Secret detach replay has no immutable mutation proof.");
        }
        if (proof.operation !== "detach") {
            throw new Error("Secret detach replay has the wrong immutable proof.");
        }
        if (
            receipt.result.detached !== proof.detached ||
            (proof.before === null
                ? receipt.result.attachment !== undefined
                : receipt.result.attachment === undefined ||
                  !sameJson(receipt.result.attachment, proof.before))
        ) {
            throw new Error("Secret detach receipt does not match its immutable mutation proof.");
        }
        return this.#replayDetachProof(actingAgentId, operation, proof, input);
    }

    async #replayDetachProof(
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        proof: SecretMutationProof,
        input: SecretAttachInput,
    ): Promise<boolean> {
        this.#assertMutationProofIdentity(proof, actingAgentId, operation);
        if (
            proof.operation !== "detach" ||
            proof.scopeRef !== input.scopeRef ||
            proof.secretId !== input.secretId ||
            proof.detached !== (proof.before !== null) ||
            (proof.before !== null && !sameJson(proof.before, input))
        ) {
            throw new Error("Secret detach immutable mutation proof is not authoritative.");
        }
        return proof.detached;
    }

    async #requiredReference(
        ctx: Context,
        actingAgentId: SecretAgentId,
        secretId: SecretId,
        operation: string,
    ): Promise<SecretReference> {
        const current = await this.reference(ctx, actingAgentId, secretId);
        if (current === undefined) {
            throw new Error(`Secret store ${operation} has no authoritative reference.`);
        }
        return current;
    }

    async #attachment(
        ctx: Context,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
    ): Promise<SecretAttachment | undefined> {
        const value = await this.#store.attachment(ctx, actingAgentId, input);
        if (value === undefined) return undefined;
        assertSecretAttachment(value);
        if (value.scopeRef !== input.scopeRef || value.secretId !== input.secretId) {
            throw new Error("Secret store returned a different attachment identity.");
        }
        return structuredClone(value);
    }

    async #requiredAttachment(
        ctx: Context,
        actingAgentId: SecretAgentId,
        input: SecretAttachInput,
        operation: string,
    ): Promise<SecretAttachment> {
        const value = await this.#attachment(ctx, actingAgentId, input);
        if (value === undefined) {
            throw new Error(`Secret store ${operation} has no authoritative attachment.`);
        }
        return value;
    }

    async #authorizeOperation(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: Static<typeof secretAuthorizationOperationSchema>,
        scopeRef?: SecretScopeRef,
    ): Promise<void> {
        if (this.#authorize === undefined) return;
        const allowed = await this.#authorize(ctx, actingAgentId, operation, scopeRef);
        if (typeof allowed !== "boolean") {
            throw new Error("Secret authorization returned an invalid result.");
        }
        if (!allowed) throw new Error("The acting agent is not authorized for this secret scope.");
    }

    async #registrationId(
        ctx: Context,
        actingAgentId: SecretAgentId,
        requested: string | undefined,
        requestFingerprint: SecretOperationFingerprint,
    ): Promise<SecretId> {
        if (requested !== undefined) {
            this.#assertSecretId(requested);
            return requested;
        }
        return await this.#durableIdentity(
            ctx,
            actingAgentId,
            `${REGISTER_ID_KEY}:${requestFingerprint}`,
            () => this.#newIdentity(ctx, actingAgentId, "id"),
            secretIdSchema,
            "Secret registration",
            requestFingerprint,
        );
    }

    async #operation(
        ctx: Context,
        actingAgentId: SecretAgentId,
        kind: SecretMutationOperation,
        key: string,
        requested: SecretOperationId | undefined,
        request: unknown,
    ): Promise<SecretOperation> {
        const requestFingerprint = fingerprint({ kind, actingAgentId, request });
        const operationId = await this.#durableIdentity(
            ctx,
            actingAgentId,
            `operation:${key}:${requestFingerprint}`,
            () => this.#newIdentity(ctx, actingAgentId, "operation"),
            secretOperationIdSchema,
            "Secret operation",
            requestFingerprint,
            requested,
        );
        return {
            kind,
            operationId,
            fingerprint: requestFingerprint,
        };
    }

    async #eventId(
        ctx: Context,
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
    ): Promise<string> {
        return await this.#durableIdentity(
            ctx,
            actingAgentId,
            `event:${operation.kind}:${operation.operationId}`,
            () => this.#newEventId(ctx, actingAgentId),
            secretEventIdSchema,
            "Secret event",
            operation.fingerprint,
        );
    }

    async #durableIdentity<T>(
        ctx: Context,
        _actingAgentId: SecretAgentId,
        key: string,
        factory: () => T | Promise<T>,
        schema: TSchema,
        label: string,
        requestFingerprint: SecretOperationFingerprint,
        requested?: string,
    ): Promise<T> {
        if (requested !== undefined) {
            if (!Value.Check(schema, requested)) throw new Error(`${label} identity is invalid.`);
            return requested as T;
        }
        const kv = agentKV(ctx);
        if (kv === undefined) return await factory();
        const next = await kv.update(ctx, key, async (current) => {
            if (current !== undefined) {
                if (!Value.Check(secretOperationStateSchema, current)) {
                    throw new Error(`${label} identity is invalid in durable call state.`);
                }
                if (current.fingerprint !== requestFingerprint) {
                    throw new Error(`${label} identity was reused with different input.`);
                }
                if (!Value.Check(schema, current.id)) {
                    throw new Error(`${label} identity is invalid in durable call state.`);
                }
                return current;
            }
            const value = await factory();
            if (!Value.Check(schema, value)) throw new Error(`${label} identity is invalid.`);
            const state: SecretOperationState = {
                id: String(value),
                fingerprint: requestFingerprint,
            };
            if (!Value.Check(secretOperationStateSchema, state)) {
                throw new Error(`${label} durable identity is invalid.`);
            }
            return state;
        });
        if (!Value.Check(secretOperationStateSchema, next)) {
            throw new Error(`${label} durable identity is invalid.`);
        }
        return next.id as T;
    }

    async #newIdentity(
        ctx: Context,
        actingAgentId: SecretAgentId,
        kind: "id" | "operation",
    ): Promise<string> {
        const factory = kind === "id" ? this.#idFactory : this.#mutationIdFactory;
        const value = await factory(ctx, actingAgentId);
        if (!Value.Check(kind === "id" ? secretIdSchema : secretOperationIdSchema, value)) {
            throw new Error(`Secret ${kind} factory returned an invalid identity.`);
        }
        return value;
    }

    async #newEventId(ctx: Context, actingAgentId: SecretAgentId): Promise<string> {
        const value = await this.#eventIdFactory(ctx, actingAgentId);
        if (!Value.Check(secretEventIdSchema, value)) {
            throw new Error("Secret event ID factory returned an invalid ID.");
        }
        return value;
    }

    #event(
        payload:
            | {
                  readonly type: "secret_registered" | "secret_updated";
                  readonly secret: SecretReference;
              }
            | { readonly type: "secret_removed"; readonly secretId: SecretId }
            | {
                  readonly type: "secret_attached";
                  readonly attachment: SecretAttachment;
              }
            | {
                  readonly type: "secret_detached";
                  readonly scopeRef: SecretScopeRef;
                  readonly secretId: SecretId;
              },
        actingAgentId: SecretAgentId,
        operation: SecretOperation,
        eventId: string,
        at: number,
    ): SecretEvent {
        const event = {
            ...payload,
            eventId,
            at,
            agentId: actingAgentId,
            operationId: operation.operationId,
            fingerprint: operation.fingerprint,
        };
        if (!Value.Check(secretEventSchema, event)) {
            throw new Error("Secrets feature created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    #normalizeRegistration(
        input: SecretRegistrationInput & { readonly id: SecretId },
    ): SecretRegistration {
        const registration = {
            id: input.id,
            description: normalizeText(input.description),
            environment: normalizeEnvironment(input.environment),
        };
        if (!Value.Check(secretRegistrationSchema, registration)) {
            throw new Error("Secret registration is invalid.");
        }
        return registration;
    }

    #normalizePage(value: SecretPage): SecretPage {
        assertSecretPage(value);
        if (value.limit > this.#maxPageSize || value.secrets.length > value.limit) {
            throw new Error("Secret page exceeds the configured metadata bound.");
        }
        const ids = new Set<string>();
        const secrets = value.secrets.map((secret) => {
            const normalized = this.#normalizeReference(secret);
            if (ids.has(normalized.id)) throw new Error("Secret page contains duplicate IDs.");
            ids.add(normalized.id);
            return normalized;
        });
        return {
            secrets,
            limit: value.limit,
            ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
        };
    }

    #normalizeReference(value: SecretReference): SecretReference {
        assertSecretReference(value);
        const names = [...value.environmentVariables];
        const normalizedNames = new Set<string>();
        for (const name of names) {
            const normalized = name.toUpperCase();
            if (normalizedNames.has(normalized)) {
                throw new Error("Secret metadata contains duplicate environment variable names.");
            }
            normalizedNames.add(normalized);
        }
        return {
            id: value.id,
            description: value.description,
            environmentVariables: names.sort((left, right) => left.localeCompare(right)),
            revision: value.revision,
            ...(value.availableToModel === undefined
                ? {}
                : { availableToModel: value.availableToModel }),
            ...(value.kind === undefined ? {} : { kind: value.kind }),
        };
    }

    #formatReference(secret: SecretReference): string {
        return [
            `${JSON.stringify(secret.id)}: ${secret.description}`,
            `  Environment variables: ${
                secret.environmentVariables.length === 0
                    ? "none"
                    : secret.environmentVariables.join(", ")
            }`,
            `  Revision: ${JSON.stringify(secret.revision)}`,
            ...(secret.availableToModel === false ? ["  Availability: host only"] : []),
        ].join("\n");
    }

    #listQuery(query: SecretListInput): SecretListQuery {
        const normalized = {
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.scopeRef === undefined ? {} : { scopeRef: query.scopeRef }),
            limit: query.limit ?? this.#maxPageSize,
        };
        if (!Value.Check(secretListQuerySchema, normalized)) {
            throw new Error("Secret list query is invalid.");
        }
        if (normalized.limit > this.#maxPageSize) {
            throw new Error(`Secret page limit cannot exceed ${this.#maxPageSize}.`);
        }
        return normalized;
    }

    #attachArguments(
        scopeOrInput: string | SecretAttachInput,
        secretIdOrOptions: string | SecretMutationOptions | undefined,
        maybeOptions: SecretMutationOptions,
    ): { readonly input: SecretAttachInput; readonly options: SecretMutationOptions } {
        if (typeof scopeOrInput === "string") {
            if (typeof secretIdOrOptions !== "string") {
                throw new Error("Secret attachment input is invalid.");
            }
            const input = { scopeRef: scopeOrInput, secretId: secretIdOrOptions };
            if (!Value.Check(secretAttachInputSchema, input)) {
                throw new Error("Secret attachment input is invalid.");
            }
            return { input, options: maybeOptions };
        }
        if (!Value.Check(secretAttachInputSchema, scopeOrInput)) {
            throw new Error("Secret attachment input is invalid.");
        }
        if (
            secretIdOrOptions !== undefined &&
            (typeof secretIdOrOptions !== "object" || secretIdOrOptions === null)
        ) {
            throw new Error("Secret mutation options are invalid.");
        }
        if (maybeOptions !== undefined && !Value.Check(secretMutationOptionsSchema, maybeOptions)) {
            throw new Error("Secret mutation options are invalid.");
        }
        const options = secretIdOrOptions === undefined ? maybeOptions : secretIdOrOptions;
        return {
            input: { scopeRef: scopeOrInput.scopeRef, secretId: scopeOrInput.secretId },
            options,
        };
    }

    #assertOptions(value: unknown): asserts value is SecretMutationOptions {
        if (!Value.Check(secretMutationOptionsSchema, value)) {
            throw new Error("Secret mutation options are invalid.");
        }
    }

    #assertContext(value: unknown): asserts value is Context {
        if (!Value.Check(secretContextSchema, value)) {
            throw new Error("Secret context is invalid.");
        }
    }

    #assertAgentId(value: unknown): asserts value is SecretAgentId {
        if (!Value.Check(secretAgentIdSchema, value)) {
            throw new Error("Secret acting agent ID is invalid.");
        }
    }

    #assertSecretId(value: unknown): asserts value is SecretId {
        if (!Value.Check(secretIdSchema, value)) {
            throw new Error("Secret ID is invalid.");
        }
    }

    #assertScopeRef(value: unknown): asserts value is SecretScopeRef {
        if (!Value.Check(secretScopeRefSchema, value)) {
            throw new Error("Secret scope reference is invalid.");
        }
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) {
            throw new Error(`Secret ${label} input is invalid.`);
        }
    }

    #now(): number {
        const at = this.#clock();
        if (!Value.Check(secretEventTimestampSchema, at)) {
            throw new Error("Secret clock must return a non-negative integer timestamp.");
        }
        return at;
    }
}

/** Validate every nested injected callable and reject unknown option keys. */
export function assertSecretsFeatureOptions(
    value: unknown,
): asserts value is SecretsFeatureOptions {
    if (!Value.Check(secretFeatureOptionsSchema, value)) {
        throw new Error(
            "Secrets feature options are invalid; check the closed store, listener, and callbacks.",
        );
    }
}

function normalizeRegistrationInput(input: SecretRegistrationInput): SecretRegistrationInput {
    const normalized = {
        ...(input.id === undefined ? {} : { id: input.id }),
        description: normalizeText(input.description),
        environment: normalizeEnvironment(input.environment),
    };
    if (!Value.Check(secretRegistrationInputSchema, normalized)) {
        throw new Error("Secret registration input is invalid after normalization.");
    }
    return normalized;
}

function withoutRegistrationId(
    input: SecretRegistration | SecretRegistrationInput,
): Omit<SecretRegistration | SecretRegistrationInput, "id"> {
    const { id: _id, ...withoutId } = input;
    return withoutId;
}

function normalizeUpdateInput(input: SecretUpdateInput): SecretUpdateInput {
    const normalized = {
        ...(input.description === undefined
            ? {}
            : { description: normalizeText(input.description) }),
        ...(input.environment === undefined
            ? {}
            : { environment: normalizeEnvironmentPatch(input.environment) }),
    };
    if (!Value.Check(secretUpdateInputSchema, normalized)) {
        throw new Error("Secret update input is invalid after normalization.");
    }
    return normalized;
}

function normalizeEnvironment(
    environment: SecretRegistration["environment"],
): SecretRegistration["environment"] {
    const result = Object.create(null) as Record<string, string>;
    const names = new Set<string>();
    for (const [name, value] of Object.entries(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secret registration contains duplicate environment variable names.");
        }
        names.add(normalized);
        Object.defineProperty(result, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return result;
}

function normalizeEnvironmentPatch(
    environment: NonNullable<SecretUpdateInput["environment"]>,
): NonNullable<SecretUpdateInput["environment"]> {
    const result = Object.create(null) as Record<string, string | null>;
    const names = new Set<string>();
    for (const [name, value] of Object.entries(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secret update contains duplicate environment variable names.");
        }
        names.add(normalized);
        Object.defineProperty(result, name, {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
        });
    }
    return result;
}

function normalizeText(value: string): string {
    const normalized = value.trim();
    if (!Value.Check(Type.String({ minLength: 1, maxLength: 2_000 }), normalized)) {
        throw new Error("Secret description is invalid after normalization.");
    }
    return normalized;
}

function sameReference(left: SecretReference, right: SecretReference): boolean {
    return (
        left.id === right.id &&
        left.description === right.description &&
        sameStrings(left.environmentVariables, right.environmentVariables) &&
        left.revision === right.revision &&
        left.availableToModel === right.availableToModel &&
        left.kind === right.kind
    );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameEnvironmentNames(
    referenceNames: readonly string[],
    environment: Record<string, string>,
): boolean {
    return sameStrings(referenceNames, sortEnvironmentNames(Object.keys(environment)));
}

function applyEnvironmentPatch(
    before: readonly string[],
    patch: SecretUpdateInput["environment"],
): readonly string[] {
    const names = new Set(before);
    if (patch !== undefined) {
        for (const [name, value] of Object.entries(patch)) {
            if (value === null) names.delete(name);
            else names.add(name);
        }
    }
    return sortEnvironmentNames([...names]);
}

function sortEnvironmentNames(names: readonly string[]): string[] {
    return [...names].sort((left, right) => left.localeCompare(right));
}

function sameJson(left: unknown, right: unknown): boolean {
    return JSON.stringify(canonicalize(left, 0)) === JSON.stringify(canonicalize(right, 0));
}

function fingerprint(value: unknown): SecretOperationFingerprint {
    const encoded = JSON.stringify(canonicalize(value, 0));
    if (encoded === undefined) {
        throw new Error("Secret operation fingerprint input is not JSON encodable.");
    }
    if (new TextEncoder().encode(encoded).byteLength > MAX_FINGERPRINT_INPUT_BYTES) {
        throw new Error("Secret operation fingerprint input exceeds its encoded byte bound.");
    }
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < encoded.length; index += 1) {
        hash ^= BigInt(encoded.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    const result = `v1-${hash.toString(16).padStart(16, "0")}`;
    if (!Value.Check(secretOperationFingerprintSchema, result)) {
        throw new Error("Secret operation fingerprint exceeded its durable bound.");
    }
    return result;
}

function canonicalize(value: unknown, depth: number): unknown {
    if (depth > MAX_FINGERPRINT_INPUT_DEPTH) {
        throw new Error("Secret operation fingerprint input exceeds its nesting depth bound.");
    }
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item, depth + 1));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, canonicalize(item, depth + 1)]),
        );
    }
    return value;
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function isDeepFrozen(value: unknown): boolean {
    if (value !== null && typeof value === "object") {
        if (!Object.isFrozen(value)) return false;
        return Object.values(value as Record<string, unknown>).every(isDeepFrozen);
    }
    return true;
}

function cursorProgressed(
    requested: number | undefined,
    next: number,
    visibleCount: number,
): boolean {
    const current = requested ?? 0;
    const expected = current + visibleCount;
    return Number.isSafeInteger(expected) && next === expected;
}
