import { createId } from "@paralleldrive/cuid2";
import type {
    AgentModule,
    AgentModuleAction,
    AgentModuleHooks,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    MAX_UI_MEDIA,
    normalizeQuickReply,
    quickRepliesProblems,
    redactUiValue,
    uiActionDefinition,
    uiActionPermission,
    uiActionProblem,
    uiBundle,
    uiDocumentProblems,
    uiDocumentSchema,
    uiPropsProblems,
    type QuickReply,
    type UiActionBlock,
    type UiActionDefinition,
    type UiActionOutcome,
    type UiActionRequest,
    type UiBundle,
    type UiDocument,
    type UiPermissionId,
    type UiWireComponent,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import {
    HistoryModule,
    historyRecordIdSchema,
    type HistoryBlock,
    type HistoryMediaItem,
    type HistoryMessage,
} from "../history/index.js";
import { agentDeliveryMode } from "../impl/agentDeliveryMode.js";
import { ChatUiActionError } from "./ChatUiActionError.js";
import type { ChatUiContribution } from "./ChatUiContribution.js";
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
} from "./impl/chatUiAttempts.js";
import { findOffer } from "./impl/findOffer.js";
import { findSuggestion } from "./impl/findSuggestion.js";
import { personAnswersAgent } from "./impl/personAnswersAgent.js";
import { showUiTool } from "./tools/show_ui.js";
import { suggestRepliesTool } from "./tools/suggest_replies.js";

/** How long a hook may take before its attempt fails with `timeout`. */
const HOOK_TIMEOUT_MS = 15_000;
/** Actions per minute one component of one conversation takes. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** Follows each attempt, so one the daemon stopped in the middle of is failed when it starts. */
const ATTEMPT_FUNCTION = "chat-ui.attempt";
/** The limits an outcome's `code`, its `reason`, and a fallback line are stored within. */
const MAX_CODE = 64;
const MAX_REASON = 500;
const MAX_FALLBACK = 500;

const attemptArgumentsSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1, maxLength: 256 }),
        id: Type.String({ minLength: 1, maxLength: 96 }),
    },
    { additionalProperties: false },
);

/** What a hook may return; anything else fails the attempt. */
const hookOutcomeSchema = Type.Union([
    Type.Object({
        status: Type.Literal("accepted"),
        note: Type.Optional(Type.String()),
        wake: Type.Optional(Type.Boolean()),
        result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    Type.Object({
        status: Type.Literal("rejected"),
        code: Type.String(),
        reason: Type.String(),
    }),
]);
type HookOutcome =
    | Static<typeof hookOutcomeSchema>
    | { readonly status: "failed"; readonly code?: string; readonly reason: string };

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
interface Served {
    readonly bundle: UiBundle;
    readonly contribution: AnyContribution;
}
type AnyHook = (ctx: Context, offer: unknown, payload: unknown) => Promise<unknown>;

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

    readonly #config: ConfigModule;
    readonly #history: HistoryModule;
    readonly #durable: DurableFunctionsModule;
    /** Every served component by type, in the order contributed. */
    readonly #served = new Map<string, Served>();
    /** Attempts whose hook runs in this process, so the follow-up call waits for them. */
    readonly #inFlight = new Map<string, Promise<void>>();
    readonly #recordListeners = new Set<ChatUiRecordListener>();
    /** One component's clicks, taken one at a time. */
    readonly #queues = new Map<string, Promise<void>>();
    #agents: AgentSystemRef | undefined;

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
                await this.#inFlight.get(attemptKey(agentId, id));
                // Whatever is still pending now has no hook left to settle it.
                await this.#interrupted(ctx, agentId, id);
                return null;
            },
        });
    }

    /**
     * Serve one component: `show_ui` accepts it, `capabilities.chatUi` lists it, and `/actions`
     * hands its actions to these hooks. Called once per type, while modules are constructed. A
     * type the client catalog defines must be served with the catalog's own bundle, so the server
     * and every client hold one contract.
     */
    contribute<B extends UiBundle>(bundle: B, contribution: ChatUiContribution<B>): void {
        if (this.#served.has(bundle.type)) {
            throw new Error(`The "${bundle.type}" component is already contributed.`);
        }
        const known = uiBundle(bundle.type);
        if (known !== undefined && known !== bundle) {
            throw new Error(`"${bundle.type}" must be served with the catalog's bundle.`);
        }
        for (const name of Object.keys(bundle.actions)) {
            if (typeof (contribution.actions as Record<string, unknown>)[name] !== "function") {
                throw new Error(`The "${bundle.type}.${name}" action has no hook.`);
            }
        }
        this.#served.set(bundle.type, {
            bundle,
            contribution: contribution as unknown as AnyContribution,
        });
    }

    /** The served component types, in the order contributed. */
    get components(): readonly string[] {
        return [...this.#served.keys()];
    }

    /** What `show_ui` teaches about each served component. */
    prompts(): readonly { readonly bundle: UiBundle; readonly prompt: string }[] {
        return [...this.#served.values()].map(({ bundle, contribution }) => ({
            bundle,
            prompt: contribution.prompt,
        }));
    }

    /** Whether showing these components needs an Auto review, as each module decides. */
    async shouldReview(
        ctx: Context,
        agentId: string,
        components: readonly ChatUiComponentInput[],
    ): Promise<boolean> {
        for (const component of components) {
            const served = this.#served.get(component.type);
            const review = served?.contribution.shouldReview;
            if (review === undefined || !Value.Check(served!.bundle.input, component.props))
                continue;
            if (await review(ctx, agentId, component.props as never)) return true;
        }
        return false;
    }

    /** What an Auto reviewer is told a `show_ui` call of these component types does. */
    describeReview(types: readonly string[]): string {
        const access = [...new Set(types)].flatMap((type) => {
            const text = this.#served.get(type)?.contribution.reviewAccess;
            return text === undefined ? [] : [text];
        });
        return `showing chat UI (${types.join(", ")}) to the person in this chat${access.length === 0 ? "" : `. Access: ${access.join("; ")}`}`;
    }

    /** Hear every attempt record whose outcome changed, after it committed. */
    onRecordUpdated(listener: ChatUiRecordListener): () => void {
        this.#recordListeners.add(listener);
        return () => this.#recordListeners.delete(listener);
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            // The same two tools for every model, and none where no person could press or tap.
            tools: async (hookCtx, scope) =>
                (await personAnswersAgent(hookCtx, agents, scope.agent))
                    ? [showUiTool(this, scope.agent.id), suggestRepliesTool(this)]
                    : [],
            // Notes nothing woke the conversation for join its next turn.
            beforeTurn: async (hookCtx, scope) => await this.#takeNotes(hookCtx, scope.agent.id),
        };
    };

    /**
     * Check and build a document from components a model or the daemon wrote: each against its
     * bundle and its module's checks, with every fallback computed here. Problems are sentences a
     * model can act on; nothing is stored.
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
        const built: UiWireComponent[] = [];
        const items: HistoryMediaItem[] = [];
        for (const component of components) {
            const served = this.#served.get(component.type);
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
                const prepared = await contribution.prepare(
                    ctx,
                    agentId,
                    component.props as never,
                    items.length,
                );
                if ("problems" in prepared) {
                    problems.push(...prepared.problems.map((line) => `${component.id}: ${line}`));
                    continue;
                }
                props = prepared.props;
                own = prepared.items ?? [];
                items.push(...own);
            }
            const invalid = uiPropsProblems({ type: component.type, props }, this.#bundleOf);
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
                props: props as Record<string, unknown>,
            });
        }
        if (problems.length === 0) problems.push(...uiDocumentProblems(built, this.#bundleOf));
        if (items.length > MAX_UI_MEDIA) {
            problems.push(`A document shows at most ${String(MAX_UI_MEDIA)} media items.`);
        }
        if (problems.length > 0) return { problems };
        const document: UiDocument = { id: createId(), components: built };
        if (!Value.Check(uiDocumentSchema, document)) {
            return {
                problems: [
                    "Each component needs an ID that is a lowercase slug of 1 to 64 characters.",
                ],
            };
        }
        return { document, items };
    }

    /**
     * Write a message the daemon composed itself, with no model, as an agent message: `text` first
     * when given, then the `ui` block of `components`, then the `quick_replies` block of
     * `replies`. It joins the conversation's open run, or is stored in a finished run of its own
     * when none is open, and starts no turn. A document or replies that fail their checks throw:
     * the daemon wrote them wrong.
     */
    async post(
        ctx: Context,
        agentId: string,
        input: {
            readonly text?: string;
            readonly components?: readonly ChatUiComponentInput[];
            readonly replies?: readonly string[];
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
                throw new Error("Only a show_ui call carries media; a posted document has none.");
            }
            blocks.push({ type: "ui", ui: built.document });
        }
        if (input.replies !== undefined) {
            const replies = this.replies(input.replies);
            if ("problems" in replies) {
                throw new Error(`The daemon wrote invalid replies: ${replies.problems.join(" ")}`);
            }
            blocks.push({ type: "quick_replies", options: replies.options });
        }
        if (blocks.length === 0) throw new Error("The daemon wrote an empty message.");
        const posted: HistoryMessage = {
            role: "assistant",
            recordId: createId(),
            blocks,
            at: Date.now(),
        };
        return await ctx.inTx(async (txCtx) => {
            // History is read by run, so the message always has one: the run that is open, or a
            // finished run of its own.
            const open = await this.#history.runningRun(txCtx, agentId);
            if (open === undefined) {
                await this.#history.recordStandalone(txCtx, agentId, posted, createId());
            } else {
                await this.#history.record(txCtx, agentId, { ...posted, runId: open.id });
            }
            const message = await this.#history.message(txCtx, agentId, posted.recordId);
            if (message === undefined) throw new Error("The daemon's message was not recorded.");
            return message;
        });
    }

    /**
     * Suggested replies as they are stored, each with its whitespace collapsed, or the problems a
     * model can act on.
     */
    replies(
        options: readonly string[],
    ): { readonly options: string[] } | { readonly problems: readonly string[] } {
        const normalized = options.map(normalizeQuickReply);
        const problems = quickRepliesProblems(normalized);
        return problems.length > 0 ? { problems } : { options: normalized };
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
        const message = Value.Check(historyRecordIdSchema, quickReply.messageId)
            ? await this.#history.message(ctx, agentId, quickReply.messageId)
            : undefined;
        const options = findSuggestion(message, quickReply.toolCallId);
        if (options === undefined) return "That suggestion isn't in this conversation.";
        const option = options[quickReply.index];
        if (option === undefined) return "That suggestion has no such option.";
        if (option !== text) return "The text must be the suggested reply exactly.";
        return undefined;
    }

    /**
     * Leave a sentence about server state for the conversation's model, in the caller's
     * transaction. It joins the next turn; with `wake`, a turn starts for it now, together with
     * every other waiting note.
     */
    async note(ctx: Context, agentId: string, text: string, wake = false): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await insertChatUiNote(txCtx, agentId, text);
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

    readonly #bundleOf = (type: string): UiBundle | undefined => this.#served.get(type)?.bundle;

    /**
     * The stored offer an action names, checked against the click: the component the message
     * holds, the action's declared permission, and the payload. A request already stored under its
     * `id` is returned as `existing` once the permission check passes, before the offer must still
     * exist.
     */
    async #resolve(
        ctx: Context,
        input: ChatUiActionInput,
    ): Promise<
        | { readonly existing: ChatUiAttempt }
        | {
              readonly existing?: undefined;
              readonly component: UiWireComponent;
              readonly served: Served;
              /** The action's name in its bundle, and its definition. */
              readonly name: string;
              readonly definition: UiActionDefinition;
              /** The payload with its secrets left out, as it is stored. */
              readonly payload: Record<string, unknown>;
          }
    > {
        const { agentId, request, person } = input;
        const offerMessage = Value.Check(historyRecordIdSchema, request.messageId)
            ? await this.#history.message(ctx, agentId, request.messageId)
            : undefined;
        const offer = findOffer(offerMessage, request.uiId, request.componentId);
        const served = offer === undefined ? undefined : this.#served.get(offer.component.type);
        const found = uiActionDefinition(request.action.type, this.#bundleOf);
        if (
            offer !== undefined &&
            found !== undefined &&
            found.bundle.type === offer.component.type &&
            !person.granted.has(uiActionPermission(found.definition, offer.component.props))
        ) {
            throw new ChatUiActionError(
                403,
                "forbidden",
                "You don't have permission to do that here.",
            );
        }
        const existing = await queryChatUiAttempt(ctx, agentId, request.id);
        if (existing !== undefined) return { existing };
        if (
            (await this.#history.message(ctx, agentId, request.id)) !== undefined ||
            (await this.#history.pending(ctx, agentId)).some((message) => message.id === request.id)
        ) {
            throw new ChatUiActionError(409, "conflict", "The ID is already in use.");
        }
        if (offer === undefined || served === undefined) {
            throw new ChatUiActionError(404, "not_found", "No such offer is in this conversation.");
        }
        const problem = uiActionProblem(offer.component, request.action, this.#bundleOf);
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
        return {
            component: offer.component,
            served,
            name: found.name,
            definition: found.definition,
            payload,
        };
    }

    async #act(ctx: Context, input: ChatUiActionInput): Promise<ChatUiActionResult> {
        const { agentId, request, person } = input;
        const resolved = await this.#resolve(ctx, input);
        if (resolved.existing !== undefined) {
            const record = await this.#history.message(ctx, agentId, resolved.existing.id);
            if (record === undefined) throw new Error("A chat UI attempt lost its record.");
            return { record, result: null };
        }
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
            uiId: request.uiId,
            componentId: request.componentId,
            status: "pending",
            createdAt: Date.now(),
        };
        const pending: HistoryMessage = {
            role: "service",
            recordId: attempt.id,
            blocks: [
                {
                    type: "action",
                    messageId: request.messageId,
                    uiId: request.uiId,
                    componentId: request.componentId,
                    action: { type: request.action.type, payload: resolved.payload },
                    outcome: { status: "pending" },
                },
            ],
            at: attempt.createdAt,
        };
        const key = attemptKey(agentId, request.id);
        let finished!: () => void;
        this.#inFlight.set(key, new Promise<void>((resolve) => (finished = resolve)));
        try {
            await ctx.inTx(async (txCtx) => {
                await insertChatUiAttempt(txCtx, attempt);
                await this.#history.recordStandalone(txCtx, agentId, pending, createId());
                await this.#durable.invoke(txCtx, {
                    function: ATTEMPT_FUNCTION,
                    arguments: { agentId, id: request.id },
                });
            });
            const outcome = await this.#runHook(
                ctx,
                resolved.served.contribution.actions[resolved.name] as AnyHook | undefined,
                {
                    agentId,
                    messageId: request.messageId,
                    uiId: request.uiId,
                    componentId: request.componentId,
                    props: resolved.component.props,
                    userId: person.userId,
                },
                request.action,
            );
            try {
                return await ctx.inTx(async (txCtx) => {
                    if (outcome.status === "accepted") {
                        if (outcome.note !== undefined && outcome.note.trim() !== "") {
                            await insertChatUiNote(txCtx, agentId, outcome.note);
                        }
                        if (outcome.wake === true) await this.#wake(txCtx, agentId);
                    }
                    return {
                        record: await this.#settle(txCtx, agentId, request.id, outcome),
                        result:
                            outcome.status === "accepted"
                                ? this.#result(
                                      ctx,
                                      request.action.type,
                                      resolved.definition,
                                      outcome,
                                  )
                                : null,
                    };
                });
            } catch (error: unknown) {
                // The hook's work is done, but nothing of its outcome was stored: neither the
                // note nor the wake. The attempt must not stay pending, so it fails instead.
                ctx.log.warn("A chat UI outcome could not be applied.", {
                    actionType: request.action.type,
                    error: error instanceof Error ? error.name : typeof error,
                });
                const record = await ctx.inTx(
                    async (txCtx) =>
                        await this.#settle(txCtx, agentId, request.id, {
                            status: "failed",
                            reason: "Something went wrong. Try again.",
                        }),
                );
                return { record, result: null };
            }
        } finally {
            finished();
            this.#inFlight.delete(key);
        }
    }

    /** An accepted outcome's result, when the action declares one and the hook returned its shape. */
    #result(
        ctx: Context,
        actionType: string,
        definition: UiActionDefinition,
        outcome: Extract<HookOutcome, { status: "accepted" }>,
    ): Record<string, unknown> | null {
        if (definition.result === undefined || outcome.result === undefined) return null;
        if (Value.Check(definition.result, outcome.result)) return outcome.result;
        ctx.log.warn("A chat UI hook returned a result its action does not declare.", {
            actionType,
        });
        return null;
    }

    /**
     * Store an outcome on a pending attempt and its record, announced once it commits. The stored
     * `code` and `reason` are clipped to what the record's schema holds, so no hook's wording can
     * keep an attempt from settling.
     */
    async #settle(
        ctx: Context,
        agentId: string,
        id: string,
        outcome: HookOutcome,
    ): Promise<HistoryMessage> {
        const stored = await this.#history.message(ctx, agentId, id);
        const block = stored?.blocks[0];
        if (stored === undefined || block?.type !== "action") {
            throw new Error("A chat UI attempt lost its record.");
        }
        const settled: UiActionBlock = { ...block, outcome: storedOutcome(outcome) };
        const record: HistoryMessage = { ...stored, blocks: [settled] };
        await settleChatUiAttempt(ctx, agentId, id, outcome.status);
        await this.#history.replace(ctx, agentId, record);
        afterCommit(ctx, () => {
            for (const listener of this.#recordListeners) {
                try {
                    listener(agentId, structuredClone(record));
                } catch (error: unknown) {
                    ctx.log.warn("A chat UI record listener failed.", {}, error);
                }
            }
        });
        return record;
    }

    /** The hook, bounded to 15 seconds; a throw, a timeout, or a malformed answer fails the attempt. */
    async #runHook(
        ctx: Context,
        hook: AnyHook | undefined,
        offer: {
            readonly agentId: string;
            readonly messageId: string;
            readonly uiId: string;
            readonly componentId: string;
            readonly props: unknown;
            readonly userId: string | undefined;
        },
        action: { readonly type: string; readonly payload: Record<string, unknown> },
    ): Promise<HookOutcome> {
        if (hook === undefined) {
            return { status: "failed", reason: "That control does nothing here." };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<HookOutcome>((resolve) => {
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
        const run = (async (): Promise<HookOutcome> => {
            try {
                const outcome = await hook(ctx, offer, action.payload);
                if (Value.Check(hookOutcomeSchema, outcome)) return outcome;
                ctx.log.warn("A chat UI hook returned no outcome.", { actionType: action.type });
            } catch (error: unknown) {
                // The error may describe the request; only its kind is logged.
                ctx.log.warn("A chat UI hook failed.", {
                    actionType: action.type,
                    error: error instanceof Error ? error.name : typeof error,
                });
            }
            return { status: "failed", reason: "Something went wrong. Try again." };
        })();
        try {
            return await Promise.race([run, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Start a turn for every waiting note, in this transaction. A conversation nobody has given a
     * model yet runs on the installation's default, as it does when an agent speaks first.
     */
    async #wake(ctx: Context, agentId: string): Promise<void> {
        const agents = this.#agents;
        if (agents === undefined) return;
        const notes = await takeChatUiNotes(ctx, agentId);
        if (notes.length === 0) return;
        const delivery = await agentDeliveryMode(ctx, agents, this.#config.models, agentId);
        await agents.send(
            ctx,
            agentId,
            { role: "system", content: [{ type: "text", text: noteText(notes) }] },
            {
                id: createId(),
                metadata: {
                    hideFromUser: true,
                    ...(delivery === undefined ? {} : { mode: delivery.mode }),
                },
                ...delivery?.options,
            },
        );
        if (delivery !== undefined) {
            await agents.updateMetadata(ctx, agentId, { lastMode: delivery.mode });
        }
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

    /** An attempt still pending with no hook running, as after a restart, fails as interrupted. */
    async #interrupted(ctx: Context, agentId: string, id: string): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const attempt = await queryChatUiAttempt(txCtx, agentId, id);
            if (attempt?.status !== "pending") return;
            await this.#settle(txCtx, agentId, id, {
                status: "failed",
                code: "interrupted",
                reason: "Happy restarted before this finished. Try again.",
            });
        });
    }
}

/** An outcome as its record holds it, within the record's limits. */
function storedOutcome(outcome: HookOutcome): UiActionOutcome {
    if (outcome.status === "accepted") return { status: "accepted" };
    const code = outcome.code === undefined ? "" : oneLine(outcome.code).slice(0, MAX_CODE);
    return {
        status: outcome.status,
        ...(code === "" ? {} : { code }),
        reason: clip(oneLine(outcome.reason), MAX_REASON) || "That didn't work.",
    };
}

function attemptKey(agentId: string, id: string): string {
    return `${agentId}\u0000${id}`;
}

/** Notes as the model reads them: hidden context from the server, never the person. */
function noteText(notes: readonly string[]): string {
    return `<happy-note>\n${notes.join("\n")}\n</happy-note>`;
}

/** Text as one plain line: no control or bidirectional formatting character. */
function oneLine(text: string): string {
    return (
        text
            .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, "")
            // oxlint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
