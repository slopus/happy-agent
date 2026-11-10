import { createId } from "@paralleldrive/cuid2";
import {
    withAgentDatabase,
    type AgentModule,
    type AgentModuleAction,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    MAX_UI_MEDIA,
    messageModeSchema,
    quickRepliesProblems,
    redactUiValue,
    replyComponents,
    replyUiProblems,
    splitQuickReplies,
    uiActionDefinition,
    uiActionPermission,
    uiActionProblem,
    uiComponents,
    uiDocumentProblems,
    uiPropsProblems,
    type QuickReply,
    type QuickReplyInput,
    type ReplyBundle,
    type ReplyUi,
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
    type HistoryBlock,
    type HistoryMediaItem,
    type HistoryMessage,
} from "../history/index.js";
import { ChatUiActionError } from "./ChatUiActionError.js";
import type {
    ChatUiContribution,
    ChatUiOutcome,
    ChatUiReplyContribution,
} from "./ChatUiContribution.js";
import { chatUiMigrations } from "./ChatUiMigrations.js";
import { contributeBasicComponents } from "./impl/basicComponents.js";
import {
    countChatUiAttempts,
    insertChatUiAttempt,
    insertChatUiNote,
    queryChatUiAttempt,
    settleChatUiAttempt,
    takeChatUiNotes,
    type ChatUiAttempt,
    type ChatUiAttemptStatus,
} from "./impl/chatUiAttempts.js";
import { findOffer } from "./impl/findOffer.js";
import { showUiTool } from "./tools/show_ui.js";
import { suggestRepliesTool } from "./tools/suggest_replies.js";

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

/** What an action left: its record and its result. */
export interface ChatUiActionResult {
    readonly record: HistoryMessage;
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
 * handed to the contributing module's hook, whose outcome is applied in one transaction. It also
 * owns quick replies: the `suggest_replies` tool and the check a `send` naming one passes. See
 * "Chat UI" and "Quick replies" in API.md and this module's README.
 */
export class ChatUiModule implements AgentModule {
    readonly name = "chat-ui";
    readonly migrations = chatUiMigrations;

    readonly #history: HistoryModule;
    readonly #durable: DurableFunctionsModule;
    readonly #contributions = new Map<
        string,
        { readonly bundle: UiBundle; readonly contribution: AnyContribution }
    >();
    readonly #replyContributions = new Map<
        string,
        {
            readonly bundle: ReplyBundle;
            readonly contribution: ChatUiReplyContribution<ReplyBundle>;
        }
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

    /**
     * Serve one reply component: `suggest_replies` accepts it on an option and teaches it, and
     * `capabilities.chatUi.replies` lists it. Called once per type, at construction.
     */
    contributeReply<B extends ReplyBundle>(
        bundle: B,
        contribution: ChatUiReplyContribution<B>,
    ): void {
        if (this.#replyContributions.has(bundle.type)) {
            throw new Error(`The "${bundle.type}" reply component is already contributed.`);
        }
        if (!replyComponents.some((known) => known.type === bundle.type)) {
            throw new Error(`"${bundle.type}" is not in the reply catalog.`);
        }
        this.#replyContributions.set(bundle.type, {
            bundle,
            contribution: contribution as unknown as ChatUiReplyContribution<ReplyBundle>,
        });
    }

    /** The contributed reply component types, in catalog order. */
    get replyComponents(): readonly string[] {
        return replyComponents
            .map((bundle) => bundle.type)
            .filter((type) => this.#replyContributions.has(type));
    }

    /** What `suggest_replies` teaches about each contributed reply component. */
    replyPrompts(): readonly { readonly bundle: ReplyBundle; readonly prompt: string }[] {
        return this.replyComponents.map((type) => {
            const { bundle, contribution } = this.#replyContributions.get(type)!;
            return { bundle, prompt: contribution.prompt };
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
                this.#contributions.size === 0
                    ? []
                    : [showUiTool(this, scope.agent.id), suggestRepliesTool(this)],
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
            let own: readonly HistoryMediaItem[] = [];
            if (contribution.prepare !== undefined) {
                const prepared = await contribution.prepare(ctx, agentId, component.props as never);
                if ("problems" in prepared) {
                    problems.push(...prepared.problems.map((line) => `${component.id}: ${line}`));
                    continue;
                }
                // Media indexes count across the whole document, in the order shown.
                const offset = items.length;
                props = shiftMediaIndexes(prepared.props, offset);
                own = prepared.items ?? [];
                items.push(...own);
            }
            const invalid = uiPropsProblems({ type: component.type, props });
            if (invalid.length > 0) {
                problems.push(...invalid.map((line) => `${component.id}: ${line}`));
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
                fallback: clip(oneLine(contribution.fallback(props as never, own)), MAX_FALLBACK),
                props,
            } as UiComponent);
        }
        if (problems.length === 0) problems.push(...uiDocumentProblems(built));
        if (items.length > MAX_UI_MEDIA) {
            problems.push(`A document shows at most ${String(MAX_UI_MEDIA)} media items.`);
        }
        if (problems.length > 0) return { problems };
        return { document: { id: createId(), components: built }, items };
    }

    /**
     * Write a message the daemon composed itself, with no model, as an agent message: `text` first
     * when given, then the `ui` block of `components`, then the `quick_replies` block of
     * `replies`. The message joins `runId` when given, as onboarding's scripted messages do. A
     * document or replies that fail their checks throw: the daemon wrote them wrong.
     */
    async post(
        ctx: Context,
        agentId: string,
        input: {
            readonly recordId?: string;
            readonly runId?: string;
            readonly text?: string;
            readonly components?: readonly ChatUiComponentInput[];
            readonly replies?: readonly QuickReplyInput[];
        },
    ): Promise<HistoryMessage> {
        const blocks: HistoryBlock[] = [];
        if (input.text !== undefined && input.text.trim() !== "") {
            blocks.push({ type: "text", text: input.text });
        }
        if (input.components !== undefined) {
            const built = await this.document(ctx, agentId, input.components);
            if ("problems" in built) {
                throw new Error(
                    `The daemon wrote an invalid document: ${built.problems.join(" ")}`,
                );
            }
            if (built.items.length > 0) {
                throw new Error("A daemon-written document carries no media.");
            }
            blocks.push({ type: "ui", ui: built.document });
        }
        if (input.replies !== undefined) {
            const replies = await this.replies(ctx, input.replies);
            if ("problems" in replies) {
                throw new Error(`The daemon wrote invalid replies: ${replies.problems.join(" ")}`);
            }
            blocks.push({ type: "quick_replies", ...replies.stored });
        }
        if (blocks.length === 0) throw new Error("The daemon wrote an empty message.");
        const recordId = input.recordId ?? createId();
        await this.#history.record(ctx, agentId, {
            role: "assistant",
            recordId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            blocks,
            at: Date.now(),
        });
        const message = await this.#history.message(ctx, agentId, recordId);
        if (message === undefined) throw new Error("The daemon's document was not recorded.");
        return message;
    }

    /**
     * Suggested replies as they are stored, or the problems a model can act on: the options
     * normalized and checked, and each option's reply component checked against the catalog, this
     * server's contributions, and the contributing module's own checks.
     */
    async replies(
        ctx: Context,
        inputs: readonly QuickReplyInput[],
    ): Promise<
        | { readonly stored: { readonly options: string[]; readonly ui?: (ReplyUi | null)[] } }
        | { readonly problems: readonly string[] }
    > {
        const { options, ui } = splitQuickReplies(inputs);
        const problems = quickRepliesProblems(options);
        if (ui === undefined) return problems.length > 0 ? { problems } : { stored: { options } };
        for (const [index, item] of ui.entries()) {
            if (item === null) continue;
            const served = this.#replyContributions.get(item.type);
            if (served === undefined) {
                problems.push(
                    this.replyComponents.length === 0
                        ? `Reply ${index + 1}: options take no ui here.`
                        : `Reply ${index + 1}: there is no "${item.type}" reply ui here. Use one of ${this.replyComponents.join(", ")}.`,
                );
                continue;
            }
            const invalid = replyUiProblems(item);
            if (invalid.length > 0) {
                problems.push(...invalid.map((line) => `Reply ${index + 1}: ${line}`));
                continue;
            }
            const checked = (await served.contribution.check?.(ctx, item.props as never)) ?? [];
            problems.push(...checked.map((line) => `Reply ${index + 1}: ${line}`));
        }
        if (problems.length > 0) return { problems };
        return { stored: { options, ui: ui as (ReplyUi | null)[] } };
    }

    /**
     * Why a `send` naming a quick reply does not hold, or undefined when it does: the message must
     * be a visible agent message of this conversation holding the named suggestion, with an option
     * at `index` that equals `text` exactly. Nothing else is checked; see "Quick replies".
     */
    async quickReplyProblem(
        ctx: Context,
        agentId: string,
        quickReply: QuickReply,
        text: string,
    ): Promise<string | undefined> {
        const message = await this.#history.message(ctx, agentId, quickReply.messageId);
        if (
            message === undefined ||
            (message.role !== "assistant" && message.role !== "agent") ||
            message.hideFromUser === true
        ) {
            return "That suggestion isn't in this conversation.";
        }
        const options = suggestedOptions(message, quickReply.toolCallId);
        if (options === undefined) return "That message has no such suggestion.";
        const option = options[quickReply.index];
        if (option === undefined) return "That suggestion has no such option.";
        if (option !== text) return "The text must be the suggested reply exactly.";
        return undefined;
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
     * conversation: permission, idempotency, the stored offer, the payload, and the rate limit,
     * then the attempt record, the hook, and its outcome. Throws {@link ChatUiActionError} for a
     * refusal, which stores nothing.
     */
    async act(ctx: Context, input: ChatUiActionInput): Promise<ChatUiActionResult> {
        // One component's clicks are taken one at a time, so a retried ID and the rate limit are
        // read against what the click before it stored.
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
     * holds, the action's declared permission or a guest's guest-safe limit, and the payload.
     * Throws {@link ChatUiActionError} for a refusal. A request already stored under its `id` is
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
        return { offer, served, found, payload };
    }

    async #act(ctx: Context, input: ChatUiActionInput): Promise<ChatUiActionResult> {
        const { agentId, request, person } = input;
        const resolved = await this.resolveOffer(ctx, input);
        if (resolved.existing !== undefined) return await this.#replay(ctx, resolved.existing);
        const { offer, served, found, payload } = resolved;
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
            payload,
            status: "pending",
            createdAt: Date.now(),
        };
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
                        record: await this.#settle(txCtx, attempt, record, outcome.status, {
                            status: outcome.status,
                            ...(outcome.code === undefined ? {} : { code: outcome.code }),
                            reason: outcome.reason,
                        }),
                        result: null,
                    };
                }
                if (outcome.note !== undefined) {
                    await insertChatUiNote(txCtx, agentId, createId(), outcome.note, Date.now());
                }
                if (outcome.wake === true) await this.#wake(txCtx, agentId);
                return {
                    record: await this.#settle(txCtx, attempt, record, "accepted", {
                        status: "accepted",
                    }),
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
        outcome: UiActionOutcome,
    ): Promise<HistoryMessage> {
        const record: HistoryMessage = {
            ...stored,
            blocks: [{ ...this.#record(attempt, outcome).blocks[0]! }],
        };
        await settleChatUiAttempt(ctx, attempt.agentId, attempt.id, status);
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

    /** A stored attempt as it stands. */
    async #replay(ctx: Context, attempt: ChatUiAttempt): Promise<ChatUiActionResult> {
        const record = await this.#history.message(ctx, attempt.agentId, attempt.id);
        if (record === undefined) throw new Error("A chat UI attempt lost its record.");
        return { record, result: null };
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
            await this.#settle(txCtx, attempt, stored, "failed", {
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

/**
 * The options of one suggestion in an agent message: the `suggest_replies` call `toolCallId`
 * names, or the message's own `quick_replies` block when it names none.
 */
function suggestedOptions(
    message: HistoryMessage,
    toolCallId: string | undefined,
): readonly string[] | undefined {
    for (const block of message.blocks) {
        if (toolCallId === undefined) {
            if (block.type === "quick_replies") return block.options;
        } else if (
            block.type === "tool_result" &&
            block.callId === toolCallId &&
            block.isError !== true &&
            block.presentation?.type === "quick_replies"
        ) {
            return block.presentation.options;
        }
    }
    return undefined;
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

/** `media` props name items by index; a document's later components count after earlier ones. */
function shiftMediaIndexes(props: unknown, offset: number): unknown {
    if (offset === 0 || typeof props !== "object" || props === null) return props;
    const record = props as Record<string, unknown>;
    if (!Array.isArray(record["items"])) return props;
    return {
        ...record,
        items: (record["items"] as Record<string, unknown>[]).map((item) => ({
            ...item,
            mediaIndex: (item["mediaIndex"] as number) + offset,
        })),
    };
}
