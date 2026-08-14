import {
    agentConfigSchema,
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AgentMetadataChange,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { deterministicStringify, type Context } from "@steve.kite/stdlib";

import {
    COLLABORATION_MAX_TIMESTAMP,
    COLLABORATION_METADATA_MAX_DEPTH,
    COLLABORATION_METADATA_MAX_ENCODED_BYTES,
    collaborationAgentIdSchema,
    collaborationAgentPageQuerySchema,
    collaborationAgentSchema,
    collaborationCreateInputSchema,
    collaborationFingerprintSchema,
    collaborationMetadataSchema,
    collaborationOperationIdSchema,
    type CollaborationAgent,
    type CollaborationAgentPage,
    type CollaborationAgentPageQuery,
    type CollaborationCreateInput,
    type CollaborationMetadata,
} from "./CollaborationAgent.js";
import {
    collaborationEventIdSchema,
    collaborationEventSchema,
    collaborationFeatureListenerSchema,
    type CollaborationEvent,
    type CollaborationFeatureListener,
} from "./CollaborationEvent.js";
import {
    collaborationMessageIdSchema,
    collaborationMessageSchema,
    collaborationObligationIdSchema,
    collaborationObligationPageQuerySchema,
    collaborationObligationSchema,
    collaborationReplyInputSchema,
    collaborationScheduleIdSchema,
    collaborationScheduleInputSchema,
    collaborationScheduleSchema,
    collaborationSendInputSchema,
    collaborationSendResultSchema,
    collaborationWaitInputSchema,
    type CollaborationMessage,
    type CollaborationObligation,
    type CollaborationObligationPage,
    type CollaborationObligationPageQuery,
    type CollaborationReplyInput,
    type CollaborationSchedule,
    type CollaborationScheduleInput,
    type CollaborationSendInput,
    type CollaborationSendResult,
    type CollaborationWaitInput,
} from "./CollaborationMessage.js";
import {
    assertCollaborationAgentPage,
    assertCollaborationBrokerAgentResult,
    assertCollaborationMutationReceipt,
    assertCollaborationObligationPage,
    assertCollaborationSchedule,
    assertCollaborationTransactionChange,
    assertCollaborationVoidResult,
    collaborationAuthorizationSchema,
    collaborationBrokerSchema,
    collaborationBrokerSendOptionsSchema,
    collaborationContextSchema,
    collaborationMutationResultSchema,
    collaborationRosterSchema,
    collaborationStoreSchema,
    type CollaborationAuthorization,
    type CollaborationBroker,
    type CollaborationMutationKind,
    type CollaborationMutationReceipt,
    type CollaborationRoster,
    type CollaborationStore,
    type CollaborationTransactionChange,
} from "./CollaborationStore.js";
import { createAgentTool } from "./tools/create_agent.js";
import { listAgentsTool } from "./tools/list_agents.js";
import { replyToMessageTool } from "./tools/reply_to_message.js";
import { scheduleMessageTool } from "./tools/schedule_message.js";
import { sendMessageTool } from "./tools/send_message.js";
import { waitForReplyTool } from "./tools/wait_for_reply.js";

const asyncVoidResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
const operationReceiptSchema = Type.Object(
    {
        operationId: collaborationOperationIdSchema,
        fingerprint: Type.String({ maxLength: 65_536 }),
    },
    { additionalProperties: false },
);
const operationFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationOperationIdSchema, Type.Promise(collaborationOperationIdSchema)]),
);
const idFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationAgentIdSchema, Type.Promise(collaborationAgentIdSchema)]),
);
const messageIdFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationMessageIdSchema, Type.Promise(collaborationMessageIdSchema)]),
);
const obligationIdFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationObligationIdSchema, Type.Promise(collaborationObligationIdSchema)]),
);
const scheduleIdFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationScheduleIdSchema, Type.Promise(collaborationScheduleIdSchema)]),
);
const eventFactorySchema = Type.Function(
    [collaborationContextSchema, collaborationAgentIdSchema],
    Type.Union([collaborationEventIdSchema, Type.Promise(collaborationEventIdSchema)]),
);

const collaborationFeatureOptionsSchema = Type.Object(
    {
        roster: collaborationRosterSchema,
        store: collaborationStoreSchema,
        broker: collaborationBrokerSchema,
        authorization: Type.Optional(collaborationAuthorizationSchema),
        idFactory: Type.Optional(idFactorySchema),
        operationIdFactory: Type.Optional(operationFactorySchema),
        messageIdFactory: Type.Optional(messageIdFactorySchema),
        obligationIdFactory: Type.Optional(obligationIdFactorySchema),
        scheduleIdFactory: Type.Optional(scheduleIdFactorySchema),
        eventIdFactory: Type.Optional(eventFactorySchema),
        clock: Type.Optional(
            Type.Function([], Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP })),
        ),
        listener: Type.Optional(collaborationFeatureListenerSchema),
        onPostCommitError: Type.Optional(
            Type.Function(
                [collaborationContextSchema, collaborationEventSchema, Type.Unknown()],
                asyncVoidResultSchema,
            ),
        ),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        maxOutputCharacters: Type.Optional(Type.Integer({ minimum: 256, maximum: 50_000 })),
    },
    { additionalProperties: false },
);

export { collaborationFeatureOptionsSchema };
export type CollaborationFeatureOptions = Static<typeof collaborationFeatureOptionsSchema>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_OUTPUT_CHARACTERS = 8_000;
const CREATE_OPERATION = "create";
const SEND_OPERATION = "send";
const REPLY_OPERATION = "reply";
const WAIT_OPERATION = "wait";
const SCHEDULE_OPERATION = "schedule";

/**
 * Collaboration is a host capability, not an agent manager. The roster, message store, broker,
 * transaction, timers, queues, and receipt retention all belong to the host.
 */
export class CollaborationFeature implements AgentFeature {
    readonly name = "collaboration";

    readonly #roster: CollaborationRoster;
    readonly #store: CollaborationStore;
    readonly #broker: CollaborationBroker;
    readonly #authorization: CollaborationAuthorization | undefined;
    readonly #listener: CollaborationFeatureListener | undefined;
    readonly #idFactory: NonNullable<CollaborationFeatureOptions["idFactory"]>;
    readonly #operationIdFactory: NonNullable<CollaborationFeatureOptions["operationIdFactory"]>;
    readonly #messageIdFactory: NonNullable<CollaborationFeatureOptions["messageIdFactory"]>;
    readonly #obligationIdFactory: NonNullable<CollaborationFeatureOptions["obligationIdFactory"]>;
    readonly #scheduleIdFactory: NonNullable<CollaborationFeatureOptions["scheduleIdFactory"]>;
    readonly #eventIdFactory: NonNullable<CollaborationFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<CollaborationFeatureOptions["clock"]>;
    readonly #maxPageSize: number;
    readonly #maxOutputCharacters: number;
    readonly #onPostCommitError: CollaborationFeatureOptions["onPostCommitError"];

    constructor(options: CollaborationFeatureOptions) {
        const validated = validateOptions(options);
        this.#roster = validated.roster;
        this.#store = validated.store;
        this.#broker = validated.broker;
        this.#authorization = validated.authorization;
        this.#listener = validated.listener;
        this.#idFactory = validated.idFactory ?? ((_ctx, _acting) => generatedId("a"));
        this.#operationIdFactory =
            validated.operationIdFactory ?? ((_ctx, _acting) => generatedId("op"));
        this.#messageIdFactory =
            validated.messageIdFactory ?? ((_ctx, _acting) => generatedId("m"));
        this.#obligationIdFactory =
            validated.obligationIdFactory ?? ((_ctx, _acting) => generatedId("o"));
        this.#scheduleIdFactory =
            validated.scheduleIdFactory ?? ((_ctx, _acting) => generatedId("s"));
        this.#eventIdFactory = validated.eventIdFactory ?? ((_ctx, _acting) => generatedId("e"));
        this.#clock = validated.clock ?? (() => Date.now());
        this.#maxPageSize = validated.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxOutputCharacters = validated.maxOutputCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
        this.#onPostCommitError = validated.onPostCommitError;
        this.#assertValue(
            Type.Integer({ minimum: 0, maximum: COLLABORATION_MAX_TIMESTAMP }),
            this.#clock(),
            "clock value",
        );
    }

    /**
     * Create a collaborator and its Agent Base identity atomically. The acting agent owns the
     * resulting roster row; a missing actor is accepted only for a self-owned bootstrap root.
     */
    async createAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationCreateInput,
    ): Promise<CollaborationAgent> {
        this.#assertAgentId(actingAgentId, "acting agent");
        if (input !== null && typeof input === "object") {
            const rawInput = input as { readonly metadata?: unknown; readonly config?: unknown };
            if (rawInput.metadata !== undefined) assertBoundedMetadata(rawInput.metadata);
            if (isRecord(rawInput.config) && rawInput.config.metadata !== undefined) {
                assertBoundedMetadata(rawInput.config.metadata);
            }
        }
        this.#assertInput(collaborationCreateInputSchema, input, "create agent");
        const normalizedInput = normalizeCreateInput(input, this.#assertMetadata.bind(this));
        const operationId = await this.#operationId(
            ctx,
            actingAgentId,
            CREATE_OPERATION,
            input.operationId ?? input.id,
        );
        const id =
            input.id ??
            (await this.#callScopedId(
                ctx,
                actingAgentId,
                "create.agentId",
                this.#idFactory,
                collaborationAgentIdSchema,
                "agent",
            ));
        const fingerprint = this.#fingerprint(CREATE_OPERATION, actingAgentId, {
            ...normalizedInput,
            id,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, actingAgentId, CREATE_OPERATION, fingerprint);

        const change = await this.#commit(
            ctx,
            actingAgentId,
            CREATE_OPERATION,
            operationId,
            fingerprint,
            async (txCtx) => {
                const actor = await this.#readAgent(txCtx, actingAgentId);
                const receipt = await this.#readReceipt(
                    txCtx,
                    actingAgentId,
                    CREATE_OPERATION,
                    operationId,
                    fingerprint,
                );
                if (receipt !== undefined) {
                    const result = await this.#replayCreatedAgent(
                        txCtx,
                        actingAgentId,
                        receipt,
                        input,
                        id,
                    );
                    return this.#change(
                        CREATE_OPERATION,
                        actingAgentId,
                        operationId,
                        result,
                        false,
                        [],
                    );
                }

                const parentId =
                    input.parentId === undefined
                        ? actor === undefined
                            ? null
                            : actingAgentId
                        : input.parentId;
                if (actor === undefined) {
                    if (id !== actingAgentId || parentId !== null) {
                        throw new Error(
                            "A missing acting agent may create only its own root collaborator.",
                        );
                    }
                } else if (parentId === null) {
                    throw new Error("An existing agent may create only an owned child.");
                } else {
                    const parent = await this.#readRequiredAgent(txCtx, parentId);
                    await this.#authorize(txCtx, actingAgentId, parent, "create");
                }

                const metadata = mergedMetadata(input.config.metadata, input.metadata);
                const config = {
                    ...input.config,
                    ...(metadata === undefined ? {} : { metadata }),
                };
                this.#assertValue(agentConfigSchema, config, "Agent Base configuration");
                const expectedConfig = structuredClone(config);

                const existing = await this.#readAgent(txCtx, id);
                if (existing !== undefined) {
                    await this.#assertExistingCreation(
                        txCtx,
                        actingAgentId,
                        existing,
                        input,
                        id,
                        parentId,
                        metadata,
                        config,
                    );
                    await this.#writeReceipt(txCtx, {
                        kind: CREATE_OPERATION,
                        operationId,
                        actingAgentId,
                        fingerprint,
                        result: existing,
                    });
                    return this.#change(
                        CREATE_OPERATION,
                        actingAgentId,
                        operationId,
                        existing,
                        false,
                        [],
                    );
                }

                const createdRaw: unknown = this.#broker.create(
                    txCtx,
                    structuredClone(expectedConfig),
                    {
                        id,
                        parent: parentId,
                    },
                );
                const created = await requirePromise(createdRaw, "Collaboration broker create");
                assertCollaborationBrokerAgentResult(created);
                if (created.id !== id) {
                    throw new Error("Agent Base did not preserve the requested collaborator ID.");
                }
                await this.#assertBrokerConfig(txCtx, id, expectedConfig);

                const at = this.#now();
                const roster: CollaborationAgent = {
                    id,
                    ownerAgentId: actingAgentId,
                    parentId,
                    ...(input.role === undefined ? {} : { role: input.role }),
                    ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
                    ...(input.title === undefined ? {} : { title: input.title }),
                    ...(metadata === undefined ? {} : { metadata }),
                    status: "idle",
                    createdAt: at,
                    updatedAt: at,
                };
                this.#assertAgent(roster);
                await this.#writeAgent(txCtx, roster);
                const persisted = await this.#readRequiredAgent(txCtx, id);
                if (!sameValue(persisted, roster)) {
                    throw new Error("Collaboration roster substituted the created agent.");
                }
                const event = await this.#event(txCtx, {
                    type: "agent_created",
                    actingAgentId,
                    agent: roster,
                });
                await this.#announce(txCtx, event);
                await this.#writeReceipt(txCtx, {
                    kind: CREATE_OPERATION,
                    operationId,
                    actingAgentId,
                    fingerprint,
                    result: roster,
                });
                return this.#change(CREATE_OPERATION, actingAgentId, operationId, roster, true, [
                    event,
                ]);
            },
        );
        this.#assertAgent(change.result);
        return structuredClone(change.result);
    }

    async getAgent(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<CollaborationAgent | undefined> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertAgentId(targetAgentId, "target agent");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const target = await this.#readAgent(ctx, targetAgentId);
        if (target === undefined) return undefined;
        await this.#validateAgentReferences(ctx, target);
        await this.#authorize(ctx, actingAgentId, target, "read");
        return structuredClone(target);
    }

    async listAgents(
        ctx: Context,
        actingAgentId: string,
        query: CollaborationAgentPageQuery = {},
    ): Promise<CollaborationAgentPage> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertInput(collaborationAgentPageQuerySchema, query, "agent page query");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const normalized = {
            limit: query.limit ?? this.#maxPageSize,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.groupId === undefined ? {} : { groupId: query.groupId }),
            ...(query.ownerAgentId === undefined ? {} : { ownerAgentId: query.ownerAgentId }),
        };
        this.#assertPageLimit(normalized.limit, "agent");
        let requestedLimit = normalized.limit;
        for (let attempt = 0; attempt <= normalized.limit; attempt += 1) {
            const pageRaw: unknown = this.#roster.listAgents(ctx, actingAgentId, {
                ...normalized,
                limit: requestedLimit,
            });
            const page = await requirePromise(pageRaw, "Collaboration roster listAgents");
            assertCollaborationAgentPage(page);
            this.#assertReturnedPage(page.limit, page.agents.length, requestedLimit, "agents");
            this.#assertCursorProgress(page.nextCursor, query.cursor, page.agents.length, "agents");
            this.#assertAgentPageInvariants(page);
            for (const agent of page.agents) {
                await this.#validateAgentReferences(ctx, agent);
                await this.#authorize(ctx, actingAgentId, agent, "list");
            }
            const fitting = this.#fittingAgentCount(page);
            if (fitting === page.agents.length) {
                this.formatAgentPageForModel(page);
                return structuredClone(page);
            }
            if (fitting < 1) {
                throw new Error(
                    "Collaboration roster output budget cannot fit one complete agent identity and cursor.",
                );
            }
            requestedLimit = fitting;
        }
        throw new Error("Collaboration roster could not make output-aware page progress.");
    }

    async sendMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationSendInput,
    ): Promise<CollaborationSendResult> {
        this.#assertAgentId(actingAgentId, "acting agent");
        if (input !== null && typeof input === "object" && "metadata" in input) {
            assertBoundedMetadata(input.metadata);
        }
        this.#assertInput(collaborationSendInputSchema, input, "send message");
        if ("replyTo" in input) {
            throw new Error("Use replyMessage for a directed reply.");
        }
        return await this.#send(ctx, actingAgentId, input, SEND_OPERATION);
    }

    async replyMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationReplyInput,
    ): Promise<CollaborationSendResult> {
        this.#assertAgentId(actingAgentId, "acting agent");
        if (input !== null && typeof input === "object" && "metadata" in input) {
            assertBoundedMetadata(input.metadata);
        }
        this.#assertInput(collaborationReplyInputSchema, input, "reply message");
        return await this.#send(ctx, actingAgentId, input, REPLY_OPERATION);
    }

    /** Alias kept descriptive for host callers. */
    async reply(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationReplyInput,
    ): Promise<CollaborationSendResult> {
        return await this.replyMessage(ctx, actingAgentId, input);
    }

    async listObligations(
        ctx: Context,
        actingAgentId: string,
        query: CollaborationObligationPageQuery = {},
    ): Promise<CollaborationObligationPage> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertInput(collaborationObligationPageQuerySchema, query, "obligation page query");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const normalized = {
            limit: query.limit ?? this.#maxPageSize,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.requesterAgentId === undefined
                ? {}
                : { requesterAgentId: query.requesterAgentId }),
            ...(query.responderAgentId === undefined
                ? {}
                : { responderAgentId: query.responderAgentId }),
        };
        this.#assertPageLimit(normalized.limit, "obligation");
        const pageRaw: unknown = this.#store.listObligations(ctx, actingAgentId, normalized);
        const page = await requirePromise(pageRaw, "Collaboration store listObligations");
        assertCollaborationObligationPage(page);
        this.#assertReturnedPage(
            page.limit,
            page.obligations.length,
            normalized.limit,
            "obligations",
        );
        this.#assertCursorProgress(
            page.nextCursor,
            query.cursor,
            page.obligations.length,
            "obligations",
        );
        const seenObligations = new Set<string>();
        for (const obligation of page.obligations) {
            this.#assertObligation(obligation);
            const persisted = await this.#readRequiredObligation(ctx, obligation.id);
            if (!sameValue(persisted, obligation)) {
                throw new Error("Collaboration store substituted an obligation page entry.");
            }
            if (seenObligations.has(obligation.id)) {
                throw new Error("Collaboration store returned duplicate obligations.");
            }
            seenObligations.add(obligation.id);
            if (
                obligation.requesterAgentId !== actingAgentId &&
                obligation.responderAgentId !== actingAgentId
            ) {
                throw new Error(
                    "Collaboration store returned an obligation outside the acting agent.",
                );
            }
        }
        return structuredClone(page);
    }

    async waitForReply(
        ctx: Context,
        actingAgentId: string,
        inputOrObligationId: CollaborationWaitInput | string,
    ): Promise<CollaborationObligation> {
        this.#assertAgentId(actingAgentId, "acting agent");
        const input =
            typeof inputOrObligationId === "string"
                ? { obligationId: inputOrObligationId }
                : inputOrObligationId;
        this.#assertInput(collaborationWaitInputSchema, input, "wait");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const operationId = await this.#operationId(
            ctx,
            actingAgentId,
            WAIT_OPERATION,
            input.operationId ?? input.obligationId,
        );
        const fingerprint = this.#fingerprint(WAIT_OPERATION, actingAgentId, {
            ...input,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, actingAgentId, WAIT_OPERATION, fingerprint);
        const beforeWait = await this.#commit(
            ctx,
            actingAgentId,
            WAIT_OPERATION,
            operationId,
            fingerprint,
            async (txCtx) => {
                await this.#readRequiredAgent(txCtx, actingAgentId);
                const receipt = await this.#readReceipt(
                    txCtx,
                    actingAgentId,
                    WAIT_OPERATION,
                    operationId,
                    fingerprint,
                );
                const current = await this.#readRequiredObligation(txCtx, input.obligationId);
                if (current.requesterAgentId !== actingAgentId) {
                    throw new Error("An agent may wait only for its own reply obligations.");
                }
                if (receipt !== undefined) {
                    const result = this.#receiptObligation(receipt);
                    if (
                        !sameValue(result, current) ||
                        result.status === "pending" ||
                        current.status === "pending"
                    ) {
                        throw new Error(
                            "Collaboration wait receipt disagrees with the host obligation.",
                        );
                    }
                    return this.#change(
                        WAIT_OPERATION,
                        actingAgentId,
                        operationId,
                        current,
                        false,
                        [],
                    );
                }
                if (current.status !== "pending") {
                    await this.#writeReceipt(txCtx, {
                        kind: WAIT_OPERATION,
                        operationId,
                        actingAgentId,
                        fingerprint,
                        result: current,
                    });
                    return this.#change(
                        WAIT_OPERATION,
                        actingAgentId,
                        operationId,
                        current,
                        false,
                        [],
                    );
                }
                // A durable wait is allowed to suspend, so never keep the host transaction open
                // while the broker waits. The authoritative result is re-read below.
                return this.#change(WAIT_OPERATION, actingAgentId, operationId, current, false, []);
            },
        );
        this.#assertObligation(beforeWait.result);
        if (beforeWait.result.status !== "pending") {
            return structuredClone(beforeWait.result);
        }

        const waitedRaw: unknown = this.#broker.wait(ctx, actingAgentId, input.obligationId);
        const waited = await requirePromise(waitedRaw, "Collaboration broker wait");
        this.#assertObligation(waited);
        if (
            waited.id !== input.obligationId ||
            waited.requesterAgentId !== actingAgentId ||
            waited.status === "pending"
        ) {
            throw new Error("Collaboration broker returned an invalid wait result.");
        }

        const change = await this.#commit(
            ctx,
            actingAgentId,
            WAIT_OPERATION,
            operationId,
            fingerprint,
            async (txCtx) => {
                await this.#readRequiredAgent(txCtx, actingAgentId);
                const receipt = await this.#readReceipt(
                    txCtx,
                    actingAgentId,
                    WAIT_OPERATION,
                    operationId,
                    fingerprint,
                );
                const current = await this.#readRequiredObligation(txCtx, input.obligationId);
                if (current.requesterAgentId !== actingAgentId) {
                    throw new Error("An agent may wait only for its own reply obligations.");
                }
                if (receipt !== undefined) {
                    const result = this.#receiptObligation(receipt);
                    if (
                        !sameValue(result, current) ||
                        result.status === "pending" ||
                        current.status === "pending"
                    ) {
                        throw new Error(
                            "Collaboration wait receipt disagrees with the host obligation.",
                        );
                    }
                    return this.#change(
                        WAIT_OPERATION,
                        actingAgentId,
                        operationId,
                        current,
                        false,
                        [],
                    );
                }
                if (current.status === "pending") {
                    throw new Error(
                        "Collaboration broker wait completed without persisting the obligation.",
                    );
                }
                if (!sameValue(current, waited)) {
                    throw new Error(
                        "Collaboration wait result disagrees with the host obligation.",
                    );
                }
                await this.#writeReceipt(txCtx, {
                    kind: WAIT_OPERATION,
                    operationId,
                    actingAgentId,
                    fingerprint,
                    result: current,
                });
                return this.#change(WAIT_OPERATION, actingAgentId, operationId, current, true, []);
            },
        );
        this.#assertObligation(change.result);
        return structuredClone(change.result);
    }

    async wait(
        ctx: Context,
        actingAgentId: string,
        inputOrObligationId: CollaborationWaitInput | string,
    ): Promise<CollaborationObligation> {
        return await this.waitForReply(ctx, actingAgentId, inputOrObligationId);
    }

    async scheduleMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationScheduleInput,
    ): Promise<CollaborationSchedule> {
        this.#assertAgentId(actingAgentId, "acting agent");
        this.#assertInput(collaborationScheduleInputSchema, input, "schedule message");
        await this.#readRequiredAgent(ctx, actingAgentId);
        const operationId = await this.#operationId(
            ctx,
            actingAgentId,
            SCHEDULE_OPERATION,
            input.operationId ?? input.id,
        );
        const id =
            input.id ??
            (await this.#callScopedId(
                ctx,
                actingAgentId,
                "schedule.id",
                this.#scheduleIdFactory,
                collaborationScheduleIdSchema,
                "schedule",
            ));
        const fingerprint = this.#fingerprint(SCHEDULE_OPERATION, actingAgentId, {
            ...input,
            id,
            operationId,
        });
        await this.#bindOperationFingerprint(ctx, actingAgentId, SCHEDULE_OPERATION, fingerprint);
        const change = await this.#commit(
            ctx,
            actingAgentId,
            SCHEDULE_OPERATION,
            operationId,
            fingerprint,
            async (txCtx) => {
                await this.#readRequiredAgent(txCtx, actingAgentId);
                const target = await this.#readRequiredAgent(txCtx, input.targetAgentId);
                await this.#authorize(txCtx, actingAgentId, target, "schedule");
                const receipt = await this.#readReceipt(
                    txCtx,
                    actingAgentId,
                    SCHEDULE_OPERATION,
                    operationId,
                    fingerprint,
                );
                if (receipt !== undefined) {
                    const result = this.#receiptSchedule(receipt);
                    const current = await this.#readSchedule(txCtx, actingAgentId, result.id);
                    if (
                        current === undefined ||
                        !sameScheduleIdentity(current, result) ||
                        current.ownerAgentId !== actingAgentId
                    ) {
                        throw new Error("Collaboration schedule receipt disagrees with the host.");
                    }
                    return this.#change(
                        SCHEDULE_OPERATION,
                        actingAgentId,
                        operationId,
                        current,
                        false,
                        [],
                    );
                }
                const scheduledRaw: unknown = this.#broker.schedule(txCtx, actingAgentId, {
                    id,
                    ownerAgentId: actingAgentId,
                    targetAgentId: input.targetAgentId,
                    message: input.message,
                    dueAt: input.dueAt,
                });
                const scheduled = await requirePromise(
                    scheduledRaw,
                    "Collaboration broker schedule",
                );
                assertCollaborationSchedule(scheduled);
                if (
                    scheduled.id !== id ||
                    scheduled.ownerAgentId !== actingAgentId ||
                    scheduled.targetAgentId !== input.targetAgentId ||
                    scheduled.message !== input.message ||
                    scheduled.dueAt !== input.dueAt
                ) {
                    throw new Error("Collaboration broker returned a substituted schedule.");
                }
                const event = await this.#event(txCtx, {
                    type: "schedule_created",
                    actingAgentId,
                    schedule: scheduled,
                });
                await this.#announce(txCtx, event);
                await this.#writeReceipt(txCtx, {
                    kind: SCHEDULE_OPERATION,
                    operationId,
                    actingAgentId,
                    fingerprint,
                    result: scheduled,
                });
                return this.#change(
                    SCHEDULE_OPERATION,
                    actingAgentId,
                    operationId,
                    scheduled,
                    true,
                    [event],
                );
            },
        );
        this.#assertSchedule(change.result);
        return structuredClone(change.result);
    }

    async schedule(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationScheduleInput,
    ): Promise<CollaborationSchedule> {
        return await this.scheduleMessage(ctx, actingAgentId, input);
    }

    readonly tools = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<readonly AnyAgentTool[]> => {
        const tools: AnyAgentTool[] = [
            createAgentTool(this, scope.agent.id),
            listAgentsTool(this, scope.agent.id, this.#maxOutputCharacters),
            sendMessageTool(this, scope.agent.id),
            replyToMessageTool(this, scope.agent.id),
            waitForReplyTool(this, scope.agent.id),
        ];
        const current = await this.#readAgent(ctx, scope.agent.id);
        // Scheduled delivery is a root-agent capability. A missing roster row is not enough
        // evidence that this agent is a root, so fail closed until the host projection exists.
        if (current?.parentId === null) {
            tools.push(scheduleMessageTool(this, scope.agent.id));
        }
        return tools;
    };

    readonly metadataChangedTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
        change: AgentMetadataChange,
    ): Promise<void> => {
        this.#assertAgentId(scope.agent.id, "metadata agent");
        this.#assertMetadata(change.metadata);
        const current = await this.#readRequiredAgent(ctx, scope.agent.id);
        const updated: CollaborationAgent = {
            ...current,
            ...(change.metadata.title === undefined ? {} : { title: change.metadata.title }),
            metadata: change.metadata,
            updatedAt: this.#now(),
        };
        this.#assertAgent(updated);
        await this.#writeAgent(ctx, updated);
        const persisted = await this.#readRequiredAgent(ctx, scope.agent.id);
        if (!sameValue(persisted, updated)) {
            throw new Error("Collaboration roster substituted metadata.");
        }
    };

    readonly beforeAgentLoopTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<void> => {
        await this.#setStatus(ctx, scope.agent.id, "active");
    };

    readonly afterAgentSettledTransact = async (
        ctx: Context,
        scope: AgentFeatureScope,
    ): Promise<void> => {
        await this.#setStatus(ctx, scope.agent.id, "idle");
    };

    async #send(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationSendInput | CollaborationReplyInput,
        kind: "send" | "reply",
    ): Promise<CollaborationSendResult> {
        const recipientId = input.toAgentId;
        const operationId = await this.#operationId(
            ctx,
            actingAgentId,
            kind,
            input.operationId ?? input.messageId,
        );
        const messageId =
            input.messageId ??
            (await this.#callScopedId(
                ctx,
                actingAgentId,
                `${kind}.messageId`,
                this.#messageIdFactory,
                collaborationMessageIdSchema,
                "message",
            ));
        const fingerprint = this.#fingerprint(kind, actingAgentId, {
            ...input,
            operationId,
            messageId,
        });
        await this.#bindOperationFingerprint(ctx, actingAgentId, kind, fingerprint);
        const change = await this.#commit(
            ctx,
            actingAgentId,
            kind,
            operationId,
            fingerprint,
            async (txCtx) => {
                const sender = await this.#readRequiredAgent(txCtx, actingAgentId);
                const recipient = await this.#readRequiredAgent(txCtx, recipientId);
                await this.#authorize(txCtx, actingAgentId, recipient, kind);
                const receipt = await this.#readReceipt(
                    txCtx,
                    actingAgentId,
                    kind,
                    operationId,
                    fingerprint,
                );
                if (receipt !== undefined) {
                    return this.#change(
                        kind,
                        actingAgentId,
                        operationId,
                        await this.#replayMessage(
                            txCtx,
                            actingAgentId,
                            receipt,
                            sender,
                            recipientId,
                            messageId,
                            kind,
                            input,
                        ),
                        false,
                        [],
                    );
                }

                const replyTo = "replyTo" in input ? input.replyTo : undefined;
                let existingObligation: CollaborationObligation | undefined;
                if (replyTo !== undefined) {
                    existingObligation = await this.#readRequiredObligation(txCtx, replyTo);
                    if (existingObligation.responderAgentId !== actingAgentId) {
                        throw new Error("Only the requested responder may answer this obligation.");
                    }
                    if (existingObligation.requesterAgentId !== recipientId) {
                        throw new Error("A reply must be sent to the requesting agent.");
                    }
                    if (existingObligation.status !== "pending") {
                        throw new Error("The reply obligation is no longer pending.");
                    }
                }
                const obligationId =
                    replyTo !== undefined || !("expectReply" in input) || input.expectReply !== true
                        ? undefined
                        : await this.#callScopedId(
                              txCtx,
                              actingAgentId,
                              `${kind}.obligationId`,
                              this.#obligationIdFactory,
                              collaborationObligationIdSchema,
                              "obligation",
                          );
                const at = this.#now();
                const messageMetadata = collaborationMessageMetadata(
                    input.metadata,
                    operationId,
                    messageId,
                    actingAgentId,
                    recipientId,
                    obligationId,
                    replyTo,
                );
                const message: CollaborationMessage = {
                    id: messageId,
                    fromAgentId: actingAgentId,
                    toAgentId: recipientId,
                    text: input.text,
                    ...(replyTo === undefined ? {} : { replyTo }),
                    ...(obligationId === undefined ? {} : { obligationId }),
                    metadata: messageMetadata,
                    createdAt: at,
                };
                this.#assertMessage(message);
                const existing = await this.#readMessage(txCtx, messageId);
                if (existing !== undefined) {
                    if (!sameValue(existing, message)) {
                        throw new Error(
                            `Message "${messageId}" already exists with different values.`,
                        );
                    }
                    const existingResult = await this.#resultForMessage(
                        txCtx,
                        existing,
                        replyTo,
                        obligationId,
                    );
                    await this.#writeReceipt(txCtx, {
                        kind,
                        operationId,
                        actingAgentId,
                        fingerprint,
                        result: existingResult,
                    });
                    return this.#change(
                        kind,
                        actingAgentId,
                        operationId,
                        existingResult,
                        false,
                        [],
                    );
                }
                const brokerOptions = {
                    id: messageId,
                    metadata: messageMetadata,
                };
                this.#assertValue(
                    collaborationBrokerSendOptionsSchema,
                    brokerOptions,
                    "broker send options",
                );
                const sendRaw: unknown = this.#broker.send(
                    txCtx,
                    recipientId,
                    {
                        role: "user",
                        content: [{ type: "text", text: input.text }],
                    },
                    brokerOptions,
                );
                assertCollaborationVoidResult(
                    await requirePromise(sendRaw, "Collaboration broker send"),
                    "broker send",
                );
                await this.#writeMessage(txCtx, message);
                const persistedMessage = await this.#readRequiredMessage(txCtx, messageId);
                if (!sameValue(persistedMessage, message)) {
                    throw new Error("Collaboration store substituted the sent message.");
                }

                let obligation: CollaborationObligation | undefined;
                if (obligationId !== undefined) {
                    obligation = {
                        id: obligationId,
                        requesterAgentId: actingAgentId,
                        responderAgentId: recipientId,
                        messageId,
                        status: "pending",
                        createdAt: at,
                        updatedAt: at,
                    };
                    this.#assertObligation(obligation);
                    await this.#writeObligation(txCtx, obligation);
                    obligation = await this.#readRequiredObligation(txCtx, obligationId);
                    if (
                        !sameValue(obligation, {
                            id: obligationId,
                            requesterAgentId: actingAgentId,
                            responderAgentId: recipientId,
                            messageId,
                            status: "pending",
                            createdAt: at,
                            updatedAt: at,
                        })
                    ) {
                        throw new Error("Collaboration store substituted the reply obligation.");
                    }
                } else if (existingObligation !== undefined) {
                    const answered: CollaborationObligation = {
                        ...existingObligation,
                        status: "answered",
                        answerMessageId: messageId,
                        updatedAt: at,
                    };
                    this.#assertObligation(answered);
                    await this.#writeObligation(txCtx, answered);
                    obligation = await this.#readRequiredObligation(txCtx, answered.id);
                    if (!sameValue(obligation, answered)) {
                        throw new Error("Collaboration store substituted the answered obligation.");
                    }
                }
                const result = {
                    message: persistedMessage,
                    ...(obligation === undefined ? {} : { obligation }),
                };
                this.#assertSendResult(result);
                const event = await this.#event(txCtx, {
                    type: "message_sent",
                    actingAgentId,
                    message: persistedMessage,
                    ...(obligation === undefined ? {} : { obligation }),
                });
                await this.#announce(txCtx, event);
                const events: CollaborationEvent[] = [event];
                if (existingObligation !== undefined && obligation !== undefined) {
                    const answerEvent = await this.#event(txCtx, {
                        type: "reply_answered",
                        actingAgentId,
                        obligationId: obligation.id,
                        answerMessageId: messageId,
                    });
                    await this.#announce(txCtx, answerEvent);
                    events.push(answerEvent);
                }
                await this.#writeReceipt(txCtx, {
                    kind,
                    operationId,
                    actingAgentId,
                    fingerprint,
                    result,
                });
                return this.#change(kind, actingAgentId, operationId, result, true, events);
            },
        );
        this.#assertSendResult(change.result);
        return structuredClone(change.result);
    }

    async #setStatus(
        ctx: Context,
        agentId: string,
        status: "active" | "idle" | "waiting",
    ): Promise<void> {
        const current = await this.#readRequiredAgent(ctx, agentId);
        if (current.status === status) return;
        const updated: CollaborationAgent = {
            ...current,
            status,
            updatedAt: this.#now(),
        };
        this.#assertAgent(updated);
        await this.#writeAgent(ctx, updated);
        const persisted = await this.#readRequiredAgent(ctx, agentId);
        if (!sameValue(persisted, updated)) {
            throw new Error("Collaboration roster substituted agent status.");
        }
        const event = await this.#event(ctx, {
            type: "agent_status_changed",
            actingAgentId: agentId,
            agentId,
            status,
        });
        await this.#announce(ctx, event);
    }

    async #commit(
        ctx: Context,
        actingAgentId: string,
        kind: CollaborationMutationKind,
        operationId: string,
        fingerprint: string,
        decide: (txCtx: Context) => Promise<CollaborationTransactionChange>,
    ): Promise<CollaborationTransactionChange> {
        let expected: CollaborationTransactionChange | undefined;
        const raw: unknown = this.#store.transaction(ctx, actingAgentId, async (txCtx) => {
            const decided = await decide(txCtx);
            assertCollaborationTransactionChange(decided);
            if (
                decided.kind !== kind ||
                decided.operationId !== operationId ||
                decided.actingAgentId !== actingAgentId
            ) {
                throw new Error(
                    "Collaboration transaction returned a different operation identity.",
                );
            }
            expected = cloneAndFreezeChange(decided);
            return decided;
        });
        const returned = await requirePromise(raw, "Collaboration store transaction");
        assertCollaborationTransactionChange(returned);
        if (expected === undefined || !sameValue(returned, expected)) {
            throw new Error("Collaboration store transaction returned a substituted change.");
        }
        if (
            returned.kind !== kind ||
            returned.operationId !== operationId ||
            returned.actingAgentId !== actingAgentId
        ) {
            throw new Error("Collaboration transaction returned a different operation identity.");
        }
        this.#assertValue(collaborationFingerprintSchema, fingerprint, "fingerprint");
        assertKindResult(kind, returned.result);
        return structuredClone(returned);
    }

    #change(
        kind: CollaborationMutationKind,
        actingAgentId: string,
        operationId: string,
        result: Static<typeof collaborationMutationResultSchema>,
        changed: boolean,
        events: readonly CollaborationEvent[],
    ): CollaborationTransactionChange {
        const change = {
            kind,
            operationId,
            actingAgentId,
            result: structuredClone(result),
            changed,
            events: events.map((event) => cloneAndFreezeEvent(event)),
        };
        assertCollaborationTransactionChange(change);
        return change;
    }

    async #event(
        ctx: Context,
        payload:
            | {
                  readonly type: "agent_created";
                  readonly actingAgentId: string;
                  readonly agent: CollaborationAgent;
              }
            | {
                  readonly type: "agent_status_changed";
                  readonly actingAgentId: string;
                  readonly agentId: string;
                  readonly status: "active" | "idle" | "waiting";
              }
            | {
                  readonly type: "message_sent";
                  readonly actingAgentId: string;
                  readonly message: CollaborationMessage;
                  readonly obligation?: CollaborationObligation;
              }
            | {
                  readonly type: "reply_answered";
                  readonly actingAgentId: string;
                  readonly obligationId: string;
                  readonly answerMessageId: string;
              }
            | {
                  readonly type: "schedule_created";
                  readonly actingAgentId: string;
                  readonly schedule: CollaborationSchedule;
              },
    ): Promise<CollaborationEvent> {
        const eventId = await this.#eventIdFactory(ctx, payload.actingAgentId);
        this.#assertValue(collaborationEventIdSchema, eventId, "event identity");
        const event = cloneAndFreezeEvent({
            ...payload,
            eventId,
            at: this.#now(),
        });
        return event;
    }

    async #announce(ctx: Context, event: CollaborationEvent): Promise<void> {
        const frozen = cloneAndFreezeEvent(event);
        await invokeVoid(
            this.#listener?.onEventTransactional?.(ctx, frozen),
            "Collaboration transactional listener",
        );
        const registration: unknown = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, frozen),
        );
        assertSynchronousRegistration(registration);
    }

    async #notifyPostCommit(ctx: Context, event: CollaborationEvent): Promise<void> {
        try {
            await invokeVoid(
                this.#listener?.onEvent?.(ctx, event),
                "Collaboration post-commit listener",
            );
        } catch (error: unknown) {
            try {
                await invokeVoid(
                    this.#onPostCommitError?.(ctx, event, error),
                    "Collaboration post-commit error handler",
                );
            } catch {
                // Post-commit observation is advisory and cannot undo a committed mutation.
            }
        }
    }

    async #readReceipt(
        ctx: Context,
        actingAgentId: string,
        kind: CollaborationMutationKind,
        operationId: string,
        fingerprint: string,
    ): Promise<CollaborationMutationReceipt | undefined> {
        const raw: unknown = this.#store.readReceipt(ctx, actingAgentId, operationId);
        const value = await requirePromise(raw, "Collaboration store readReceipt");
        if (value === undefined) return undefined;
        assertCollaborationMutationReceipt(value);
        this.#assertReceipt(value);
        if (
            value.kind !== kind ||
            value.operationId !== operationId ||
            value.actingAgentId !== actingAgentId ||
            value.fingerprint !== fingerprint
        ) {
            throw new Error(
                `Collaboration operation "${operationId}" was reused with different input.`,
            );
        }
        return structuredClone(value);
    }

    async #writeReceipt(ctx: Context, receipt: CollaborationMutationReceipt): Promise<void> {
        assertCollaborationMutationReceipt(receipt);
        this.#assertReceipt(receipt);
        const expected = structuredClone(receipt);
        const raw: unknown = this.#store.writeReceipt(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration store writeReceipt"),
            "store writeReceipt",
        );
        const persistedRaw: unknown = this.#store.readReceipt(
            ctx,
            expected.actingAgentId,
            expected.operationId,
        );
        const persisted = await requirePromise(
            persistedRaw,
            "Collaboration store readReceipt after write",
        );
        assertCollaborationMutationReceipt(persisted);
        this.#assertReceipt(persisted);
        if (!sameValue(persisted, expected)) {
            throw new Error("Collaboration store substituted the mutation receipt.");
        }
    }

    async #replayCreatedAgent(
        ctx: Context,
        actingAgentId: string,
        receipt: CollaborationMutationReceipt,
        input: CollaborationCreateInput,
        id: string,
    ): Promise<CollaborationAgent> {
        this.#assertAgent(receipt.result);
        if (receipt.result.id !== id || receipt.result.ownerAgentId !== actingAgentId) {
            throw new Error("Collaboration create receipt belongs to another agent.");
        }
        const current = await this.#readRequiredAgent(ctx, id);
        if (!sameAgentIdentity(current, receipt.result)) {
            throw new Error(
                "Collaboration create receipt disagrees with the authoritative roster.",
            );
        }
        const metadata = mergedMetadata(input.config.metadata, input.metadata);
        const expectedConfig = {
            ...input.config,
            ...(metadata === undefined ? {} : { metadata }),
        };
        await this.#assertBrokerConfig(ctx, id, expectedConfig);
        return current;
    }

    async #replayMessage(
        ctx: Context,
        actingAgentId: string,
        receipt: CollaborationMutationReceipt,
        _sender: CollaborationAgent,
        recipientId: string,
        messageId: string,
        kind: "send" | "reply",
        input: CollaborationSendInput | CollaborationReplyInput,
    ): Promise<CollaborationSendResult> {
        this.#assertSendResult(receipt.result);
        const message = await this.#readRequiredMessage(ctx, messageId);
        if (
            message.fromAgentId !== actingAgentId ||
            message.toAgentId !== recipientId ||
            !sameValue(
                message.metadata,
                collaborationMessageMetadata(
                    input.metadata,
                    receipt.operationId,
                    messageId,
                    actingAgentId,
                    recipientId,
                    message.obligationId,
                    "replyTo" in input ? input.replyTo : undefined,
                ),
            )
        ) {
            throw new Error(
                "Collaboration message receipt disagrees with the authoritative message.",
            );
        }
        const expected = await this.#resultForMessage(
            ctx,
            message,
            "replyTo" in input ? input.replyTo : undefined,
            message.obligationId,
        );
        if (
            !sameValue(expected.message, receipt.result.message) ||
            (expected.obligation === undefined) !== (receipt.result.obligation === undefined) ||
            (expected.obligation !== undefined &&
                receipt.result.obligation !== undefined &&
                !sameValue(expected.obligation, receipt.result.obligation))
        ) {
            throw new Error("Collaboration message receipt disagrees with the host result.");
        }
        if (kind === "reply" && ("replyTo" in input ? message.replyTo !== input.replyTo : true)) {
            throw new Error("Collaboration reply receipt targets another obligation.");
        }
        return expected;
    }

    async #resultForMessage(
        ctx: Context,
        message: CollaborationMessage,
        replyTo: string | undefined,
        obligationId: string | undefined,
    ): Promise<CollaborationSendResult> {
        const expectedObligationId = obligationId ?? replyTo;
        const obligation =
            expectedObligationId === undefined
                ? undefined
                : await this.#readRequiredObligation(ctx, expectedObligationId);
        if (
            obligationId !== undefined &&
            obligation !== undefined &&
            obligation.messageId !== message.id
        ) {
            throw new Error("Collaboration message refers to another obligation.");
        }
        if (replyTo !== undefined && message.replyTo !== replyTo) {
            throw new Error("Collaboration reply refers to another obligation.");
        }
        const result = {
            message,
            ...(obligation === undefined ? {} : { obligation }),
        };
        this.#assertSendResult(result);
        return result;
    }

    async #assertExistingCreation(
        ctx: Context,
        actingAgentId: string,
        existing: CollaborationAgent,
        input: CollaborationCreateInput,
        id: string,
        parentId: string | null,
        metadata: CollaborationMetadata | undefined,
        config: Static<typeof agentConfigSchema>,
    ): Promise<void> {
        if (
            existing.id !== id ||
            existing.ownerAgentId !== actingAgentId ||
            existing.parentId !== parentId ||
            existing.role !== input.role ||
            existing.groupId !== input.groupId ||
            existing.title !== input.title ||
            !sameValue(existing.metadata ?? null, metadata ?? null)
        ) {
            throw new Error(`Agent "${id}" already exists with different values.`);
        }
        await this.#assertBrokerConfig(ctx, id, config);
    }

    async #assertBrokerConfig(
        ctx: Context,
        id: string,
        expected: Static<typeof agentConfigSchema>,
    ): Promise<void> {
        const raw: unknown = this.#broker.config(ctx, id);
        const actual = await requirePromise(raw, "Collaboration broker config");
        if (actual === undefined) {
            throw new Error(
                `Collaboration broker did not persist Agent Base configuration for "${id}".`,
            );
        }
        this.#assertValue(agentConfigSchema, actual, "broker configuration");
        if (isRecord(actual) && actual.metadata !== undefined) {
            this.#assertMetadata(actual.metadata);
        }
        const detached = structuredClone(actual);
        if (!sameValue(detached, expected)) {
            throw new Error(`Agent "${id}" has a different Agent Base configuration.`);
        }
    }

    #assertReceipt(receipt: CollaborationMutationReceipt): void {
        const encoded = new TextEncoder().encode(receipt.fingerprint);
        if (encoded.byteLength > 65_536) {
            throw new Error("Collaboration receipt fingerprint exceeds its encoded byte bound.");
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(receipt.fingerprint);
        } catch {
            throw new Error("Collaboration receipt fingerprint is not canonical JSON.");
        }
        if (canonicalString(parsed) !== receipt.fingerprint) {
            throw new Error("Collaboration receipt fingerprint is not canonical.");
        }
        assertKindResult(receipt.kind, receipt.result);
    }

    async #authorize(
        ctx: Context,
        actingAgentId: string,
        target: CollaborationAgent,
        action: Static<
            (typeof collaborationAuthorizationSchema.properties.authorize.parameters)[3]
        >,
    ): Promise<void> {
        if (target.id === actingAgentId || target.ownerAgentId === actingAgentId) return;
        const acting = await this.#readAgent(ctx, actingAgentId);
        if (
            acting !== undefined &&
            (acting.ownerAgentId === target.id || acting.parentId === target.id)
        ) {
            return;
        }
        if (this.#authorization === undefined) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} agent "${target.id}".`,
            );
        }
        const raw: unknown = this.#authorization.authorize(ctx, actingAgentId, target.id, action);
        const allowed = await requirePromise(raw, "Collaboration authorization");
        if (typeof allowed !== "boolean") {
            throw new Error("Collaboration authorization returned a non-boolean result.");
        }
        if (!allowed) {
            throw new Error(
                `Agent "${actingAgentId}" is not authorized to ${action} agent "${target.id}".`,
            );
        }
    }

    async #operationId(
        ctx: Context,
        actingAgentId: string,
        kind: string,
        requested: string | undefined,
    ): Promise<string> {
        if (requested !== undefined) {
            this.#assertValue(collaborationOperationIdSchema, requested, "operation identity");
        }
        const key = `operation.${kind}`;
        const kv = agentKV(ctx);
        if (kv !== undefined) {
            const stored = await kv.read(ctx, key);
            if (stored !== undefined) {
                this.#assertValue(operationReceiptSchema, stored, "stored operation identity");
                const typed = stored as Static<typeof operationReceiptSchema>;
                if (requested !== undefined && requested !== typed.operationId) {
                    throw new Error("The retry supplied a different operation identity.");
                }
                return typed.operationId;
            }
            const generated = requested ?? (await this.#operationIdFactory(ctx, actingAgentId));
            this.#assertValue(collaborationOperationIdSchema, generated, "operation identity");
            await kv.write(ctx, key, { operationId: generated, fingerprint: "" });
            return generated;
        }
        const generated = requested ?? (await this.#operationIdFactory(ctx, actingAgentId));
        this.#assertValue(collaborationOperationIdSchema, generated, "operation identity");
        return generated;
    }

    async #bindOperationFingerprint(
        ctx: Context,
        _actingAgentId: string,
        kind: string,
        fingerprint: string,
    ): Promise<void> {
        this.#assertValue(collaborationFingerprintSchema, fingerprint, "fingerprint");
        const kv = agentKV(ctx);
        if (kv === undefined) return;
        const key = `operation.${kind}`;
        const stored = await kv.read(ctx, key);
        this.#assertValue(operationReceiptSchema, stored, "stored operation identity");
        const typed = stored as Static<typeof operationReceiptSchema>;
        if (typed.fingerprint !== "" && typed.fingerprint !== fingerprint) {
            throw new Error("The retry supplied different collaboration input.");
        }
        if (typed.fingerprint === "") {
            await kv.write(ctx, key, { ...typed, fingerprint });
        }
    }

    async #callScopedId<ValueSchema extends TSchema>(
        ctx: Context,
        actingAgentId: string,
        key: string,
        factory: (ctx: Context, actingAgentId: string) => string | Promise<string>,
        schema: ValueSchema,
        label: string,
    ): Promise<string> {
        const kv = agentKV(ctx);
        if (kv !== undefined) {
            const stored = await kv.read(ctx, key);
            if (stored !== undefined) {
                this.#assertValue(schema, stored, `stored ${label} identity`);
                return stored as string;
            }
            const generated = await factory(ctx, actingAgentId);
            this.#assertValue(schema, generated, `${label} identity`);
            await kv.write(ctx, key, generated);
            return generated;
        }
        const generated = await factory(ctx, actingAgentId);
        this.#assertValue(schema, generated, `${label} identity`);
        return generated;
    }

    #fingerprint(kind: string, actingAgentId: string, input: unknown): string {
        const value = canonicalString({ kind, actingAgentId, input });
        const encoded = new TextEncoder().encode(value);
        if (encoded.byteLength > 65_536) {
            throw new Error("Collaboration mutation fingerprint exceeds its encoded byte bound.");
        }
        this.#assertValue(collaborationFingerprintSchema, value, "fingerprint");
        return value;
    }

    #now(): number {
        const at = this.#clock();
        this.#assertValue(Type.Integer({ minimum: 0 }), at, "clock value");
        return at;
    }

    async #readAgent(ctx: Context, id: string): Promise<CollaborationAgent | undefined> {
        const raw: unknown = this.#roster.readAgent(ctx, id);
        const value = await requirePromise(raw, "Collaboration roster readAgent");
        if (value !== undefined) this.#assertAgent(value);
        return value === undefined ? undefined : structuredClone(value);
    }

    async #readRequiredAgent(ctx: Context, id: string): Promise<CollaborationAgent> {
        const value = await this.#readAgent(ctx, id);
        if (value === undefined) throw new Error(`Collaboration agent "${id}" does not exist.`);
        await this.#validateAgentReferences(ctx, value);
        return value;
    }

    async #validateAgentReferences(ctx: Context, agent: CollaborationAgent): Promise<void> {
        if (
            agent.ownerAgentId !== agent.id &&
            (await this.#readAgent(ctx, agent.ownerAgentId)) === undefined
        ) {
            throw new Error(`Collaboration agent "${agent.id}" has a missing owner.`);
        }
        const seen = new Set<string>();
        let current = agent;
        for (let depth = 0; depth <= 100; depth += 1) {
            if (seen.has(current.id)) {
                throw new Error(`Collaboration agent "${agent.id}" has cyclic parentage.`);
            }
            seen.add(current.id);
            if (current.parentId === null) return;
            const parent = await this.#readAgent(ctx, current.parentId);
            if (parent === undefined) {
                throw new Error(`Collaboration agent "${agent.id}" has a missing parent.`);
            }
            current = parent;
        }
        throw new Error(`Collaboration agent "${agent.id}" exceeds the parentage depth bound.`);
    }

    async #writeAgent(ctx: Context, agent: CollaborationAgent): Promise<void> {
        const expected = structuredClone(agent);
        const raw: unknown = this.#roster.writeAgent(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration roster writeAgent"),
            "roster writeAgent",
        );
        const persisted = await this.#readAgent(ctx, expected.id);
        if (persisted === undefined || !sameValue(persisted, expected)) {
            throw new Error("Collaboration roster substituted the written agent.");
        }
    }

    async #readMessage(ctx: Context, id: string): Promise<CollaborationMessage | undefined> {
        const raw: unknown = this.#store.readMessage(ctx, id);
        const value = await requirePromise(raw, "Collaboration store readMessage");
        if (value !== undefined) this.#assertMessage(value);
        return value === undefined ? undefined : structuredClone(value);
    }

    async #readRequiredMessage(ctx: Context, id: string): Promise<CollaborationMessage> {
        const value = await this.#readMessage(ctx, id);
        if (value === undefined) throw new Error(`Collaboration message "${id}" does not exist.`);
        return value;
    }

    async #writeMessage(ctx: Context, message: CollaborationMessage): Promise<void> {
        const expected = structuredClone(message);
        const raw: unknown = this.#store.writeMessage(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration store writeMessage"),
            "store writeMessage",
        );
        const persisted = await this.#readMessage(ctx, expected.id);
        if (persisted === undefined || !sameValue(persisted, expected)) {
            throw new Error("Collaboration store substituted the written message.");
        }
    }

    async #readObligation(ctx: Context, id: string): Promise<CollaborationObligation | undefined> {
        const raw: unknown = this.#store.readObligation(ctx, id);
        const value = await requirePromise(raw, "Collaboration store readObligation");
        if (value !== undefined) {
            this.#assertObligation(value);
            const message = await this.#readMessage(ctx, value.messageId);
            if (
                message === undefined ||
                message.obligationId !== value.id ||
                message.fromAgentId !== value.requesterAgentId ||
                message.toAgentId !== value.responderAgentId
            ) {
                throw new Error("Collaboration obligation has invalid message references.");
            }
            if (value.status === "answered") {
                const answer = await this.#readMessage(ctx, value.answerMessageId);
                if (
                    answer === undefined ||
                    answer.id !== value.answerMessageId ||
                    answer.fromAgentId !== value.responderAgentId ||
                    answer.toAgentId !== value.requesterAgentId ||
                    answer.replyTo !== value.id
                ) {
                    throw new Error(
                        "Collaboration answered obligation has an invalid answer message reference.",
                    );
                }
            }
        }
        return value === undefined ? undefined : structuredClone(value);
    }

    async #readRequiredObligation(ctx: Context, id: string): Promise<CollaborationObligation> {
        const value = await this.#readObligation(ctx, id);
        if (value === undefined) {
            throw new Error(`Collaboration reply obligation "${id}" does not exist.`);
        }
        return value;
    }

    async #writeObligation(ctx: Context, obligation: CollaborationObligation): Promise<void> {
        const expected = structuredClone(obligation);
        const raw: unknown = this.#store.writeObligation(ctx, structuredClone(expected));
        assertCollaborationVoidResult(
            await requirePromise(raw, "Collaboration store writeObligation"),
            "store writeObligation",
        );
        const persisted = await this.#readObligation(ctx, expected.id);
        if (persisted === undefined || !sameValue(persisted, expected)) {
            throw new Error("Collaboration store substituted the written obligation.");
        }
    }

    async #readSchedule(
        ctx: Context,
        actingAgentId: string,
        id: string,
    ): Promise<CollaborationSchedule | undefined> {
        const raw: unknown = this.#broker.getSchedule(ctx, actingAgentId, id);
        const value = await requirePromise(raw, "Collaboration broker getSchedule");
        if (value !== undefined) this.#assertSchedule(value);
        return value === undefined ? undefined : structuredClone(value);
    }

    /** Render a complete roster page while keeping every returned identity and cursor visible. */
    formatAgentPageForModel(page: CollaborationAgentPage): string {
        assertCollaborationAgentPage(page);
        this.#assertAgentPageInvariants(page);
        const rows = page.agents.map(
            (agent) =>
                `${agent.id}${agent.role === undefined ? "" : ` (${agent.role})`}: ${agent.status}`,
        );
        const suffix =
            page.nextCursor === undefined
                ? ""
                : `\nMore collaborators start at cursor ${page.nextCursor}.`;
        const text = `${rows.join("\n") || "No collaborators."}${suffix}`;
        if (text.length > this.#maxOutputCharacters) {
            throw new Error("Collaboration roster page exceeds its model-output bound.");
        }
        return text;
    }

    #assertPageLimit(limit: number, kind: string): void {
        if (limit > this.#maxPageSize) {
            throw new Error(`${kind} page limit cannot exceed ${this.#maxPageSize}.`);
        }
    }

    #assertReturnedPage(
        pageLimit: number,
        itemCount: number,
        requestedLimit: number,
        kind: string,
    ): void {
        if (pageLimit > requestedLimit || itemCount > pageLimit) {
            throw new Error(`Collaboration roster returned too many ${kind}.`);
        }
    }

    #fittingAgentCount(page: CollaborationAgentPage): number {
        for (let count = page.agents.length; count >= 1; count -= 1) {
            const candidate = {
                ...page,
                agents: page.agents.slice(0, count),
            };
            const rows = candidate.agents.map(
                (agent) =>
                    `${agent.id}${agent.role === undefined ? "" : ` (${agent.role})`}: ${agent.status}`,
            );
            const suffix =
                candidate.nextCursor === undefined
                    ? ""
                    : `\nMore collaborators start at cursor ${candidate.nextCursor}.`;
            if (
                `${rows.join("\n") || "No collaborators."}${suffix}`.length <=
                this.#maxOutputCharacters
            ) {
                return count;
            }
        }
        return 0;
    }

    #assertAgentPageInvariants(page: CollaborationAgentPage): void {
        const seen = new Set<string>();
        let previous: string | undefined;
        for (const agent of page.agents) {
            this.#assertAgent(agent);
            if (
                seen.has(agent.id) ||
                (previous !== undefined && agent.id.localeCompare(previous) <= 0)
            ) {
                throw new Error("Collaboration roster returned duplicate or unordered agents.");
            }
            seen.add(agent.id);
            previous = agent.id;
        }
    }

    #assertCursorProgress(
        nextCursor: string | undefined,
        requestedCursor: string | undefined,
        itemCount: number,
        kind: string,
    ): void {
        if (nextCursor !== undefined && (itemCount === 0 || nextCursor === requestedCursor)) {
            throw new Error(`Collaboration ${kind} page cursor did not make progress.`);
        }
        if (nextCursor === undefined || requestedCursor === undefined) return;
        const previousNumber = Number(requestedCursor);
        const nextNumber = Number(nextCursor);
        if (
            Number.isSafeInteger(previousNumber) &&
            Number.isSafeInteger(nextNumber) &&
            requestedCursor.trim() !== "" &&
            nextCursor.trim() !== "" &&
            nextNumber <= previousNumber
        ) {
            throw new Error(`Collaboration ${kind} page cursor did not advance.`);
        }
    }

    #assertAgentId(value: unknown, label: string): asserts value is string {
        this.#assertValue(collaborationAgentIdSchema, value, `${label} ID`);
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        this.#assertValue(schema, value, label);
    }

    #assertValue(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid collaboration ${label}.`);
    }

    #assertMetadata(value: unknown): asserts value is CollaborationMetadata {
        assertBoundedMetadata(value);
    }

    #assertAgent(value: unknown): asserts value is CollaborationAgent {
        if (isRecord(value) && value.metadata !== undefined) {
            assertBoundedMetadata(value.metadata);
        }
        this.#assertValue(collaborationAgentSchema, value, "agent");
        const agent = value as CollaborationAgent;
        if (agent.createdAt > agent.updatedAt || agent.parentId === agent.id) {
            throw new Error("Collaboration agent has invalid timestamp or parent invariants.");
        }
        this.#assertMetadataIfPresent(value as CollaborationAgent);
    }

    #assertMetadataIfPresent(value: CollaborationAgent): void {
        if (value.metadata !== undefined) this.#assertMetadata(value.metadata);
    }

    #assertMessage(value: unknown): asserts value is CollaborationMessage {
        if (isRecord(value) && value.metadata !== undefined) {
            assertBoundedMetadata(value.metadata);
        }
        this.#assertValue(collaborationMessageSchema, value, "message");
        if ((value as CollaborationMessage).metadata !== undefined) {
            this.#assertMetadata((value as CollaborationMessage).metadata);
        }
    }

    #assertObligation(value: unknown): asserts value is CollaborationObligation {
        this.#assertValue(collaborationObligationSchema, value, "obligation");
        const obligation = value as CollaborationObligation;
        if (obligation.createdAt > obligation.updatedAt) {
            throw new Error("Collaboration obligation timestamps are invalid.");
        }
    }

    #assertSchedule(value: unknown): asserts value is CollaborationSchedule {
        this.#assertValue(collaborationScheduleSchema, value, "schedule");
        const schedule = value as CollaborationSchedule;
        if (
            schedule.createdAt > schedule.updatedAt ||
            (schedule.status === "delivered" && schedule.deliveredAt === undefined) ||
            (schedule.status !== "delivered" && schedule.deliveredAt !== undefined) ||
            (schedule.status === "undelivered" && schedule.failure === undefined) ||
            (schedule.status !== "undelivered" && schedule.failure !== undefined)
        ) {
            throw new Error("Collaboration schedule state invariants are invalid.");
        }
    }

    #assertSendResult(value: unknown): asserts value is CollaborationSendResult {
        this.#assertValue(collaborationSendResultSchema, value, "send result");
        this.#assertMessage((value as CollaborationSendResult).message);
        if ((value as CollaborationSendResult).obligation !== undefined) {
            this.#assertObligation((value as CollaborationSendResult).obligation);
        }
    }

    #receiptObligation(receipt: CollaborationMutationReceipt): CollaborationObligation {
        this.#assertObligation(receipt.result);
        return receipt.result;
    }

    #receiptSchedule(receipt: CollaborationMutationReceipt): CollaborationSchedule {
        this.#assertSchedule(receipt.result);
        return receipt.result;
    }
}

function validateOptions(options: unknown): CollaborationFeatureOptions {
    if (typeof options !== "object" || options === null) {
        throw new Error("Collaboration feature options are invalid.");
    }
    const source = options as Record<string, unknown>;
    const view = {
        ...source,
        roster: methodView(source.roster, ["readAgent", "writeAgent", "listAgents"]),
        store: methodView(source.store, [
            "transaction",
            "afterCommit",
            "readMessage",
            "writeMessage",
            "readObligation",
            "writeObligation",
            "listObligations",
            "readReceipt",
            "writeReceipt",
        ]),
        broker: methodView(source.broker, [
            "create",
            "config",
            "send",
            "wait",
            "schedule",
            "getSchedule",
        ]),
        ...(source.authorization === undefined
            ? {}
            : { authorization: methodView(source.authorization, ["authorize"]) }),
        ...(source.listener === undefined
            ? {}
            : {
                  listener: methodView(source.listener, ["onEventTransactional", "onEvent"]),
              }),
    };
    if (!Value.Check(collaborationFeatureOptionsSchema, view)) {
        throw new Error("Collaboration feature options are invalid.");
    }
    return options as CollaborationFeatureOptions;
}

function methodView(value: unknown, keys: readonly string[]): unknown {
    if (typeof value !== "object" || value === null) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) return value;
    const source = value as Record<string, unknown>;
    const view: Record<string, unknown> = {};
    for (const key of keys) view[key] = source[key];
    return view;
}

function normalizeCreateInput(
    input: CollaborationCreateInput,
    assertMetadata: (value: unknown) => asserts value is CollaborationMetadata,
): Record<string, unknown> {
    const metadata = mergedMetadata(input.config.metadata, input.metadata);
    if (metadata !== undefined) assertMetadata(metadata);
    return {
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        config: {
            ...input.config,
            ...(metadata === undefined ? {} : { metadata }),
        },
        ...(metadata === undefined ? {} : { metadata }),
    };
}

function mergedMetadata(
    configMetadata: unknown,
    inputMetadata: CollaborationMetadata | undefined,
): CollaborationMetadata | undefined {
    if (configMetadata === undefined && inputMetadata === undefined) return undefined;
    const merged = {
        ...(isRecord(configMetadata) ? configMetadata : {}),
        ...inputMetadata,
    };
    assertBoundedMetadata(merged);
    return merged;
}

function collaborationMessageMetadata(
    inputMetadata: CollaborationMetadata | undefined,
    operationId: string,
    messageId: string,
    fromAgentId: string,
    toAgentId: string,
    obligationId: string | undefined,
    replyTo: string | undefined,
): CollaborationMetadata {
    const metadata = {
        ...inputMetadata,
        collaboration: {
            operationId,
            messageId,
            fromAgentId,
            toAgentId,
            ...(obligationId === undefined ? {} : { obligationId }),
            ...(replyTo === undefined ? {} : { replyTo }),
        },
    };
    assertBoundedMetadata(metadata);
    return metadata;
}

function assertBoundedMetadata(value: unknown): asserts value is CollaborationMetadata {
    const seen = new WeakSet<object>();
    visitMetadata(value, 0, seen);
    if (!Value.Check(collaborationMetadataSchema, value)) {
        throw new Error("Collaboration metadata is invalid.");
    }
    let encoded: Uint8Array;
    try {
        encoded = new TextEncoder().encode(canonicalString(value));
    } catch {
        throw new Error("Collaboration metadata could not be encoded.");
    }
    if (encoded.byteLength > COLLABORATION_METADATA_MAX_ENCODED_BYTES) {
        throw new Error("Collaboration metadata exceeds its encoded byte bound.");
    }
}

function visitMetadata(value: unknown, depth: number, seen: WeakSet<object>): void {
    if (value === null || typeof value !== "object") {
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new Error("Collaboration metadata numbers must be finite.");
        }
        return;
    }
    if (seen.has(value)) throw new Error("Collaboration metadata must be acyclic.");
    if (depth > COLLABORATION_METADATA_MAX_DEPTH) {
        throw new Error("Collaboration metadata exceeds its nesting depth.");
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const child of value) visitMetadata(child, depth + 1, seen);
    } else {
        for (const child of Object.values(value)) visitMetadata(child, depth + 1, seen);
    }
    seen.delete(value);
}

function canonicalString(value: unknown): string {
    const result = deterministicStringify(value);
    if (typeof result !== "string") throw new Error("Collaboration value is not canonical JSON.");
    return result;
}

function sameValue(left: unknown, right: unknown): boolean {
    try {
        return canonicalString(left) === canonicalString(right);
    } catch {
        return false;
    }
}

function sameAgentIdentity(left: CollaborationAgent, right: CollaborationAgent): boolean {
    return (
        left.id === right.id &&
        left.ownerAgentId === right.ownerAgentId &&
        left.parentId === right.parentId &&
        left.role === right.role &&
        left.groupId === right.groupId &&
        left.title === right.title &&
        left.createdAt === right.createdAt
    );
}

function sameScheduleIdentity(left: CollaborationSchedule, right: CollaborationSchedule): boolean {
    return (
        left.id === right.id &&
        left.ownerAgentId === right.ownerAgentId &&
        left.targetAgentId === right.targetAgentId &&
        left.message === right.message &&
        left.dueAt === right.dueAt
    );
}

function assertKindResult(
    kind: CollaborationMutationKind,
    result: unknown,
): asserts result is Static<typeof collaborationMutationResultSchema> {
    const valid =
        (kind === CREATE_OPERATION && Value.Check(collaborationAgentSchema, result)) ||
        ((kind === SEND_OPERATION || kind === REPLY_OPERATION) &&
            Value.Check(collaborationSendResultSchema, result)) ||
        (kind === WAIT_OPERATION && Value.Check(collaborationObligationSchema, result)) ||
        (kind === SCHEDULE_OPERATION && Value.Check(collaborationScheduleSchema, result)) ||
        (kind === "status" && Value.Check(collaborationAgentSchema, result));
    if (!valid) {
        throw new Error(`Collaboration transaction returned an invalid ${kind} result.`);
    }
}

function cloneAndFreezeEvent(event: CollaborationEvent): CollaborationEvent {
    if (!Value.Check(collaborationEventSchema, event)) {
        throw new Error("Collaboration feature created an invalid event.");
    }
    const cloned = structuredClone(event);
    if (!Value.Check(collaborationEventSchema, cloned)) {
        throw new Error("Collaboration feature created an invalid cloned event.");
    }
    return deepFreeze(cloned);
}

function cloneAndFreezeChange(
    change: CollaborationTransactionChange,
): CollaborationTransactionChange {
    const cloned = structuredClone(change);
    assertCollaborationTransactionChange(cloned);
    return deepFreeze(cloned);
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}

function generatedId(prefix: string): string {
    return `${prefix}${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 31)}`;
}

async function requirePromise<ValueType>(value: unknown, operation: string): Promise<ValueType> {
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return a Promise.`);
    }
    return (await value) as ValueType;
}

async function invokeVoid(value: unknown, operation: string): Promise<void> {
    if (value === undefined) return;
    if (!(value instanceof Promise)) {
        throw new Error(`${operation} must return undefined or Promise<void>.`);
    }
    const result = await value;
    if (result !== undefined) {
        throw new Error(`${operation} Promise must resolve to undefined.`);
    }
}

function assertSynchronousRegistration(value: unknown): void {
    if (value === undefined) return;
    if (value instanceof Promise) void value.catch(() => undefined);
    throw new Error("Collaboration store afterCommit must register synchronously.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
