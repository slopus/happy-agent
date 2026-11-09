import { createId } from "@paralleldrive/cuid2";
import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleAction,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    messageModeSchema,
    redactUiValue,
    uiActionDefinition,
    uiActionPermission,
    uiActionProblem,
    uiActionText,
    uiComponents,
    uiDocumentProblems,
    uiOfferState,
    uiPropsProblems,
    type UiActionBlock,
    type UiActionOutcome,
    type UiActionRequest,
    type UiBundle,
    type UiComponent,
    type UiDocument,
    type UiPermissionId,
} from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, detach, withLifetime, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import {
    HistoryModule,
    type HistoryMediaItem,
    type HistoryMessage,
    type HistoryPendingMessage,
} from "../history/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { ChatUiActionError } from "./ChatUiActionError.js";
import type { ChatUiContribution, ChatUiOutcome } from "./ChatUiContribution.js";
import { chatUiMigrations } from "./ChatUiMigrations.js";
import { contributeBasicComponents } from "./impl/basicComponents.js";
import {
    countChatUiAttempts,
    insertChatUiAttempt,
    insertChatUiNote,
    queryAcceptedOnceAttempt,
    queryChatUiAttempt,
    settleChatUiAttempt,
    takeChatUiNotes,
    type ChatUiAttempt,
    type ChatUiAttemptStatus,
} from "./impl/chatUiAttempts.js";
import { findOffer } from "./impl/findOffer.js";
import { showUiTool } from "./tools/show_ui.js";

/** How long a hook may take before its attempt fails with `timeout`. */
const HOOK_TIMEOUT_MS = 15_000;
/** Actions per minute one component of one conversation takes. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** Follows each attempt, so one the daemon stopped in the middle of is failed when it starts. */
const ATTEMPT_FUNCTION = "chat-ui.attempt";
const MAX_FALLBACK = 500;

const attemptArgumentsSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1, maxLength: 256 }),
        id: Type.String({ minLength: 1, maxLength: 96 }),
    },
    { additionalProperties: false },
);

/** One component a model or the daemon writes, before the daemon computes its fallback. */
export interface ChatUiComponentInput {
    readonly id: string;
    readonly type: string;
    readonly props: unknown;
}

/** A click on `/actions`, after the route authenticated the caller and checked the conversation. */
export interface ChatUiActionInput {
    readonly agentId: string;
    readonly request: UiActionRequest;
    /** Who clicked, under their own authority at click time. */
    readonly person: {
        /** The team user; undefined on a standalone daemon. */
        readonly userId: string | undefined;
        /** A guest of an exported bot, who may use only guest-safe components. */
        readonly guest: boolean;
        /** The permissions they hold. */
        readonly granted: ReadonlySet<UiPermissionId>;
    };
}

/** What an action left: its record, the person's message it became, and its result. */
export interface ChatUiActionResult {
    readonly record: HistoryMessage;
    readonly message: HistoryMessage | HistoryPendingMessage | null;
    readonly result: Record<string, unknown> | null;
}

/** An attempt record's outcome changed after it was stored. */
export type ChatUiRecordListener = (agentId: string, record: HistoryMessage) => void;

type AnyContribution = ChatUiContribution<UiBundle>;
type AnyOutcome =
    | {
          readonly status: "accepted";
          readonly note?: string;
          readonly wake?: boolean;
          readonly result?: Record<string, unknown>;
      }
    | { readonly status: "rejected"; readonly code: string; readonly reason: string }
    | { readonly status: "failed"; readonly code?: string; readonly reason: string };

/**
 * Chat UI: the components modules contribute, the `show_ui` tool a model shows them with, the
 * documents the daemon writes itself, and every click on them. A click passes the conversation's
 * checks and the action's declared permission, is recorded with its secrets left out, and is
 * handed to the contributing module's hook, whose outcome is applied in one transaction. See
 * "Chat UI" in API.md and this module's README.
 */
export class ChatUiModule implements AgentModule {
    readonly name = "chat-ui";
    readonly migrations = chatUiMigrations;

    readonly #config: ConfigModule;
    readonly #history: HistoryModule;
    readonly #durable: DurableFunctionsModule;
    readonly #contributions = new Map<
        string,
        { readonly bundle: UiBundle; readonly contribution: AnyContribution }
    >();
    /** Attempts whose hook runs in this process, so the follow-up call leaves them alone. */
    readonly #inFlight = new Map<string, Promise<unknown>>();
    readonly #recordListeners = new Set<ChatUiRecordListener>();
    readonly #queues = new Map<string, Promise<void>>();
    #agents: AgentSystemRef | undefined;
    #ctx: Context | undefined;

    constructor(
        config: ConfigModule,
        history: HistoryModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#history = history;
        this.#durable = durableFunctions;
        contributeBasicComponents(this, config);
        durableFunctions.register({
            name: ATTEMPT_FUNCTION,
            argumentsSchema: attemptArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                const { agentId, id } = call.arguments;
                const running = this.#inFlight.get(attemptKey(agentId, id));
                if (running !== undefined) {
                    await running.catch(() => undefined);
                    return null;
                }
                await this.#interrupted(ctx, agentId, id);
                return null;
            },
        });
    }

    /**
     * Serve one component: `show_ui` accepts it, `capabilities.chatUi` lists it, and `/actions`
     * hands its actions to these hooks. Called once per type, at construction.
     */
    contribute<B extends UiBundle>(bundle: B, contribution: ChatUiContribution<B>): void {
        if (this.#contributions.has(bundle.type)) {
            throw new Error(`The "${bundle.type}" component is already contributed.`);
        }
        if (!uiComponents.some((known) => known.type === bundle.type)) {
            throw new Error(`"${bundle.type}" is not in the chat UI catalog.`);
        }
        for (const name of Object.keys(bundle.actions)) {
            if (typeof (contribution.actions as Record<string, unknown>)[name] !== "function") {
                throw new Error(`The "${bundle.type}.${name}" action has no hook.`);
            }
        }
        this.#contributions.set(bundle.type, {
            bundle,
            contribution: contribution as unknown as AnyContribution,
        });
    }

    /** The contributed component types, in catalog order. */
    get components(): readonly string[] {
        return uiComponents
            .map((bundle) => bundle.type)
            .filter((type) => this.#contributions.has(type));
    }

    /** What `show_ui` teaches about each contributed component. */
    prompts(): readonly { readonly bundle: UiBundle; readonly prompt: string }[] {
        return this.components.map((type) => {
            const { bundle, contribution } = this.#contributions.get(type)!;
            return { bundle, prompt: contribution.prompt };
        });
    }

    /** Whether showing these components needs an Auto review, as each module decides. */
    async shouldReview(
        ctx: Context,
        agentId: string,
        components: readonly ChatUiComponentInput[],
    ): Promise<boolean> {
        for (const component of components) {
            const served = this.#contributions.get(component.type);
            const review = served?.contribution.shouldReview;
            if (review === undefined || !Value.Check(served!.bundle.input, component.props))
                continue;
            if (await review(ctx, agentId, component.props as never)) return true;
        }
        return false;
    }

    /** Hear every attempt record whose outcome changed, after it committed. */
    onRecordUpdated(listener: ChatUiRecordListener): () => void {
        this.#recordListeners.add(listener);
        return () => this.#recordListeners.delete(listener);
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        const root = withAgentDatabase(detach(ctx).named("chat-ui"), ctx.db);
        this.#ctx = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        return {
            tools: (_hookCtx, scope) =>
                this.#contributions.size === 0 ? [] : [showUiTool(this, scope.agent.id)],
            // Notes nothing woke the conversation for join its next turn.
            beforeTurn: async (hookCtx, scope) => await this.#takeNotes(hookCtx, scope.agent.id),
        };
    };

    /**
     * Check and build a document from components a model or the daemon wrote: each against the
     * catalog, its bundle, and its module's checks, with every fallback computed here. Problems
     * are sentences a model can act on; nothing is stored.
     */
    async document(
        ctx: Context,
        agentId: string,
        components: readonly ChatUiComponentInput[],
    ): Promise<
        | { readonly document: UiDocument; readonly items: readonly HistoryMediaItem[] }
        | { readonly problems: readonly string[] }
    > {
        const problems: string[] = [];
        if (components.length < 1 || components.length > 16) {
            problems.push("Show 1 to 16 components.");
        }
        const built: UiComponent[] = [];
        const items: HistoryMediaItem[] = [];
        for (const component of components) {
            const served = this.#contributions.get(component.type);
            if (served === undefined) {
                problems.push(
                    `${component.id}: there is no "${component.type}" component here. Use one of ${this.components.join(", ")}.`,
                );
                continue;
            }
            const { bundle, contribution } = served;
            if (!Value.Check(bundle.input, component.props)) {
                const first = Value.Errors(bundle.input, component.props).First();
                problems.push(
                    `${component.id}: the ${component.type} props are invalid${first === undefined ? "" : ` at "${first.path || "/"}": ${first.message}`}.`,
                );
                continue;
            }
            let props: unknown = component.props;
            if (contribution.prepare !== undefined) {
                const prepared = await contribution.prepare(ctx, agentId, component.props as never);
                if ("problems" in prepared) {
                    problems.push(...prepared.problems.map((line) => `${component.id}: ${line}`));
                    continue;
                }
                // Media indexes count across the whole document, in the order shown.
                const offset = items.length;
                props = shiftMediaIndexes(prepared.props, offset);
                items.push(...(prepared.items ?? []));
            }
            const own = uiPropsProblems({ type: component.type, props });
            if (own.length > 0) {
                problems.push(...own.map((line) => `${component.id}: ${line}`));
                continue;
            }
            const checked = (await contribution.check?.(ctx, props as never)) ?? [];
            if (checked.length > 0) {
                problems.push(...checked.map((line) => `${component.id}: ${line}`));
                continue;
            }
            built.push({
                id: component.id,
                type: component.type,
                fallback: clip(oneLine(contribution.fallback(props as never)), MAX_FALLBACK),
                props,
            } as UiComponent);
        }
        if (problems.length === 0) problems.push(...uiDocumentProblems(built));
        if (items.length > 12) problems.push("A document shows at most 12 images.");
        if (problems.length > 0) return { problems };
        return { document: { id: createId(), components: built }, items };
    }

    /**
     * Write a document the daemon composed itself, with no model, as an agent message: `text`
     * first when given, then the `ui` block. The message joins `runId` when given, as onboarding's
     * scripted messages do. A document that fails its checks throws: the daemon wrote it wrong.
     */
    async post(
        ctx: Context,
        agentId: string,
        input: {
            readonly recordId?: string;
            readonly runId?: string;
            readonly text?: string;
            readonly components: readonly ChatUiComponentInput[];
        },
    ): Promise<HistoryMessage> {
        const built = await this.document(ctx, agentId, input.components);
        if ("problems" in built) {
            throw new Error(`The daemon wrote an invalid document: ${built.problems.join(" ")}`);
        }
        if (built.items.length > 0) throw new Error("A daemon-written document carries no media.");
        const recordId = input.recordId ?? createId();
        await this.#history.record(ctx, agentId, {
            role: "assistant",
            recordId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            blocks: [
                ...(input.text === undefined || input.text.trim() === ""
                    ? []
                    : [{ type: "text" as const, text: input.text }]),
                { type: "ui", ui: built.document },
            ],
            at: Date.now(),
        });
        const message = await this.#history.message(ctx, agentId, recordId);
        if (message === undefined) throw new Error("The daemon's document was not recorded.");
        return message;
    }

    /**
     * Leave a sentence about server state for the conversation's model, in the caller's
     * transaction. It joins the next turn; with `wake`, a turn starts for it now, on the
     * conversation's last mode, together with every other waiting note.
     */
    async note(ctx: Context, agentId: string, text: string, wake = false): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await insertChatUiNote(txCtx, agentId, createId(), text, Date.now());
            if (wake) await this.#wake(txCtx, agentId);
        });
    }

    /**
     * One click, after the route authenticated the caller and found they can read the
     * conversation: permission, idempotency, the stored offer, the payload, the open-offer rule,
     * and the rate limit, then the attempt record, the hook, and its outcome. Throws
     * {@link ChatUiActionError} for a refusal, which stores nothing.
     */
    async act(ctx: Context, input: ChatUiActionInput): Promise<ChatUiActionResult> {
        // One component's clicks are taken one at a time, so two never both answer a `once` offer.
        const key = [input.agentId, input.request.uiId, input.request.componentId].join("\u0000");
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const run = previous.then(async () => await this.#act(ctx, input));
        const tail = run.then(
            () => undefined,
            () => undefined,
        );
        this.#queues.set(key, tail);
        try {
            return await run;
        } finally {
            if (this.#queues.get(key) === tail) this.#queues.delete(key);
        }
    }

    /**
     * The stored offer an action names, checked against the click: the component the message
     * holds, the action's declared permission or a guest's guest-safe limit, the payload, and
     * whether the offer is still open. Throws {@link ChatUiActionError} for a refusal. A request already stored under its `id` is
     * returned as `existing` once the permission check passes, before the offer must still exist.
     */
    async resolveOffer(
        ctx: Context,
        input: ChatUiActionInput,
    ): Promise<
        | { readonly existing: ChatUiAttempt }
        | {
              readonly existing?: undefined;
              readonly offer: NonNullable<ReturnType<typeof findOffer>>;
              readonly served: {
                  readonly bundle: UiBundle;
                  readonly contribution: AnyContribution;
              };
              readonly found: NonNullable<ReturnType<typeof uiActionDefinition>>;
              /** The payload with its secrets left out, as it is stored. */
              readonly payload: Record<string, unknown>;
              readonly once: boolean;
              /** The accepted attempt that already answered this `once` offer. */
              readonly accepted: ChatUiAttempt | undefined;
              /** The person's message after the offer, when there is one. */
              readonly answered: string | undefined;
              readonly state: ReturnType<typeof uiOfferState>;
          }
    > {
        const { agentId, request, person } = input;
        const offerMessage = await this.#history.message(ctx, agentId, request.messageId);
        const offer = findOffer(offerMessage, request.uiId, request.componentId);
        const found = uiActionDefinition(request.action.type);
        const served =
            offer === undefined ? undefined : this.#contributions.get(offer.component.type);
        if (
            offer !== undefined &&
            found !== undefined &&
            found.bundle.type === offer.component.type
        ) {
            const needed = uiActionPermission(found.definition, offer.component.props);
            if (person.guest) {
                if (served?.contribution.guestSafe !== true) {
                    throw new ChatUiActionError(403, "forbidden", "Guests can't use this control.");
                }
            } else if (typeof needed === "string" && !person.granted.has(needed)) {
                throw new ChatUiActionError(
                    403,
                    "forbidden",
                    "You don't have permission to do that here.",
                );
            }
        }
        const existing = await queryChatUiAttempt(ctx, agentId, request.id);
        if (existing !== undefined) return { existing };
        if (offer === undefined || served === undefined) {
            throw new ChatUiActionError(404, "not_found", "No such offer is in this conversation.");
        }
        const problem = uiActionProblem(offer.component, request.action);
        if (problem !== undefined || found === undefined) {
            throw new ChatUiActionError(
                400,
                "invalid_request",
                problem ?? "That action is invalid.",
            );
        }
        const payload = redactUiValue(found.definition.payload, request.action.payload) as Record<
            string,
            unknown
        >;
        const once = found.definition.once === true;
        const accepted = once
            ? await queryAcceptedOnceAttempt(ctx, agentId, request.uiId, request.componentId)
            : undefined;
        const answered = await this.#history.personMessageAfter(ctx, agentId, request.messageId);
        const state = uiOfferState(
            {
                once,
                accepted:
                    accepted === undefined
                        ? undefined
                        : { type: accepted.actionType, payload: accepted.payload },
                personSpokeAfter: answered !== undefined,
            },
            { type: request.action.type, payload },
        );
        return { offer, served, found, payload, once, accepted, answered, state };
    }

    async #act(ctx: Context, input: ChatUiActionInput): Promise<ChatUiActionResult> {
        const { agentId, request, person } = input;
        const resolved = await this.resolveOffer(ctx, input);
        if (resolved.existing !== undefined) return await this.#replay(ctx, resolved.existing);
        const { offer, served, found, payload, once, accepted, answered, state } = resolved;
        const words =
            found.definition.transcript === "message"
                ? uiActionText(offer.component, request.action)
                : undefined;
        const mode = found.definition.transcript === "message" ? this.#mode(request) : undefined;
        if (state === "repeat" && accepted !== undefined) return await this.#replay(ctx, accepted);
        const recent = await countChatUiAttempts(
            ctx,
            agentId,
            request.uiId,
            request.componentId,
            Date.now() - RATE_WINDOW_MS,
        );
        if (recent >= RATE_LIMIT) {
            throw new ChatUiActionError(
                429,
                "rate_limited",
                "Too many actions on this control. Wait a minute and try again.",
            );
        }
        const attempt: ChatUiAttempt = {
            agentId,
            id: request.id,
            messageId: request.messageId,
            uiId: request.uiId,
            componentId: request.componentId,
            actionType: request.action.type,
            once,
            payload,
            status: "pending",
            personMessageId: null,
            createdAt: Date.now(),
        };
        if (state === "closed") {
            const winner = accepted?.personMessageId ?? answered;
            const record = await ctx.inTx(async (txCtx) => {
                const record = this.#record(attempt, {
                    status: "rejected",
                    code: "offer_closed",
                    reason: "This was already answered.",
                    ...(winner == null ? {} : { messageId: winner }),
                });
                await insertChatUiAttempt(txCtx, { ...attempt, status: "rejected" });
                await this.#history.recordStandalone(txCtx, agentId, record, createId());
                return record;
            });
            return { record, message: null, result: null };
        }
        const key = attemptKey(agentId, request.id);
        let settle!: () => void;
        this.#inFlight.set(key, new Promise<void>((resolve) => (settle = resolve)));
        try {
            const pending = this.#record(attempt, { status: "pending" });
            await ctx.inTx(async (txCtx) => {
                await insertChatUiAttempt(txCtx, attempt);
                await this.#history.recordStandalone(txCtx, agentId, pending, createId());
                await this.#durable.invoke(txCtx, {
                    function: ATTEMPT_FUNCTION,
                    arguments: { agentId, id: request.id },
                });
            });
            const outcome = await this.#runHook(ctx, served, {
                agentId,
                messageId: request.messageId,
                uiId: request.uiId,
                componentId: request.componentId,
                props: offer.component.props,
                userId: person.userId,
                name: found.name,
                payload: request.action.payload,
                actionType: request.action.type,
            });
            return await ctx.inTx(async (txCtx) => {
                const stored = await this.#history.message(txCtx, agentId, request.id);
                const record = stored ?? pending;
                if (outcome.status !== "accepted") {
                    return {
                        record: await this.#settle(txCtx, attempt, record, outcome.status, null, {
                            status: outcome.status,
                            ...(outcome.code === undefined ? {} : { code: outcome.code }),
                            reason: outcome.reason,
                        }),
                        message: null,
                        result: null,
                    };
                }
                const message =
                    words === undefined || mode === undefined
                        ? null
                        : await this.#say(txCtx, attempt, words, mode, person.userId);
                if (outcome.note !== undefined) {
                    await insertChatUiNote(txCtx, agentId, createId(), outcome.note, Date.now());
                }
                if (outcome.wake === true) await this.#wake(txCtx, agentId);
                return {
                    record: await this.#settle(
                        txCtx,
                        attempt,
                        record,
                        "accepted",
                        message?.id ?? null,
                        {
                            status: "accepted",
                            ...(message === null ? {} : { messageId: message.id }),
                        },
                    ),
                    message,
                    result: outcome.result ?? null,
                };
            });
        } finally {
            settle();
            this.#inFlight.delete(key);
        }
    }

    /** The service record of an attempt with one outcome. */
    #record(attempt: ChatUiAttempt, outcome: UiActionOutcome): HistoryMessage {
        const block: UiActionBlock = {
            type: "action",
            messageId: attempt.messageId,
            uiId: attempt.uiId,
            componentId: attempt.componentId,
            action: { type: attempt.actionType, payload: attempt.payload },
            outcome,
        };
        return {
            role: "service",
            recordId: attempt.id,
            blocks: [block],
            at: attempt.createdAt,
        };
    }

    /** Store an outcome on the attempt and its record, announced once it commits. */
    async #settle(
        ctx: Context,
        attempt: ChatUiAttempt,
        stored: HistoryMessage,
        status: ChatUiAttemptStatus,
        personMessageId: string | null,
        outcome: UiActionOutcome,
    ): Promise<HistoryMessage> {
        const record: HistoryMessage = {
            ...stored,
            blocks: [{ ...this.#record(attempt, outcome).blocks[0]! }],
        };
        await settleChatUiAttempt(ctx, attempt.agentId, attempt.id, status, personMessageId);
        await this.#history.replace(ctx, attempt.agentId, record);
        afterCommit(ctx, () => {
            for (const listener of this.#recordListeners) {
                try {
                    listener(attempt.agentId, structuredClone(record));
                } catch (error: unknown) {
                    ctx.log.warn("A chat UI record listener failed.", {}, error);
                }
            }
        });
        return record;
    }

    /**
     * The person's words for an accepted `"message"` action: a user message holding the words and
     * the action block, entering the conversation as a sent message does, in this transaction.
     */
    async #say(
        ctx: Context,
        attempt: ChatUiAttempt,
        words: string,
        mode: HistoryPendingMessage["mode"],
        userId: string | undefined,
    ): Promise<HistoryPendingMessage> {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The chat UI module has not started.");
        const id = createId();
        const pending: HistoryPendingMessage = {
            id,
            agentId: attempt.agentId,
            role: "user",
            status: "pending",
            delivery: "queue",
            createdAt: Date.now(),
            blocks: [
                { type: "text", text: words },
                this.#record(attempt, { status: "accepted" }).blocks[0]!,
            ],
            ...(userId === undefined ? {} : { userId }),
            mode,
            runId: null,
        };
        await this.#history.queuePending(ctx, pending);
        await agents.send(
            ctx,
            attempt.agentId,
            { role: "user", content: [{ type: "text", text: words }] },
            {
                id,
                provider: mode.providerId,
                model: mode.modelId,
                effort: mode.effort as never,
                serviceTier: mode.serviceTier,
                permissionMode: mode.permissionMode,
                metadata: {
                    ...USER_MESSAGE_ORIGIN_METADATA,
                    ...(userId === undefined ? {} : { userId }),
                    mode,
                },
            },
        );
        return pending;
    }

    /** A stored attempt as it stands, with the person's message it became. */
    async #replay(ctx: Context, attempt: ChatUiAttempt): Promise<ChatUiActionResult> {
        const record = await this.#history.message(ctx, attempt.agentId, attempt.id);
        if (record === undefined) throw new Error("A chat UI attempt lost its record.");
        const personId = attempt.personMessageId;
        const message =
            personId === null
                ? null
                : ((await this.#history.message(ctx, attempt.agentId, personId)) ??
                  (await this.#history.pending(ctx, attempt.agentId)).find(
                      (pending) => pending.id === personId,
                  ) ??
                  null);
        return { record, message, result: null };
    }

    /** The hook, bounded to 15 seconds; a throw or a timeout fails the attempt. */
    async #runHook(
        ctx: Context,
        served: { readonly bundle: UiBundle; readonly contribution: AnyContribution },
        call: {
            readonly agentId: string;
            readonly messageId: string;
            readonly uiId: string;
            readonly componentId: string;
            readonly props: unknown;
            readonly userId: string | undefined;
            readonly name: string;
            readonly payload: Record<string, unknown>;
            readonly actionType: string;
        },
    ): Promise<AnyOutcome> {
        const hook = (
            served.contribution.actions as Record<
                string,
                (
                    ctx: Context,
                    offer: unknown,
                    payload: unknown,
                ) => Promise<ChatUiOutcome<UiBundle, string>>
            >
        )[call.name];
        if (hook === undefined)
            return { status: "failed", reason: "That control does nothing here." };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<AnyOutcome>((resolve) => {
            timer = setTimeout(
                () =>
                    resolve({
                        status: "failed",
                        code: "timeout",
                        reason: "That took too long. Try again.",
                    }),
                HOOK_TIMEOUT_MS,
            );
            timer.unref?.();
        });
        const run = (async (): Promise<AnyOutcome> => {
            try {
                return (await hook(
                    ctx,
                    {
                        agentId: call.agentId,
                        messageId: call.messageId,
                        uiId: call.uiId,
                        componentId: call.componentId,
                        props: call.props,
                        userId: call.userId,
                    },
                    call.payload,
                )) as AnyOutcome;
            } catch (error: unknown) {
                // The error may describe the request; only its kind is logged.
                ctx.log.warn("A chat UI hook failed.", {
                    actionType: call.actionType,
                    error: error instanceof Error ? error.name : typeof error,
                });
                return { status: "failed", reason: "Something went wrong. Try again." };
            }
        })();
        try {
            return await Promise.race([run, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** A `"message"` action's mode, checked against the live model catalog. */
    #mode(request: UiActionRequest): HistoryPendingMessage["mode"] {
        const mode = request.mode;
        if (mode === undefined) {
            throw new ChatUiActionError(400, "invalid_request", "This action needs a mode.");
        }
        const model = this.#config.models.find(
            (candidate) =>
                candidate.providerId === mode.providerId && candidate.id === mode.modelId,
        );
        if (
            model === undefined ||
            !model.effortLevels.some((effort) => effort === mode.effort) ||
            (mode.serviceTier !== null &&
                !model.serviceTiers?.some((tier) => tier === mode.serviceTier))
        ) {
            throw new ChatUiActionError(
                400,
                "invalid_request",
                "The selected provider, model, effort, or service tier is unavailable.",
            );
        }
        return {
            providerId: mode.providerId,
            modelId: mode.modelId,
            effort: mode.effort,
            serviceTier: mode.serviceTier,
            permissionMode: mode.permissionMode,
        };
    }

    /** Start a turn for every waiting note, on the conversation's last mode, in this transaction. */
    async #wake(ctx: Context, agentId: string): Promise<void> {
        const agents = this.#agents;
        if (agents === undefined) return;
        const notes = await takeChatUiNotes(ctx, agentId);
        if (notes.length === 0) return;
        const config = await agents.config(ctx, agentId);
        const last: unknown = config?.metadata?.["lastMode"];
        const mode = Value.Check(messageModeSchema, last) ? last : undefined;
        await agents.send(
            ctx,
            agentId,
            { role: "system", content: [{ type: "text", text: noteText(notes) }] },
            {
                id: createId(),
                metadata: { hideFromUser: true, chatUi: { note: true } },
                ...(mode === undefined
                    ? {}
                    : {
                          provider: mode.providerId,
                          model: mode.modelId,
                          effort: mode.effort as never,
                          serviceTier: mode.serviceTier,
                          permissionMode: mode.permissionMode,
                      }),
            },
        );
    }

    async #takeNotes(
        ctx: Context,
        agentId: string,
    ): Promise<readonly AgentModuleAction[] | undefined> {
        const notes = await ctx.inTx(async (txCtx) => await takeChatUiNotes(txCtx, agentId));
        if (notes.length === 0) return undefined;
        return [
            {
                type: "inject",
                message: { role: "system", content: [{ type: "text", text: noteText(notes) }] },
            },
        ];
    }

    /** An attempt the daemon stopped in the middle of fails as interrupted. */
    async #interrupted(ctx: Context, agentId: string, id: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const attempt = await queryChatUiAttempt(txCtx, agentId, id);
            if (attempt?.status !== "pending") return;
            const stored = await this.#history.message(txCtx, agentId, id);
            if (stored === undefined) return;
            await this.#settle(txCtx, attempt, stored, "failed", null, {
                status: "failed",
                code: "interrupted",
                reason: "Happy restarted before this finished. Try again.",
            });
        });
    }

    /** The module's own context, for work no request owns. */
    context(): Context {
        if (this.#ctx === undefined) throw new Error("The chat UI module has not started.");
        return this.#ctx;
    }
}

function attemptKey(agentId: string, id: string): string {
    return `${agentId}\u0000${id}`;
}

/** Notes as the model reads them: hidden context from the server, never the person. */
function noteText(notes: readonly string[]): string {
    return `<happy-note>\n${notes.join("\n")}\n</happy-note>`;
}

function oneLine(text: string): string {
    return text
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `images` props name media by index; a document's later components count after earlier ones. */
function shiftMediaIndexes(props: unknown, offset: number): unknown {
    if (offset === 0 || typeof props !== "object" || props === null) return props;
    const record = props as Record<string, unknown>;
    if (!Array.isArray(record["images"])) return props;
    return {
        ...record,
        images: (record["images"] as Record<string, unknown>[]).map((image) => ({
            ...image,
            mediaIndex: (image["mediaIndex"] as number) + offset,
        })),
    };
}
