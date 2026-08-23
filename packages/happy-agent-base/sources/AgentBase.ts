import type {
    BaseSession,
    SessionAssistantBlock,
    SessionDoneState,
    SessionEvent,
    SessionMessage,
    SessionReasoningEffort,
    SessionServiceTier,
    SessionSystemMessage,
    SessionTokens,
    SessionToolCallBlock,
    SessionToolResultBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import { areProviderModelsCompatible } from "@slopus/happy-providers";
import { createId } from "@paralleldrive/cuid2";
import { AsyncLocalStorage } from "node:async_hooks";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    createContextNamespace,
    detach,
    deterministicStringify,
    shutdown,
    withLifetime,
    type Context,
} from "@steve.kite/stdlib";

import {
    agentDatabase,
    agentId as agentIdOf,
    agentKV,
    agentStorageTransaction,
    withAgentContext,
    withAgentDatabase,
    withAgentHistoryKV,
    withAgentKV,
    withAgentPermissionMode,
    withAgentRunKV,
} from "./AgentContexts.js";
import { agentConfig, ownAgentConfig, withAgentConfig, type AgentConfig } from "./AgentConfig.js";
import { outsideAgentDatabaseOperation } from "./AgentDatabaseConnection.js";
import { taskContextBeforeToolCall, withAgentTaskContext } from "./AgentTaskContext.js";
import { AgentKV } from "./AgentKV.js";
import {
    AGENT_BASE_PENDING_KEY,
    agentBasePendingStateOf,
    type AgentBasePendingStage,
    type AgentBasePendingState,
} from "./AgentBasePending.js";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseCompactionStart,
    AgentBaseCompletedCompaction,
    AgentBaseHooks,
    AgentBaseInferenceStart,
    AgentBaseLoop,
    AgentBasePermissionModeChange,
    AgentBasePersistedEvent,
    AgentBaseSettlement,
    AgentBaseToolOutcome,
    MaybePromise,
} from "./AgentBaseHooks.js";
import type { AgentPersistence, AgentRecord } from "./AgentPersistence.js";
import {
    assistantContextRecord,
    baseContextMessages,
    baseSessionEvent,
    contextFromRecords,
    providerContextMessages,
    storedContextToolIds,
    toolContextRecord,
} from "./AgentProviderContext.js";
import {
    cuid2Schema,
    ownAgentMessageMetadata,
    ownAgentMetadata,
    type AgentMessageMetadata,
    type AgentMetadata,
    type AgentMetadataChange,
} from "./AgentMetadata.js";
import type { AgentMessageAcceptance } from "./AgentMessageAcceptance.js";
import {
    DEFAULT_AGENT_PERMISSION_MODE,
    isAgentPermissionMode,
    type AgentPermissionMode,
} from "./AgentPermissionMode.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import { AgentProviders } from "./AgentProviders.js";
import type { AgentModuleAction } from "./AgentModuleAction.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";
import type { AnyAgentTool } from "./AgentTool.js";
import { agentToolArgumentsError } from "./AgentToolArgumentsError.js";
import { setAgentSpanAttributes, type AgentSpanAttributes } from "./AgentSpanAttributes.js";

/** Race winner when an abort interrupts a wait on the stream or a running tool. */
const ABORTED = Symbol("aborted");
/** Marks a provider context measurement that inference preparation has not evaluated yet. */
const UNPREPARED_CONTEXT = Symbol("unprepared context");

/**
 * The agents whose run loop the current execution is running inside. Hooks and tool executions
 * receive a context carrying this, so an operation that would wait for the very loop it is part
 * of can say so instead of hanging for ever.
 *
 * Not detachable. Being inside a loop is a fact about the call in progress, and work that detaches
 * to a lifetime of its own is by definition no longer inside it.
 */
const insideTurn = createContextNamespace<readonly string[]>("agentInsideTurn", [], {
    detachable: false,
});

/**
 * The same fact as `insideTurn`, tracked by the runtime rather than carried by a context. Not
 * every operation takes one — `close` is the whole agent's lifetime and has no call to carry it —
 * and a context can always be one the caller kept from somewhere else, so the run loop marks its
 * own execution too. Everything the loop awaits, however deep, is inside this scope; another
 * agent's loop replaces the scope rather than extending it, because that loop is a lifetime of
 * its own and outlives whatever happened to start it.
 */
const insideLoops = new AsyncLocalStorage<readonly string[]>();

/**
 * How long a close asked for from inside the agent's own run loop waits for the shutdown before
 * telling its caller it cannot be waited for. Long enough that a caller which has already let go
 * hears the shutdown finish, short enough that one still holding the loop is told promptly.
 */
const INSIDE_CLOSE_REPORT_MS = 15;

/** How a message queue drains: one message per model response, or every queued message at once. */
export type AgentBaseQueueMode = "one-at-a-time" | "all";

/**
 * Inference settings carried by a queued message. An omitted field keeps the previously
 * effective value; the first message without a value falls back to the constructor default,
 * though relying on that default is discouraged — prefer sending settings with the message.
 */
export interface AgentBaseMessageOptions {
    /** Stable cuid2 identity for idempotent delivery; generated when omitted. */
    readonly id?: string;
    /** Immutable module-owned metadata that travels with this one message. */
    readonly metadata?: AgentMessageMetadata;
    /** The registry ID of the provider to switch to. */
    readonly provider?: string;
    /** The model to switch to; an incompatible one resets the conversation. */
    readonly model?: string;
    /** How hard the model should think about the request. */
    readonly effort?: SessionReasoningEffort;
    /** Which of the provider's service tiers to bill and schedule the request on. */
    readonly serviceTier?: SessionServiceTier;
    /**
     * How much of the machine the agent may touch from this message onwards. It takes effect when
     * the message is consumed rather than when it is queued, because a response and its tool batch
     * are already running under the mode they were started with.
     */
    readonly permissionMode?: AgentPermissionMode;
}
/** A durably queued message together with the settings it carries. */
interface QueueEntry {
    /** The store key the message was written under and removed through when consumed. */
    readonly key: string;
    readonly id: string;
    readonly message: AgentQueuedMessage;
    readonly metadata?: AgentMessageMetadata;
    /** The settings this message makes effective when it is consumed. */
    readonly options: AgentBaseMessageOptions;
}

/** One hook-provided system notice waiting for a safe append boundary. */
interface InjectionEntry {
    readonly key: string;
    readonly message: SessionSystemMessage;
}

/** One call in a dispatched batch. */
interface ToolBatchEntry {
    /** The pending-tool key the call is durable under until its result commits. */
    readonly key: string;
    /** Base-generated stable identity used by persistence, hooks, and execution. */
    readonly id: string;
    readonly call: SessionToolCallBlock;
    /** A tool-side result that already committed and must not execute again. */
    readonly committed?: SessionToolResultMessage;
}

const storedToolCallSchema = Type.Object({
    id: cuid2Schema,
    call: Type.Object({
        type: Type.Literal("tool_call"),
        name: Type.String(),
        arguments: Type.String(),
        namespace: Type.Optional(Type.String()),
        incomplete: Type.Optional(Type.Boolean()),
        vendor: Type.Optional(Type.Unknown()),
    }),
    committed: Type.Optional(Type.Unknown()),
});
type StoredToolCall = Static<typeof storedToolCallSchema>;

/** A durable first-writer-wins claim on the result one call will append. */
const storedToolResultSchema = Type.Object({
    role: Type.Literal("tool"),
    callId: cuid2Schema,
    content: Type.Array(Type.Unknown()),
    isError: Type.Optional(Type.Boolean()),
    vendor: Type.Optional(Type.Unknown()),
});

/** One message offered to a durable queue, before it has a key. */
interface QueueRequest {
    /** Which of the two queues it belongs in, and so when it will be injected. */
    readonly kind: "steering" | "send";
    readonly id: string;
    readonly message: AgentQueuedMessage;
    readonly metadata?: AgentMessageMetadata;
    readonly options: AgentBaseMessageOptions;
}

/** Everything an agent session is constructed with; only the identity and store are required. */
export interface AgentBaseOptions {
    /** Stable session identity supplied by the caller. */
    readonly id: string;
    /** The registry providers are resolved from, at session creation time. */
    readonly providers: AgentProviders;
    /** The registry ID of the provider to use; serializable alongside model and effort. */
    readonly provider: string;
    /** The append-only store the conversation, the queues, and the settings live in. */
    readonly persistence: AgentPersistence;
    /** Observers and correctness hooks the run is assembled from; `Agent` merges modules here. */
    readonly hooks?: AgentBaseHooks;
    /** Copied into the agent's own mutable `state`. */
    readonly initialState?: Partial<AgentBaseState>;
    /** The initial model, superseded by the first message that carries one. */
    readonly model?: string;
    /** The initial reasoning effort, superseded by the first message that carries one. */
    readonly effort?: SessionReasoningEffort;
    /** The initial service tier, superseded by the first message that carries one. */
    readonly serviceTier?: SessionServiceTier;
    /**
     * The mode the agent starts in, superseded by the first message that carries one and by
     * whatever the store already holds. Agents run in Auto when nobody says otherwise.
     */
    readonly permissionMode?: AgentPermissionMode;
    /** How the steering queue drains; one message per response by default. */
    readonly steeringMode?: AgentBaseQueueMode;
    /** How the send queue drains; one message per response by default. */
    readonly sendMode?: AgentBaseQueueMode;
}

/**
 * A single agent session over one provider. Messages arrive through two FIFO queues: steering
 * messages inject as soon as the current assistant response and its tool batch finish, while
 * sent messages wait until the agent would otherwise stop — no tool calls or steering remain.
 * Each queue drains per its configured mode, and the conversation is durable through
 * append-only persistence reloaded at the start of every turn.
 *
 * The rest of this comment is the list of promises the implementation has to keep. They are
 * written down because most of them are invisible in ordinary use and only show themselves when
 * a process dies or a caller races the loop. Each has focused test coverage.
 *
 * ## Serialization
 *
 * Database transactions and ordered keys keep persistence changes aligned with their in-memory
 * publication. Anything that decides from durable state resolves that state inside the committing
 * step rather than capturing it beforehand; a reference taken before a wait can belong to a
 * history that has since been replaced.
 *
 * ## Accepting a message
 *
 * A message is accepted exactly once, or not at all. Its durable write and the writes of every
 * other message in the same batch commit in one transaction under one hold of the lock. So:
 *
 * - `steer` and `send` resolve once the message is durable, except inside the target's own loop
 *   where waiting would deadlock. A failed write keeps it out of the conversation entirely.
 * - Messages a hook returns from one decision are accepted as one batch. A caller arriving while
 *   that batch is being written lands after all of it, never between two halves of one thought.
 * - Queue keys order by what the store already holds, including when the clock moves backwards.
 * - An agent holding a durable message never describes itself as settled.
 *
 * ## Consuming a message
 *
 * A consumption deletes each entry inside the transaction that appends it to the context. A
 * message is never durable in both places, or in neither, and memory changes only after commit.
 *
 * ## Turns
 *
 * A turn reloads the durable conversation before it decides anything, keeping the store
 * authoritative across restarts. A turn that consumes the last queued work clears the request it
 * just answered rather than buying an extra empty turn with a full set of hooks.
 *
 * ## Tool calls
 *
 * A batch runs its calls at the same time, each in its own persistence scope, and commits their
 * results in batch order. Results are matched back by call ID, so a response that used one ID
 * twice has no answer the model could tell apart: that ID is kept once and refused before
 * anything runs, since a refusal after the fact would not undo the side effect.
 *
 * The conversation never keeps a tool call the model will not get an answer for:
 *
 * - A batch is committed before any call in it runs, so a batch found uncommitted after a crash
 *   has certainly not run and is dispatched as the fresh batch it never became.
 * - A response that emits a call but does not end in one, and a turn that fails while owing
 *   results, settle their own calls with error results before appending anything behind them.
 * - A conversation loaded with a call stranded under later messages is repaired atomically at
 *   load, since the answer belongs beside its call rather than at the end.
 * - A non-durable tool never runs twice; a durable one may.
 *
 * ## Compaction
 *
 * A compaction runs at the next safe inference boundary: before a turn's first request, or after
 * the current response's complete tool batch settles and before its continuation. It replaces the
 * history whole or not at all. A compaction nobody will carry out is rejected rather than left
 * waiting.
 *
 * ## Model changes
 *
 * An incompatible provider or model change resets the conversation; a compatible one keeps it.
 * Either way the change lands on one side or the other, never the old history under the new
 * model. `modelChanged` runs inside the transaction and is lent a store bound to it — a
 * capability released when the hook returns, so it cannot be retained to write after commit.
 * A failing handoff rejects an incompatible switch outright rather than costing the history.
 *
 * ## Permission modes
 *
 * How much of the machine the agent may touch travels with its messages, exactly like its model,
 * and takes effect when the message is consumed rather than when it is queued: a response and the
 * tools it dispatched are already running under the mode they were started with, and are left to
 * finish under it. The mode is durable, so a restart resumes in the mode the conversation reached,
 * and it is carried on every context the agent derives, so a hook or a tool reads what it is
 * running under rather than being told.
 *
 * The loop enforces nothing. It has no idea what any particular tool touches, and a runtime that
 * guessed would be wrong about tools it has never seen. Enforcement belongs to the modules and
 * tools that do know; the loop's whole part is to carry the mode, make its changes durable, and
 * report them.
 *
 * ## Recovery
 *
 * Only the durable pending record decides whether a restarted agent is active. Once active, the
 * stage and the durable conversation decide what resumes. A consumed message, tool result, or
 * failure note is owed an answer. A standalone compaction replacement is not, while an automatic
 * compaction atomically preserves the inference identity of the response already owed after it.
 *
 * ## Abort
 *
 * An abort owns the whole turn. Its scope opens before any of the turn's work — its hooks and its
 * loading as much as its inference — so a turn cancelled while it is still starting up never
 * reaches the model at all, rather than being cancelled only once it was already talking.
 *
 * What a cancelled turn leaves behind is fixed:
 *
 * - Assistant blocks that finished stay in the history; a block still being streamed is dropped,
 *   because half a block is not something the model said.
 * - Tool calls still running are settled in the conversation as aborted error results, so the
 *   history owes nothing, and the turn ends without waiting for the tools themselves. A tool that
 *   never notices cancellation therefore cannot hold the cancellation open — but it is still
 *   running, so the *next* provider request waits for it before reusing the stateful session.
 * - Messages already queued stay durable and join the next requested turn. An abort cancels the
 *   turn, not the work waiting for one.
 * - A compaction requested during the turn is rejected rather than left pending, because dropping
 *   the turn request drops the only thing that would have carried it out.
 * - Exactly one terminal event is reported. A cancellation seen after a response already reported
 *   its own outcome adds nothing, since that response is over.
 *
 * `abort` signals and returns, because the cancellation is complete once it is signalled.
 *
 * ## Close
 *
 * Close is a barrier, published before any of the shutdown runs. Nothing new is admitted from
 * the moment it is called; everything already admitted is written and answered, and only then is
 * the provider session destroyed. Every caller shares that one shutdown, including one
 * reentering from inside session destruction, so a session is never destroyed twice.
 *
 * ## Hooks
 *
 * Hooks observe the run and never fail it. Neither a throwing hook nor a failing hook-driven
 * action ends a turn.
 *
 * ## Re-entrancy
 *
 * A hook or a tool runs while the loop is waiting for it, so anything it asks of its own agent
 * that only the loop can deliver would wait for itself. Loop operations therefore have one safe
 * behavior from every caller:
 *
 * - `steer` and `send` wait for durable acceptance except when aimed at the caller's own loop.
 * - `abort` and `compact` register their request and return; the loop acts afterwards.
 * - A hook that wants a compaction has a better option than requesting one: the
 *   `{ type: "compact" }` action it returns lands exactly where the loop can act on it, in order
 *   with the rest of that decision.
 * - `close` and `waitForIdle` take no context, so they cannot be checked and will simply hang.
 *   Both are nothing but a wait for the run to finish. Close the agent from the caller that owns
 *   its lifetime.
 *
 * `AgentRef` and `AgentSystemRef` drop the two unguarded waits, and are what code running inside
 * an agent should be handed.
 */
export class AgentBase {
    /** The caller-supplied session identity: the name of this agent's store and of its loop. */
    readonly id: string;
    /**
     * The agent's own copy of the initial state, mutable directly; every inference reads the
     * current values.
     */
    readonly state: AgentBaseState;

    /**
     * The agent's own lifetime, without the selection on it. Every context the agent derives
     * starts here, so a change of provider or model rebuilds one context from a known base
     * rather than layering another value onto whatever the last one happened to carry.
     */
    #baseCtx: Context;
    /** The base context extended with the effective selection and the agent's key-value store. */
    #ctx: Context;
    /** The immutable configuration snapshot carried by every hook context. */
    #config: AgentConfig;
    /** The registry the provider ID is resolved through, each time a session is created. */
    readonly #providers: AgentProviders;
    /** The registry ID of the provider in force; durable, so a restart resumes on the same one. */
    #providerId: string;
    /** The append-only store behind the conversation, the queues and the persisted settings. */
    readonly #persistence: AgentPersistence;
    /** The model in force. Changing it to an incompatible one resets the conversation. */
    #model: string | undefined;
    /** The reasoning effort in force. */
    #effort: SessionReasoningEffort | undefined;
    /** The service tier in force. */
    #serviceTier: SessionServiceTier | undefined;
    /**
     * How much of the machine the agent may touch. Durable, so a restart resumes in the mode the
     * conversation reached, and carried on every context the agent derives.
     */
    #permissionMode: AgentPermissionMode;
    /** The single set of hooks the run is observed by and its configuration extended from. */
    readonly #hooks: AgentBaseHooks;
    /** The session-scoped key-value store carried on every context the agent derives. */
    readonly #kv: AgentKV;
    /** Durable state tied to the current history and invalidated when that history is replaced. */
    #historyKV: AgentKV;
    /** Ends handles from the previous history epoch after its replacement commits. */
    #historyKVLifetime = new AbortController();
    /**
     * The store belonging to the run rather than to the conversation, erased in the transaction
     * that settles the agent. What a run concludes about itself is worth nothing to the next one,
     * and leaving it behind would let a restarted agent act on a decision made about work that is
     * already over.
     */
    readonly #runKV: AgentKV;
    /** Whether steering drains one message per response or all of them at once. */
    readonly #steeringMode: AgentBaseQueueMode;
    /** Whether sends drain one message per response or all of them at once. */
    readonly #sendMode: AgentBaseQueueMode;

    /** The provider session requests run on, created on first use and stateful thereafter. */
    #session: BaseSession | undefined;
    /** The provider-facing configuration the current session was created with. */
    #sessionConfig: string | undefined;
    /** The conversation under Base-owned identities, reloaded from the store every turn. */
    #messages: SessionMessage[] = [];
    /** Provider-native tool IDs used only when serializing the private provider context. */
    #providerToolIds = new Map<string, string>();
    /** The durable steering queue, in the order its keys sort. */
    #steering: QueueEntry[] = [];
    /** The durable send queue, in the order its keys sort. */
    #sends: QueueEntry[] = [];
    /** A committed outer-transaction queue write not yet merged into the in-memory queues. */
    #committedQueueDirty = false;
    /** Hook notices waiting to join history after tool settlement and compaction. */
    #injections: InjectionEntry[] = [];
    /** A consumed notice that still needs one provider response. */
    #noticeAwaitingResponse = false;
    /** A dispatched tool batch whose results have not all landed yet, and so has to be resumed. */
    #pendingTools: ToolBatchEntry[] = [];
    /**
     * True when the pending tools were reconstructed from an unanswered trailing tool call
     * rather than read from the durable batch, so the batch still has to be committed before
     * anything runs.
     */
    #pendingToolsUndispatched = false;
    /** How many tool batches are running, so a caller can tell a waiting turn from a busy one. */
    #toolsRunning = 0;
    /** The in-flight or finished load of the durable state; cleared at the start of every turn. */
    #loaded: Promise<void> | undefined;
    /**
     * The kind of the last durable record, used only after the pending record has established
     * that the agent is active. A consumed message, tool result, or failure note is owed a
     * response. A compaction is owed one only when the pending inference identity says the active
     * turn was already committed to continue across that replacement.
     */
    #lastRecordType: AgentRecord["type"] | undefined;
    /**
     * Whether this instance has checked whether a cut-off run should resume inference. The
     * question is only meaningful once, against the state the agent first loaded: afterwards a
     * trailing user message is ordinary, since a response may legitimately have no blocks.
     */
    #recoveryChecked = false;
    /**
     * The outstanding work this agent has recorded, held in memory exactly as the store holds
     * it. Its presence is the whole of the active flag, so the one thing anyone outside can ask
     * about the agent is answered from here without touching the disk.
     */
    #pending: AgentBasePendingState | undefined;
    /** Stable Base-owned lifecycle identities persisted as part of the pending run. */
    #loopId: string | undefined;
    #turnId: string | undefined;
    #inferenceId: string | undefined;
    #settlementId: string | undefined;
    /** The durable settlement awaiting its post-commit observing hook. */
    #settlement: AgentBaseSettlement | undefined;
    /**
     * Why the run in progress has failed, as its settlement will report it. It is set wherever a
     * failure is surfaced to the conversation and by a run that ended by throwing, and cleared
     * when a new turn starts, so it always describes the last thing that went wrong rather than
     * anything the run recovered from. A settlement another process left behind cannot carry it:
     * what a dead process knew about why it stopped died with it.
     */
    #runFailure: string | undefined;
    /**
     * The pending state this instance last wrote, so a write that would change nothing is
     * skipped. The loop passes through the same stage many times in a turn, and a store is not
     * worth touching to tell it what it already says.
     */
    #pendingWritten: string | undefined;
    /**
     * The outstanding work this agent's store already held when this instance first wrote to it:
     * what a process that died mid-run left behind, or nothing when the last run settled
     * cleanly. It is what recovery decides from, in place of guessing from the transcript's
     * shape.
     */
    #inherited: AgentBasePendingState | undefined;
    /** Whether that inherited record has been read; it can only be read before it is overwritten. */
    #inheritedRead = false;
    /**
     * Whether the activation hook is still owed an announcement for inherited work: the store
     * already said the agent was working when this process first looked, and no run of this
     * process has announced taking that work up yet.
     */
    #restoreActivationOwed = false;
    /** Whether this process has announced the activation of the current active period. */
    #activationAnnounced = false;
    /**
     * The compaction that has been asked for and not carried out yet, together with the promise
     * every caller waiting for it shares. Requesting one while it is pending joins that promise
     * rather than queueing a second compaction.
     */
    #compaction:
        | {
              readonly promise: Promise<void>;
              readonly resolve: () => void;
              readonly reject: (error: unknown) => void;
          }
        | undefined;
    /** The scope the current stretch of work is cancelled on, which an abort signals. */
    #abortController: AbortController | undefined;
    /**
     * Raised when close begins. Only the tool batch listens: a running tool may be waiting for
     * the close itself, so the shutdown stops waiting for tools while still finishing the
     * inference stream and everything already accepted.
     */
    readonly #closeController = new AbortController();
    /**
     * The true size of the conversation in tokens, as the provider last measured it. Durable,
     * so a restart keeps knowing how large the conversation is, and cleared whenever the
     * conversation is replaced.
     */
    #contextTokens: number | undefined;
    /** Whether the current turn was cancelled before it could finish. */
    #turnAborted = false;
    /** A staged tool result could not settle, so this run must leave its pending state intact. */
    #durableWorkBlocked = false;
    /** Whether something has asked for a turn that has not been answered yet. */
    #turnRequested = false;
    /** The run loop while it is running; the field is cleared once it has actually stopped. */
    #runPromise: Promise<void> | undefined;
    /** Sticky for this instance: once requested, no later operation starts another run. */
    #draining = false;
    /** The shared barrier that resolves when the current run reaches a durable edge. */
    #drainPromise: Promise<void> | undefined;
    /** Whether the shared drain barrier has reached its edge. */
    #drainFinished = false;
    /** The barrier: true from the moment close is called, and nothing new is admitted after it. */
    #closed = false;
    /** The one shutdown every closing caller shares, so a session is never destroyed twice. */
    #closing: Promise<void> | undefined;
    /** Operations accepted from a caller and not finished yet; a close waits for every one. */
    readonly #admitted = new Set<Promise<unknown>>();
    /** Queue acceptances the run loop must publish before it may decide its queues are empty. */
    readonly #messageAdmissions = new Set<Promise<readonly AgentMessageAcceptance[]>>();
    /**
     * Work from an earlier response that is still unwinding: a provider stream that has not
     * finished closing, or a tool that was settled in the conversation by an abort and is still
     * running. The next request waits for it, because the session is stateful and its previous
     * user has not let go. An abort does not wait for it: a stream or tool that ignores being
     * cancelled must never be able to hold the cancellation open.
     */
    readonly #settling = new Set<Promise<unknown>>();
    /**
     * The part of that unwinding a close has to wait for: a response iterator still letting go
     * of the provider session. Destroying the session underneath it would hand the provider two
     * owners of one session at once.
     */
    readonly #streamCleanup = new Set<Promise<unknown>>();
    /** IDs offered by this process, for immediate self-reentrant acceptance answers. */
    readonly #offeredMessageIds = new Set<string>();

    /**
     * A new agent, wired to its options and touching no storage at all. Use this for an identity
     * with no durable state yet; whatever the agent needs from the store is read by its first
     * turn.
     */
    static create(ctx: Context, options: AgentBaseOptions): Promise<AgentBase> {
        return Promise.resolve(new AgentBase(ctx, options));
    }

    /**
     * An agent for an identity that may already have durable state, with the one externally
     * meaningful fact about that state — whether it has work left — read before it is handed
     * back, so `active` is answerable straight away.
     *
     * Only the flag is read. The conversation, the queues and the settings are deliberately not:
     * they are needed by the first turn and by nothing before it, so an owner resuming a hundred
     * identities at startup pays for a hundred small reads rather than a hundred transcripts.
     * The rest loads on the way into the turn that actually needs it.
     *
     * The read normally runs on the agent's own context. A caller resolving the agent from
     * inside an open storage transaction passes `loadCtx` to route this one read through that
     * transaction's connection instead, because a single-connection driver cannot serve a read
     * beside the transaction it is holding open. The agent's own lifetime context is detached
     * either way and never carries the caller's transaction.
     */
    static async load(
        ctx: Context,
        options: AgentBaseOptions,
        loadCtx?: Context,
    ): Promise<AgentBase> {
        const agent = new AgentBase(ctx, options);
        await agent.#loadPendingState(loadCtx ?? agent.#ctx);
        return agent;
    }

    /**
     * Load the agent and set it going again if it has work left, or answer with nothing when it
     * has none. This is how an owner coming up carries on whatever an earlier process was in the
     * middle of: the whole question is one key, and an agent told to go picks its own work back
     * up, so the caller has only to bring it into existence.
     *
     * An agent owing nothing is not handed back, because there is nothing to do with it that
     * resolving it when something is actually wanted of it would not do better.
     */
    static async loadActive(
        ctx: Context,
        options: AgentBaseOptions,
    ): Promise<AgentBase | undefined> {
        const agent = await AgentBase.load(ctx, options);
        if (!agent.active) return undefined;
        agent.start();
        return agent;
    }

    /**
     * Read the outstanding work the store already holds, before this instance has written any of
     * its own. It is both what `active` answers from and what an interrupted run is recognized
     * by, so reading it here leaves the later stage writes nothing to learn from the store. The
     * context is the caller's choice: the agent's own for an ordinary load, or the resolving
     * transaction's when the read has to ride that transaction's connection.
     */
    async #loadPendingState(ctx: Context): Promise<void> {
        await this.#runPersistenceStep(ctx, async (operationCtx) => {
            await this.#loadConfig(operationCtx);
            const stored = await agentBasePendingStateOf(operationCtx, this.#persistence);
            this.#inherited = stored;
            this.#inheritedRead = true;
            this.#restoreActivationOwed =
                stored !== undefined && this.#hooks.afterAgentActivatedTransact !== undefined;
            this.#pending = stored;
            this.#loopId = stored?.loopId;
            this.#turnId = stored?.turnId;
            this.#inferenceId = stored?.inferenceId;
            this.#settlementId = stored?.settlementId;
            this.#pendingWritten =
                stored === undefined ? undefined : deterministicStringify(stored);
        });
    }

    /**
     * Build the agent from its options, without touching the store. Nothing is loaded here: the
     * durable state is read by the first turn, so constructing one stays cheap even for a session
     * nobody goes on to run. Private, because an agent is made by `create` or by `load`, and
     * which of the two the caller means is worth saying.
     */
    private constructor(ctx: Context, options: AgentBaseOptions) {
        this.id = options.id;
        this.#config = ownAgentConfig(agentConfig(ctx) ?? {});
        // An agent is its own lifetime, so it makes a root of the context it was handed rather
        // than working on it. Whatever call happened to construct it — a tool of another agent,
        // most often — takes its cancellation, its open transaction, and the loop it was itself
        // running inside with it when it returns, and none of that may reach work that goes on
        // long afterwards. What survives is what describes the world the agent runs in: its
        // logger, its tracer, and its configuration. Everything the agent owns is put on
        // deliberately, beginning with the storage the detached root no longer carries.
        this.#baseCtx = withAgentDatabase(
            withAgentConfig(
                insideTurn.set(detach(ctx).named(`agent.${options.id}`), [options.id]),
                this.#config,
            ),
            options.persistence.database,
        );
        this.#providers = options.providers;
        this.#providerId = options.provider;
        this.#persistence = options.persistence;
        this.#hooks = options.hooks ?? {};
        this.state = {
            instructions: options.initialState?.instructions ?? "",
            tools: [...(options.initialState?.tools ?? [])],
        };
        this.#model = options.model;
        this.#effort = options.effort;
        this.#serviceTier = options.serviceTier;
        this.#permissionMode = options.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE;
        this.#kv = new AgentKV(this.#persistence, `kv.${options.id}.`);
        this.#historyKV = this.#newHistoryKV();
        this.#runKV = this.#kv.scoped("run");
        // Everything the agent does — hooks and tool executions included — runs on a context
        // carrying its provider and the currently effective model, effort, and service tier.
        this.#ctx = this.#deriveCtx();
        this.#steeringMode = options.steeringMode ?? "one-at-a-time";
        this.#sendMode = options.sendMode ?? "one-at-a-time";
    }

    /**
     * The context everything the agent does runs on: its identity and effective selection, plus
     * the session-scoped key-value store and the store of the run in progress. Rebuilt whenever
     * the selection changes. It is what the agent does its own work on, outside a run.
     */
    #deriveCtx(): Context {
        return this.#hookContext(this.#baseCtx);
    }

    /**
     * The agent's selection, configuration, and stores put onto the context a stretch of work is
     * running on. The run loop hands each piece of its work the context of the tracing span that
     * work belongs to, and every use of that context goes through here, so what the agent is
     * running on is read at the moment of use: a model switch or a metadata change made in the
     * middle of a turn is seen by the rest of it, and the span the work opened under is kept.
     */
    #workContext(ctx: Context): Context {
        return this.#hookContext(withAgentConfig(ctx, this.#config));
    }

    /** Add this agent's selection and stores to a caller context without losing its transaction. */
    #hookContext(ctx: Context): Context {
        const selected = withAgentContext(ctx, this.#selection());
        const database = agentDatabase(ctx) ?? this.#persistence.database;
        return withAgentRunKV(
            withAgentHistoryKV(
                withAgentKV(withAgentDatabase(selected, database), this.#kv),
                this.#historyKV,
            ),
            this.#runKV,
        );
    }

    /** Create the handle for one history epoch under the stable history storage prefix. */
    #newHistoryKV(): AgentKV {
        return this.#kv.scoped("history").until(this.#historyKVLifetime.signal);
    }

    /** Expire every retained old handle and install a fresh handle for replacement history. */
    #rotateHistoryKV(): void {
        this.#historyKVLifetime.abort();
        this.#historyKVLifetime = new AbortController();
        this.#historyKV = this.#newHistoryKV();
        this.#ctx = this.#deriveCtx();
    }

    /** Load a directly owned configuration written by `updateMetadata`, when one exists. */
    async #loadConfig(ctx: Context): Promise<void> {
        const stored = await this.#persistence.readValues(ctx, "agentConfig");
        const exact = stored.find(({ key }) => key === "agentConfig")?.value;
        if (exact === undefined) return;
        const config = ownAgentConfig(exact as AgentConfig);
        this.#config = config;
        this.#baseCtx = withAgentConfig(this.#baseCtx, config);
        this.#ctx = this.#deriveCtx();
    }

    /** Everything about what the agent is currently running on, as one value to carry. */
    #selection(): {
        readonly id: string;
        readonly provider: string;
        readonly model: string | undefined;
        readonly effort: SessionReasoningEffort | undefined;
        readonly serviceTier: SessionServiceTier | undefined;
        readonly permissionMode: AgentPermissionMode;
    } {
        return {
            id: this.id,
            provider: this.#providerId,
            model: this.#model,
            effort: this.#effort,
            serviceTier: this.#serviceTier,
            permissionMode: this.#permissionMode,
        };
    }

    /**
     * Open agent work with the selection that governs it, so every operation in a trace can be
     * attributed without recording prompts, arguments, or provider response content.
     */
    #span<Result>(
        ctx: Context,
        name: string,
        attributes: AgentSpanAttributes,
        work: (ctx: Context) => Result | PromiseLike<Result>,
    ): Promise<Awaited<Result>> {
        const selection = this.#selection();
        return Promise.resolve(
            ctx.span(name, (spanCtx) => {
                setAgentSpanAttributes(spanCtx, {
                    "agent.id": selection.id,
                    "agent.provider": selection.provider,
                    "agent.permission_mode": selection.permissionMode,
                    ...(selection.model === undefined ? {} : { "agent.model": selection.model }),
                    ...(selection.effort === undefined ? {} : { "agent.effort": selection.effort }),
                    ...(selection.serviceTier === undefined
                        ? {}
                        : { "agent.service_tier": selection.serviceTier }),
                    ...attributes,
                });
                return work(spanCtx);
            }),
        );
    }

    /**
     * Whether the agent has anything left to do. This is the only thing about an agent's state
     * anyone outside it may read: the queues and the stage behind this answer are the run's own
     * business, and can be cleared but never inspected. Even this is rarely wanted — it is here
     * for the owner deciding which agents a restarted process has to resume.
     */
    get active(): boolean {
        return this.#pending !== undefined;
    }

    /** The durable stage still running while this agent is moving toward its drain edge. */
    get drainStage(): AgentBasePendingStage | undefined {
        if (!this.#draining || this.#drainFinished) return undefined;
        return (
            this.#pending?.stage ?? (this.#settlementId === undefined ? "inference" : "settlement")
        );
    }

    /**
     * Record what the agent is doing, so a process that dies here is discovered owing exactly
     * this. Writing runs on the caller's context: given a transaction's context it commits with
     * whatever else that transaction is writing, which is how a consumed message and the
     * inference it owes become durable as one fact rather than two.
     */
    async #recordPending(ctx: Context, stage: AgentBasePendingStage, force = false): Promise<void> {
        const pending = this.#pendingState(stage);
        const serialized = deterministicStringify(pending);
        if (!force && this.#pendingWritten === serialized) return;
        await this.#persistence.writeValue(ctx, AGENT_BASE_PENDING_KEY, pending);
        this.#pending = pending;
        this.#pendingWritten = serialized;
    }

    /** The complete durable lifecycle identity state for one outstanding stage. */
    #pendingState(stage: AgentBasePendingStage): AgentBasePendingState {
        this.#loopId ??= createId();
        return {
            stage,
            loopId: this.#loopId,
            ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
            ...(this.#inferenceId === undefined ? {} : { inferenceId: this.#inferenceId }),
            ...(this.#settlementId === undefined ? {} : { settlementId: this.#settlementId }),
        };
    }

    /**
     * Record the stage the run has reached through the store's transaction boundary.
     *
     * The first of these also reads what the store already held, before overwriting it. That
     * reading is the only chance to see it: from this point the record says what this instance
     * is doing, and a run interrupted by a dead process would be indistinguishable from the one
     * starting here.
     */
    async #enterStage<Result = void>(
        ctx: Context,
        stage: AgentBasePendingStage,
        transact?: (ctx: Context) => MaybePromise<Result>,
    ): Promise<Result | undefined> {
        const pending = this.#pendingState(stage);
        if (
            transact === undefined &&
            !this.#restoreActivationOwed &&
            deterministicStringify(pending) === this.#pendingWritten &&
            this.#inheritedRead
        ) {
            return undefined;
        }
        try {
            return await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                if (!this.#inheritedRead) {
                    this.#inheritedRead = true;
                    this.#inherited = await agentBasePendingStateOf(lockCtx, this.#persistence);
                    this.#restoreActivationOwed =
                        this.#inherited !== undefined &&
                        !this.#activationAnnounced &&
                        this.#hooks.afterAgentActivatedTransact !== undefined;
                }
                const announceRestore = this.#restoreActivationOwed;
                if (transact === undefined && !announceRestore) {
                    await this.#recordPending(lockCtx, stage);
                    return undefined;
                }
                const result = await this.#recordTransaction(lockCtx, async (txCtx) => {
                    // The state is staged first. The callback then writes against this exact
                    // transaction, so neither its conclusion nor the state it observed can land
                    // without the other.
                    await this.#recordPending(txCtx, stage, true);
                    // Taking up inherited work is what reactivates the agent after a restart,
                    // so the announcement commits with the resumed run's own stage record.
                    if (announceRestore) await this.#announceActivation(txCtx, true);
                    return transact === undefined
                        ? undefined
                        : await this.#withTransactionalContext(txCtx, transact);
                });
                if (announceRestore) {
                    this.#restoreActivationOwed = false;
                    this.#activationAnnounced = true;
                }
                return result;
            });
        } catch (error) {
            if (transact !== undefined) throw error;
            // Losing the record costs recovery precision, never the work itself: the turn is
            // already running and will answer whatever it was going to answer.
            return undefined;
        }
    }

    /**
     * Erase the outstanding work, which is what makes the agent idle. Runs on the caller's
     * context so it can be part of the transaction that settles the agent, letting a hook commit
     * its own conclusion of the run alongside the fact that the run is over.
     */
    async #clearPending(ctx: Context): Promise<void> {
        await this.#persistence.deleteValue(ctx, AGENT_BASE_PENDING_KEY);
        this.#pending = undefined;
        this.#pendingWritten = undefined;
    }

    /**
     * Tell the activation hook the agent stopped being settled, inside the very transaction that
     * records the work it now owes. A failure propagates and rolls that transaction back, so a
     * module never concludes the agent woke up from a wake-up that never became durable.
     */
    async #announceActivation(txCtx: Context, restored: boolean): Promise<void> {
        const hook = this.#hooks.afterAgentActivatedTransact;
        if (hook === undefined) return;
        await this.#withTransactionalContext(txCtx, (hookCtx) =>
            hook(this.#workContext(hookCtx), { restored }),
        );
    }

    /**
     * Record that scheduled work made an inference owed, and decide whether this transaction is
     * the one that woke a settled agent. The decision is the store's own absent-only insert of
     * the pending record, so transactions racing to wake the same agent are arbitrated by the
     * database rather than by a read another writer could make stale: exactly one creates the
     * record and activates, and the others find it already present. A record that is present
     * but unreadable counts as no pending state, as it does everywhere else.
     */
    async #claimPendingWork(txCtx: Context): Promise<boolean> {
        const pending = this.#pendingState("inference");
        const serialized = deterministicStringify(pending);
        // This instance already recorded the current run, so the work is already owed and
        // nothing here can be an activation.
        if (this.#pendingWritten === serialized) return false;
        let created = await this.#persistence.writeValueIfAbsent(
            txCtx,
            AGENT_BASE_PENDING_KEY,
            pending,
        );
        if (!created) {
            created = (await agentBasePendingStateOf(txCtx, this.#persistence)) === undefined;
            await this.#persistence.writeValue(txCtx, AGENT_BASE_PENDING_KEY, pending);
        }
        this.#pending = pending;
        this.#pendingWritten = serialized;
        return created;
    }

    /**
     * Queue a message that injects as soon as the current assistant response and its tool
     * batch finish; steering always takes precedence over sent messages. Returns once the message
     * has been handed to the agent and returns its acceptance identity. Outside the target's own
     * loop it waits for the durable created/existing result by default; a failed write rejects and
     * keeps the message out of the conversation entirely.
     */
    async steer(
        ctx: Context,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        return await this.#offer(ctx, "steering", message, options);
    }

    /**
     * Queue a message that waits until the agent would otherwise stop — no tool calls or
     * steering remain — before injecting. Returns once the message has been handed to the agent,
     * without waiting for the turn that answers it and returns its acceptance identity. Outside
     * the target's own loop it waits for the durable created/existing result by default; a failed
     * write rejects and keeps the message out of the conversation entirely.
     */
    async send(
        ctx: Context,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        return await this.#offer(ctx, "send", message, options);
    }

    /**
     * Shallow-merge fields into this agent's immutable metadata. The complete AgentConfig and
     * transactional hook writes commit together; observing hooks run only after that commit.
     */
    async updateMetadata(ctx: Context, update: AgentMetadata): Promise<void> {
        const ownedUpdate = ownAgentMetadata(update);
        if (ownedUpdate === undefined) throw new Error("The agent metadata is not valid.");
        if (this.#closed) throw new Error("The agent has been closed.");
        if (insideTurn.get(ctx).includes(this.id) || this.#insideOwnLoop()) {
            throw new Error(
                "Updating metadata from inside this agent's current operation would wait for " +
                    "that same operation to finish. Update it after the hook or tool returns.",
            );
        }
        let change!: AgentMetadataChange;
        let next!: AgentConfig;
        await this.#runPersistenceStep(ctx, async (lockCtx) => {
            await this.#persistence.transaction(lockCtx, async (txCtx) => {
                const stored = await this.#persistence.readValues(txCtx, "agentConfig");
                const exact = stored.find(({ key }) => key === "agentConfig")?.value;
                const current =
                    exact === undefined ? this.#config : ownAgentConfig(exact as AgentConfig);
                const previousMetadata = ownAgentMetadata(current.metadata ?? {});
                const metadata = ownAgentMetadata({ ...previousMetadata, ...ownedUpdate });
                if (previousMetadata === undefined || metadata === undefined) {
                    throw new Error("The agent metadata is not valid.");
                }
                next = ownAgentConfig({ ...current, metadata });
                change = {
                    agentId: this.id,
                    previousMetadata,
                    update: ownedUpdate,
                    metadata,
                };
                await this.#persistence.writeValue(txCtx, "agentConfig", next);
                await this.#withTransactionalContext(
                    withAgentConfig(txCtx, next),
                    async (hookCtx) =>
                        await this.#hooks.metadataChangedTransact?.(
                            this.#hookContext(hookCtx),
                            change,
                        ),
                );
                afterCommit(txCtx, () => {
                    this.#config = next;
                    this.#baseCtx = withAgentConfig(this.#baseCtx, next);
                    this.#ctx = this.#deriveCtx();
                });
            });
        });
        if (agentStorageTransaction(ctx) === undefined) {
            await this.#invokeHookOn(
                this.#hookContext(withAgentConfig(ctx, next)),
                this.#hooks.metadataChanged,
                change,
            );
        } else {
            afterCommit(ctx, () => {
                outsideAgentDatabaseOperation(() => {
                    void this.#invokeHookOn(
                        this.#hookContext(withAgentConfig(this.#ctx, next)),
                        this.#hooks.metadataChanged,
                        change,
                    );
                });
            });
        }
    }

    /**
     * Hand one message to a durable queue. The acceptance runs whether or not the caller waits
     * for it — an unwaited failure is still a message that never entered the conversation, and
     * the agent's own close still drains it, so nothing is dropped by not looking.
     */
    async #offer(
        ctx: Context,
        kind: QueueRequest["kind"],
        message: AgentQueuedMessage,
        options: AgentBaseMessageOptions | undefined,
    ): Promise<AgentMessageAcceptance> {
        const outerTransaction = agentStorageTransaction(ctx);
        if (outerTransaction?.lifetime.aborted === true) {
            throw new Error("The agent storage transaction carried by this context has ended.");
        }
        const { id = createId(), metadata: suppliedMetadata, ...settings } = options ?? {};
        if (!Value.Check(cuid2Schema, id)) {
            throw new Error("The message ID must be a cuid2 identity.");
        }
        const wait = agentIdOf(ctx) !== this.id && !insideTurn.get(ctx).includes(this.id);
        const metadata = ownAgentMessageMetadata(suppliedMetadata);
        if (this.#closed) throw new Error("The agent has been closed.");
        const knownInProcess = this.#offeredMessageIds.has(id);
        if (outerTransaction === undefined) {
            this.#offeredMessageIds.add(id);
        }
        const accepted = this.#enqueue(ctx, [
            {
                kind,
                id,
                message: structuredClone(message),
                ...(metadata === undefined ? {} : { metadata }),
                options: settings,
            },
        ]);
        // Work using an outer transaction must finish its durable writes before that transaction
        // body can return. The caller may still choose not to wait for an ordinary independent
        // acceptance, but a carried transaction cannot safely outlive unfinished work using it.
        if (outerTransaction !== undefined) {
            const [result] = await accepted;
            if (result === undefined) {
                throw new Error("The message acceptance result was lost.");
            }
            return result;
        }
        if (wait) {
            try {
                const [result] = await accepted;
                if (result === undefined) {
                    throw new Error("The message acceptance result was lost.");
                }
                return result;
            } catch (error: unknown) {
                if (!knownInProcess) this.#offeredMessageIds.delete(id);
                throw error;
            }
        }
        accepted.catch(() => {
            if (!knownInProcess) this.#offeredMessageIds.delete(id);
        });
        return {
            id,
            delivery: kind === "steering" ? "steer" : "send",
            accepted: knownInProcess ? "existing" : "created",
        };
    }

    /**
     * Whether the current execution is running inside this agent's own run loop, judged by the
     * scope the loop marks itself with. This is what an operation carrying no context has to go
     * on. Anything that takes a context asks the context instead: it names the caller, where
     * this only describes what the loop happens to be running, and would mistake code the loop
     * called into for code the loop is waiting on.
     */
    #insideOwnLoop(): boolean {
        return insideLoops.getStore()?.includes(this.id) === true;
    }

    /** Run one persistence step; its database statements and transactions own consistency. */
    async #runPersistenceStep<Result>(
        ctx: Context,
        work: (stepCtx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await work(ctx);
    }

    /**
     * Accept a batch of messages as one durable transaction, so a caller arriving while it is
     * being written lands after the whole batch rather than in the middle of it, and a failure
     * admits none of them.
     */
    async #enqueue(
        ctx: Context,
        batch: readonly QueueRequest[],
    ): Promise<readonly AgentMessageAcceptance[]> {
        if (batch.length === 0) return [];
        if (this.#closed) throw new Error("The agent has been closed.");
        // Admitted: from here on the messages are the agent's responsibility, and a close that
        // begins now waits for them rather than resolving over the top of them.
        const admitted =
            agentStorageTransaction(ctx) === undefined
                ? this.#enqueueIndependently(ctx, batch)
                : this.#enqueueInTransaction(ctx, batch);
        this.#admitted.add(admitted);
        this.#messageAdmissions.add(admitted);
        try {
            return await admitted;
        } finally {
            this.#admitted.delete(admitted);
            this.#messageAdmissions.delete(admitted);
        }
    }

    /** Accept a batch in a transaction of the acceptance's own. */
    async #enqueueIndependently(
        ctx: Context,
        batch: readonly QueueRequest[],
    ): Promise<readonly AgentMessageAcceptance[]> {
        return await this.#runPersistenceStep(ctx, async (lockCtx) => {
            const accepted: { readonly key: string; readonly request: QueueRequest }[] = [];
            const results: AgentMessageAcceptance[] = [];
            await this.#recordTransaction(lockCtx, async (txCtx) => {
                let activated = false;
                for (const request of batch) {
                    const identityKey = `message.${request.id}`;
                    if (!(await this.#persistence.writeValueIfAbsent(txCtx, identityKey, true))) {
                        results.push({
                            id: request.id,
                            delivery: request.kind === "steering" ? "steer" : "send",
                            accepted: "existing",
                        });
                        continue;
                    }
                    const key = await this.#queueKey(txCtx, `${request.kind}.`);
                    await this.#persistence.writeValue(txCtx, key, {
                        id: request.id,
                        message: request.message,
                        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
                        options: request.options,
                    });
                    accepted.push({ key, request });
                    results.push({
                        id: request.id,
                        delivery: request.kind === "steering" ? "steer" : "send",
                        accepted: "created",
                    });
                }
                if (accepted.length === 0) return;
                // Accepting a message is what makes the work owed: the same transaction that
                // admits it records that the agent owes an answer, so a process that dies right
                // here is discovered still owing it rather than looking idle over a full queue.
                // Creating that record where none existed is what makes a settled agent active,
                // and the activation hook commits with the very transaction that admits the
                // message.
                if (await this.#claimPendingWork(txCtx)) {
                    await this.#announceActivation(txCtx, false);
                    activated = true;
                }
                afterCommit(txCtx, () => {
                    if (activated) {
                        this.#activationAnnounced = true;
                        this.#restoreActivationOwed = false;
                    }
                    for (const { key, request } of accepted) {
                        const queue = request.kind === "steering" ? this.#steering : this.#sends;
                        queue.push({
                            key,
                            id: request.id,
                            message: request.message,
                            ...(request.metadata === undefined
                                ? {}
                                : { metadata: request.metadata }),
                            options: request.options,
                        });
                    }
                    this.#turnRequested = true;
                    this.#startRun();
                });
            });
            return results;
        });
    }

    /**
     * Accept a batch inside the caller's own open transaction. The outer transaction supplies
     * atomicity, queue keys are claimed with absent-only writes so a racing independent enqueue
     * cannot be overwritten, and no heap state changes until the commit publishes the batch.
     */
    async #enqueueInTransaction(
        ctx: Context,
        batch: readonly QueueRequest[],
    ): Promise<readonly AgentMessageAcceptance[]> {
        const results: AgentMessageAcceptance[] = [];
        let acceptedAny = false;
        for (const request of batch) {
            const identityKey = `message.${request.id}`;
            if (!(await this.#persistence.writeValueIfAbsent(ctx, identityKey, true))) {
                results.push({
                    id: request.id,
                    delivery: request.kind === "steering" ? "steer" : "send",
                    accepted: "existing",
                });
                continue;
            }
            await this.#claimQueueKey(ctx, `${request.kind}.`, {
                id: request.id,
                message: request.message,
                ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
                options: request.options,
            });
            acceptedAny = true;
            results.push({
                id: request.id,
                delivery: request.kind === "steering" ? "steer" : "send",
                accepted: "created",
            });
        }
        // Accepting a message is what makes the work owed, so the same transaction that admits
        // it records that the agent owes an answer; here that record is staged durably and made
        // live only once the outermost commit publishes the whole batch.
        const staged = acceptedAny ? await this.#stagePendingMessageWork(ctx) : undefined;
        // Scheduling onto a settled agent is what makes it active; the announcement writes into
        // the caller's own transaction and is published or rolled back with the batch itself.
        if (staged?.activated === true) await this.#announceActivation(ctx, false);
        const offeredIds = batch.map(({ id }) => id);
        afterCommit(ctx, async () => {
            await this.#activateCommittedMessages(offeredIds, staged);
        });
        return results;
    }

    /**
     * Persist the pending inference an outer transaction will make live after commit, without
     * changing any heap state that would survive a rollback. Whether the agent was settled is
     * decided by the store's own absent-only insert of the pending record, so concurrent
     * transactions waking the same agent are arbitrated by the database itself: exactly one
     * creates the record and activates. Reading the transaction's current value on the taken
     * path also makes multiple sends in one outer transaction reuse the same lifecycle IDs.
     */
    async #stagePendingMessageWork(
        ctx: Context,
    ): Promise<{ readonly pending: AgentBasePendingState; readonly activated: boolean }> {
        const fresh: AgentBasePendingState = { stage: "inference", loopId: createId() };
        if (await this.#persistence.writeValueIfAbsent(ctx, AGENT_BASE_PENDING_KEY, fresh)) {
            return { pending: fresh, activated: true };
        }
        const stored = await agentBasePendingStateOf(ctx, this.#persistence);
        // A record that is present but unreadable counts as no pending state, as everywhere
        // else, so this transaction still claims the activation when it replaces one.
        const pending: AgentBasePendingState =
            stored === undefined ? fresh : { ...stored, stage: "inference" };
        await this.#persistence.writeValue(ctx, AGENT_BASE_PENDING_KEY, pending);
        return { pending, activated: stored === undefined };
    }

    /**
     * Publish a transactionally accepted message only after the outermost commit. The next safe
     * queue boundary merges its durable queue entries into memory; the dirty marker prevents a
     * turn already in flight from clearing the request before that merge.
     */
    async #activateCommittedMessages(
        offeredIds: readonly string[],
        staged:
            | { readonly pending: AgentBasePendingState; readonly activated: boolean }
            | undefined,
    ): Promise<void> {
        for (const id of offeredIds) this.#offeredMessageIds.add(id);
        if (staged === undefined) return;
        // The commit published the staged activation announcement along with the batch, so the
        // current active period is now an announced one.
        if (staged.activated) {
            this.#activationAnnounced = true;
            this.#restoreActivationOwed = false;
        }
        await this.#runPersistenceStep(this.#ctx, async (lockCtx) => {
            let pending = staged.pending;
            try {
                pending =
                    (await agentBasePendingStateOf(lockCtx, this.#persistence)) ?? staged.pending;
            } catch {
                // The committed staged value is enough to start; a turn reload retries storage.
            }
            // A run in flight holds its lifecycle IDs across many lock acquisitions, so adopting
            // over it would tear the identities out from under a live turn. That run reaches the
            // committed batch through the dirty marker instead; adoption is for an idle agent
            // whose next run should continue exactly what the commit recorded.
            if (this.#runPromise === undefined) {
                this.#adoptPendingState(pending);
            }
            this.#committedQueueDirty = true;
        });
        this.#turnRequested = true;
        this.#startRun();
    }

    /** Make one committed pending record the exact in-memory lifecycle state. */
    #adoptPendingState(pending: AgentBasePendingState): void {
        this.#pending = pending;
        this.#pendingWritten = deterministicStringify(pending);
        this.#loopId = pending.loopId;
        this.#turnId = pending.turnId;
        this.#inferenceId = pending.inferenceId;
        this.#settlementId = pending.settlementId;
    }

    /** Durably queue hook notices until history reaches a safe append boundary. */
    async #enqueueInjections(ctx: Context, batch: readonly SessionSystemMessage[]): Promise<void> {
        if (batch.length === 0) return;
        if (this.#closed) throw new Error("The agent has been closed.");
        await this.#runPersistenceStep(ctx, async (lockCtx) => {
            const accepted: InjectionEntry[] = [];
            await this.#recordTransaction(lockCtx, async (txCtx) => {
                let activated = false;
                for (const message of batch) {
                    const key = await this.#queueKey(txCtx, "inject.");
                    await this.#persistence.writeValue(txCtx, key, message);
                    accepted.push({ key, message });
                }
                if (accepted.length === 0) return;
                if (await this.#claimPendingWork(txCtx)) {
                    await this.#announceActivation(txCtx, false);
                    activated = true;
                }
                afterCommit(txCtx, () => {
                    if (activated) {
                        this.#activationAnnounced = true;
                        this.#restoreActivationOwed = false;
                    }
                    this.#injections.push(...accepted);
                    this.#turnRequested = true;
                    this.#startRun();
                });
            });
        });
    }

    /**
     * Start the loop without a new message: load the durable state and, if a turn was cut off —
     * queued messages, a dispatched tool batch without results, or an unanswered user or tool
     * message — continue it to completion. On an idle history this loads and does nothing more.
     */
    start(): void {
        if (this.#closed) throw new Error("The agent has been closed.");
        this.#startRun();
    }

    /**
     * Stop this loop at its next durable edge without cancelling its current operation. The mode
     * is sticky: later queue writes remain durable but cannot start another run in this process.
     */
    drain(): Promise<void> {
        this.#draining = true;
        this.#drainPromise ??= this.#finishDrain();
        return this.#drainPromise;
    }

    /** Wait for operations already handed to this agent and the run they may have started. */
    async #finishDrain(): Promise<void> {
        try {
            await Promise.resolve();
            while (this.#admitted.size > 0 || this.#runPromise !== undefined) {
                await Promise.allSettled(this.#admitted);
                await this.#runPromise?.catch(() => undefined);
            }
        } finally {
            this.#drainFinished = true;
        }
    }

    /**
     * Wait until the agent has nothing left to do. That includes work it has taken on but not yet
     * started: an operation whose caller did not wait for it is registered from the moment it is
     * called, so a message asked for and abandoned is still something this waits for, rather than
     * a race between the caller's next line and the agent's own lock.
     */
    async waitForIdle(): Promise<void> {
        while (this.#admitted.size > 0 || this.#runPromise !== undefined) {
            await Promise.allSettled([...this.#admitted]);
            await this.#runPromise;
        }
    }

    /**
     * Compact the conversation. The compaction waits for the active response and its tool batch
     * to settle — or runs right away when idle — then replaces the history before another
     * inference iteration. The provider's replacement keeps every message it retained.
     *
     * Returns once the compaction has been asked for. Concurrent requests share one compaction.
     */
    async compact(ctx: Context): Promise<void> {
        if (this.#closed) throw new Error("The agent has been closed.");
        if (agentStorageTransaction(ctx) !== undefined) {
            afterCommit(ctx, () => {
                outsideAgentDatabaseOperation(() => {
                    void this.compact(this.#ctx).catch((error: unknown) => {
                        this.#ctx.log.warn("The committed agent compaction failed.", error);
                    });
                });
            });
            return;
        }
        const compaction = this.#ensureCompaction();
        compaction.catch(() => undefined);
    }

    /**
     * End a compaction nobody will carry out. A compaction that already ran has settled its own
     * promise, so this only ever reaches one that was requested and then abandoned.
     */
    #settlePendingCompaction(reason: string): void {
        const pending = this.#compaction;
        if (pending === undefined) return;
        this.#compaction = undefined;
        pending.reject(new Error(reason));
    }

    /**
     * The pending compaction, requesting one if none is pending. Every caller shares the same
     * promise, and the request is what starts the loop that will carry it out.
     */
    #ensureCompaction(): Promise<void> {
        if (this.#compaction === undefined) {
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.#compaction = { promise, resolve, reject };
            this.#turnRequested = true;
            this.#startRun();
        }
        return this.#compaction.promise;
    }

    /**
     * Track work that outlived the response it belonged to, so the next request can wait for it.
     * Failures are the unwinding work's own business and never reach the turn.
     */
    #settleLater(work: Promise<unknown>, kind: "stream" | "tool"): void {
        const tracked = work
            .catch(() => undefined)
            .finally(() => {
                this.#settling.delete(tracked);
                this.#streamCleanup.delete(tracked);
            });
        this.#settling.add(tracked);
        // A close waits for the stream to let go of the session before destroying it, but never
        // for a tool: a tool that ignores being abandoned would otherwise hold the shutdown open
        // for ever, and it may well be blocked on that very shutdown.
        if (kind === "stream") this.#streamCleanup.add(tracked);
    }

    /** Wait until no response iterator is still releasing the provider session. */
    async #streamsReleased(): Promise<void> {
        while (this.#streamCleanup.size > 0) {
            await Promise.allSettled([...this.#streamCleanup]);
        }
    }

    /** Wait until nothing from an earlier response is still holding the provider session. */
    async #settled(): Promise<void> {
        while (this.#settling.size > 0) {
            await Promise.allSettled([...this.#settling]);
        }
    }

    /**
     * The system prompt for the next request: the mutable state extended by the hook's answer.
     * Instructions and tools are correctness hooks — a failure here fails the turn loudly
     * instead of silently running with a wrong configuration.
     */
    async #instructions(ctx: Context): Promise<string> {
        const hooked = await this.#hooks.instructions?.(this.#workContext(ctx));
        return [this.state.instructions, hooked ?? ""]
            .filter((text) => text.length > 0)
            .join("\n\n");
    }

    /**
     * The tools for the next request or execution: the mutable state extended by the hook's
     * answer. Two tools sharing one name and namespace are a configuration error that fails
     * the turn, since the provider would receive ambiguous descriptors.
     */
    async #tools(ctx: Context): Promise<readonly AnyAgentTool[]> {
        const hooked = await this.#hooks.tools?.(this.#workContext(ctx));
        const tools = [...this.state.tools, ...(hooked ?? [])];
        const names = new Set<string>();
        for (const tool of tools) {
            const key = `${tool.namespace ?? ""}\u0000${tool.name}`;
            if (names.has(key)) {
                throw new Error(
                    tool.namespace === undefined
                        ? `Two tools are registered as "${tool.name}".`
                        : `Two tools are registered as "${tool.name}" in namespace "${tool.namespace}".`,
                );
            }
            names.add(key);
        }
        return tools;
    }

    /**
     * Cancel the active turn: stop consuming the inference stream, settle still-running tool calls
     * as aborted error results, and drop the queued turn request. Blocks that already finished
     * stay in the history; an unfinished block is dropped. Messages still waiting in the steering
     * and send queues stay durable and join the next requested turn. A no-op when the agent is
     * idle.
     *
     * Returns once the cancellation has been signalled.
     */
    async abort(ctx: Context): Promise<void> {
        if (agentStorageTransaction(ctx) !== undefined) {
            afterCommit(ctx, () => {
                outsideAgentDatabaseOperation(() => {
                    void this.abort(this.#ctx).catch((error: unknown) => {
                        this.#ctx.log.warn("The committed agent abort failed.", error);
                    });
                });
            });
            return;
        }
        const run = this.#signalAbort();
        if (run === undefined) return;
        // Dropping the turn request drops the only thing that would have carried out a
        // compaction asked for during it, so its callers are told rather than left waiting for
        // a turn that will never come. That happens once the loop has stopped, whether or not
        // anyone here is waiting to see it.
        void run
            .catch(() => undefined)
            .then(() => {
                this.#settlePendingCompaction("The compaction was cancelled by an abort.");
            });
    }

    /**
     * Signal cancellation of the active turn. Answers with the run to wait for, or undefined
     * when the agent was already idle and there was nothing to cancel.
     */
    #signalAbort(): Promise<void> | undefined {
        const run = this.#runPromise;
        if (run === undefined) return undefined;
        // An abort drops ordinary requested continuation, but a notice already appended to
        // history remains owed one provider request and must reopen under a fresh abort scope.
        this.#turnRequested = this.#hasNoticeWorkToFinish();
        this.#abortController?.abort();
        return run;
    }

    /**
     * Stop the agent, without abandoning anything it had already taken on. Nothing new is
     * admitted from the moment close is called, but a message accepted just before it is still
     * written, still answered, and only then is the provider session destroyed — so a caller
     * whose send resolved never has to wonder whether the close raced it. Closing twice awaits
     * the same shutdown.
     *
     * A close is nothing but a wait, so it is refused from inside the agent's own run loop, where
     * the wait could never end. It is the one operation with no context to check, so it asks the
     * runtime instead.
     *
     * Running tool calls are the exception to finishing what was accepted. From the moment close
     * begins, the batch stops waiting for them and settles them in the conversation as error
     * results. A tool can perfectly well be blocked on this very close — that is how two agents
     * closing each other through their tools would otherwise wedge — and no tool is worth
     * letting the shutdown never finish.
     */
    async close(): Promise<void> {
        // A close asked for from inside the loop is the one case that cannot cut the loop short,
        // because the work it would abandon is the caller itself.
        const fromInsideOwnLoop = this.#insideOwnLoop();
        this.#closed = true;
        // Graceful shutdown stops at the next operation boundary. Do not abort a tool that is
        // already running; the coordinator's timeout and the daemon's hard exit bound one that
        // never returns.
        if (!fromInsideOwnLoop && !this.#stopAtSafeEdgeRequested()) {
            this.#closeController.abort();
        }
        // The barrier is published before any of the shutdown runs. Destroying the provider
        // session can reenter close, and a caller arriving then has to join this shutdown rather
        // than start a second one that destroys the same session again.
        this.#closing ??= (async () => {
            await Promise.resolve();
            // Each admitted operation can still request a turn, and that turn can be the thing
            // that finishes the work, so both are drained until neither has anything left.
            while (this.#admitted.size > 0 || this.#runPromise !== undefined) {
                await Promise.allSettled([...this.#admitted]);
                await this.#runPromise?.catch(() => undefined);
            }
            this.#settlePendingCompaction("The agent was closed before the compaction ran.");
            // Close is the final ownership boundary for the provider session. A response
            // iterator that has not finished releasing it still holds it, and destroying it
            // underneath that cleanup hands the provider two owners at once.
            await this.#streamsReleased();
            await this.#session?.destroy();
            this.#session = undefined;
        })();
        if (!fromInsideOwnLoop) {
            await this.#closing;
            return;
        }
        // The caller is something the loop is waiting for. If the shutdown completes anyway the
        // caller had already let go and hears the truth; if it does not, the loop is still
        // waiting for this very caller, and saying so beats waiting for oneself for ever. The
        // shutdown itself continues regardless — it is the report that is given up on.
        const shutdown = this.#closing.then(
            () => true,
            () => true,
        );
        const settled = await Promise.race([
            shutdown,
            new Promise<false>((resolve) => {
                setTimeout(() => resolve(false), INSIDE_CLOSE_REPORT_MS).unref?.();
            }),
        ]);
        if (!settled) {
            // The caller cannot wait for its own turn, but the agent is closing all the same.
            // Revoke the caller's tool/store capability before reporting the cyclic wait so it
            // cannot resume later and write after the owning system releases its store lock.
            this.#closeController.abort();
            throw new Error(
                "Closing the agent from inside its own run loop would wait for a turn that " +
                    "cannot finish. The shutdown was started and will complete once this " +
                    "caller returns.",
            );
        }
        await this.#closing;
    }

    /**
     * Wait for a close that has already been requested to finish. Unlike `close`, this never
     * initiates shutdown, so owners can separate the caller-facing reentrancy report from the
     * underlying lifetime barrier.
     */
    async waitForClosed(): Promise<void> {
        const closing = this.#closing;
        if (closing === undefined) throw new Error("The agent has not been asked to close.");
        await closing;
    }

    /**
     * Make sure the run loop is running. A loop already in flight picks up the request on its
     * next pass, so this never starts a second one.
     */
    #startRun(): void {
        if (this.#runPromise !== undefined || this.#draining) return;
        // The loop is a lifetime of its own, so it marks itself rather than inheriting whatever
        // happened to start it — a tool of another agent, most often, which will be long gone.
        this.#runPromise = outsideAgentDatabaseOperation(() =>
            insideLoops
                .run([this.id], () => this.#runLoop())
                .finally(() => {
                    this.#runPromise = undefined;
                    // A request that arrived while the loop was settling would otherwise be stranded:
                    // the loop had stopped checking, and the caller's own `#startRun` saw a run still
                    // in flight. Waiters re-check the field, so they pick this continuation up.
                    if (this.#turnRequested && !this.#closed && !this.#draining) {
                        this.#startRun();
                        return;
                    }
                    this.#announceSettled();
                }),
        );
    }

    /**
     * Answer turns until nothing is asked for any more. The inner loop is one turn each: reload
     * the durable state, ask the pre-turn hooks what to do, run the inference and its tools, then
     * ask the post-turn hooks. The outer loop reopens when an `afterAgentLoop` action asks for
     * more work, so the loop hooks always bracket a settled-to-settled span.
     */
    async #runLoop(): Promise<void> {
        // The run is a stretch of work of its own, and the context of its span is the one the
        // whole of it runs on. Everything below is handed that context rather than reading a
        // scope back off the agent, so each turn, inference, tool call, and hook is placed in
        // the run it actually belongs to even while another agent is running alongside it.
        await this.#span(this.#ctx, "agent.run", {}, (ctx) => this.#runTurns(ctx));
    }

    /** The run itself, on the context of the span the whole of it belongs to. */
    async #runTurns(ctx: Context): Promise<void> {
        if (this.#stopAtSafeEdgeRequested()) return;
        if (this.#pending?.stage === "settlement") {
            // A prior implementation could advance to settlement while a dispatched tool was
            // still open. Never repeat that conclusion on restore: load the real history, settle
            // only a complete conversation, and otherwise fall through to the ordinary loop
            // that resumes the tool batch first.
            await this.#ensureLoaded(ctx);
            if (!this.#hasOpenToolCalls()) {
                this.#loopId ??= createId();
                this.#settlementId ??= createId();
                setAgentSpanAttributes(ctx, { "agent.loop.id": this.#loopId });
                await this.#settleDurably(ctx, {
                    loopId: this.#loopId,
                    settlementId: this.#settlementId,
                });
                return;
            }
        }
        // The outer loop reopens when an `afterAgentLoop` action requests more work, so the
        // loop hooks always bracket a settled-to-settled span.
        //
        // A failure thrown out of it is still the end of the run, so it is remembered rather than
        // rethrown and the settle below happens exactly as it would have. An agent that stopped
        // working while its store still says it is working is one nobody is ever told about:
        // whoever is waiting on it — an owner, or the creator of a collaborator — waits for a
        // turn no process is running any more.
        let outcome: "blocked" | "settling" | "shutdown" = "settling";
        try {
            outcome = await this.#runLoops(ctx);
        } catch (error: unknown) {
            this.#runFailure = error instanceof Error ? error.message : String(error);
            // The request that opened this run is answered by the failure, however badly. Left
            // standing, it would start the run again the moment this one settles, and whatever
            // made the run throw would make the next one throw too — for ever, without anything
            // in between ever reaching the model.
            this.#turnRequested = false;
        }
        // A run that could not settle a staged tool result is the one exception: it must leave
        // its pending state exactly as it found it, for the next attempt to finish.
        if (outcome === "shutdown" || outcome === "blocked" || this.#hasOpenToolCalls()) return;
        // Nothing is asked for any more, so the outstanding work is erased. That erasure is what
        // makes the agent idle, and it commits together with whatever the settling hooks write,
        // so no owner can ever see the agent finished without their conclusions or their
        // conclusions without the agent being finished.
        this.#settlementId ??= createId();
        await this.#enterStage(ctx, "settlement");
        await this.#settleDurably(ctx, {
            loopId: this.#loopId ?? createId(),
            settlementId: this.#settlementId,
            ...(this.#runFailure === undefined ? {} : { error: this.#runFailure }),
        });
    }

    /**
     * Every loop of the run, one after another: each opens with its loop hooks, answers turns
     * until nothing more is asked for, and closes with them. It answers whether the run ended
     * because there was nothing left to do or because a staged tool result could not settle; the
     * settling caller above decides what that ending means.
     */
    async #runLoops(ctx: Context): Promise<"blocked" | "settling" | "shutdown"> {
        do {
            if (this.#stopAtSafeEdgeRequested()) return "shutdown";
            this.#loopId ??= createId();
            const loop: AgentBaseLoop = { loopId: this.#loopId };
            setAgentSpanAttributes(ctx, { "agent.loop.id": loop.loopId });
            // The abort scope opens before the loop hook, not just before the turn. An abort
            // owns everything the run does — its opening hook as much as its inference — so a
            // run cancelled while it is still starting up never reaches the model at all.
            let abort = this.#openAbortScope();
            // The agent is working from here, and says so durably before it does anything a
            // crash could interrupt. What it records is refined as the run reaches each stage;
            // what matters at this point is that the record exists at all, since its absence is
            // what a later process reads as an agent that finished.
            await this.#enterStage(
                ctx,
                "inference",
                this.#hooks.beforeAgentLoopTransact === undefined
                    ? undefined
                    : (hookCtx) => this.#hooks.beforeAgentLoopTransact?.(hookCtx, loop),
            );
            await this.#invokeHook(ctx, this.#hooks.beforeAgentLoop, loop);
            if (this.#stopAtSafeEdgeRequested()) return "shutdown";
            do {
                const outcome = await this.#span(
                    ctx,
                    "agent.turn",
                    { "agent.loop.id": loop.loopId },
                    (turnCtx) => this.#runTurn(turnCtx, loop, abort),
                );
                if (outcome === "blocked") return "blocked";
                if (outcome === "shutdown") return "shutdown";
                if (outcome === "stop") break;
                // Each turn cancels on its own scope. Reopening it here rather than at the top
                // keeps the run's first turn under the scope its opening hook already ran in.
                abort = this.#openAbortScope();
            } while (true);
            await this.#enterStage(
                ctx,
                "inference",
                this.#hooks.afterAgentLoopTransact === undefined
                    ? undefined
                    : (hookCtx) => this.#hooks.afterAgentLoopTransact?.(hookCtx, loop),
            );
            await this.#applyActions(ctx, this.#hooks.afterAgentLoop, abort.signal, loop);
            if (this.#stopAtSafeEdgeRequested()) return "shutdown";
        } while (this.#turnRequested && (!this.#closed || this.#hasNoticeWorkToFinish()));
        return "settling";
    }

    /**
     * One turn: reload the durable state, ask the pre-turn hooks what to do, run the inference
     * and its tools, then ask the post-turn hooks. It answers with what the run should do next —
     * open another turn, stop because nothing more is asked for, or give up entirely because a
     * staged tool result could not settle and this run must leave its pending state intact.
     */
    async #runTurn(
        ctx: Context,
        loop: AgentBaseLoop,
        abort: AbortController,
    ): Promise<"continue" | "stop" | "blocked" | "shutdown"> {
        this.#turnAborted = false;
        this.#durableWorkBlocked = false;
        // A failure the run has moved on from is not what its settlement reports: the turn that
        // failed is over, and this one is the run's answer to it.
        this.#runFailure = undefined;
        this.#turnId ??= createId();
        setAgentSpanAttributes(ctx, { "agent.turn.id": this.#turnId });
        // Claimed before any awaiting, so a request raised while the turn is still starting up
        // survives into another turn instead of being cleared by it. The redundant turn this can
        // cost is cheap: an empty queue drains without any inference.
        this.#turnRequested = false;
        // Every turn starts from durable state rather than from what this instance last
        // remembered, so the store remains authoritative after recovery.
        this.#loaded = undefined;
        // The durable history has to be loaded before anything else: a turn that cannot read the
        // conversation cannot answer it, and must not write to it either — appending to a
        // conversation it cannot see is how a message ends up after a tool call nobody answered.
        // The turn ends here instead, leaving everything durable exactly as it was for the next
        // attempt.
        const loadFailure = await this.#ensureLoaded(ctx).then(
            () => undefined,
            (error: unknown) => error,
        );
        if (loadFailure !== undefined) {
            const message =
                loadFailure instanceof Error ? loadFailure.message : String(loadFailure);
            this.#runFailure = message;
            await this.#emit(ctx, {
                type: "done",
                state: "error",
                kind: "internal_error",
                message,
            });
            this.#turnId = undefined;
            return "stop";
        }
        const turnStart = {
            loopId: loop.loopId,
            turnId: this.#turnId,
            contextTokens: this.#contextTokens,
        };
        await this.#enterStage(
            ctx,
            "inference",
            this.#hooks.beforeTurnTransact === undefined
                ? undefined
                : (hookCtx) => this.#hooks.beforeTurnTransact?.(hookCtx, turnStart),
        );
        await this.#applyActions(ctx, this.#hooks.beforeTurn, abort.signal, turnStart);
        if (this.#stopAtSafeEdgeRequested()) return "shutdown";
        if ((await this.#runInference(ctx, abort)) === "shutdown") return "shutdown";
        if (this.#durableWorkBlocked) return "blocked";
        const turn = {
            loopId: loop.loopId,
            turnId: turnStart.turnId,
            contextTokens: this.#contextTokens,
            aborted: this.#turnAborted,
        };
        const completedTurnId = this.#turnId;
        this.#turnId = undefined;
        try {
            await this.#enterStage(
                ctx,
                "inference",
                this.#hooks.afterTurnTransact === undefined
                    ? undefined
                    : (hookCtx) => this.#hooks.afterTurnTransact?.(hookCtx, turn),
            );
        } catch (error: unknown) {
            this.#turnId = completedTurnId;
            throw error;
        }
        await this.#applyActions(ctx, this.#hooks.afterTurn, abort.signal, turn);
        if (this.#stopAtSafeEdgeRequested()) return "shutdown";
        if (!this.#turnRequested || (this.#closed && !this.#hasNoticeWorkToFinish())) {
            return "stop";
        }
        return "continue";
    }

    /**
     * Erase the outstanding work and let the transactional settling hooks write in the same
     * transaction. A failure leaves the record in place: an agent wrongly believed to be working
     * is resumed and finds nothing to do, while one wrongly believed to be finished is never
     * resumed at all.
     */
    async #settleDurably(ctx: Context, settlement: AgentBaseSettlement): Promise<void> {
        await this.#span(
            ctx,
            "agent.settle",
            {
                "agent.loop.id": settlement.loopId,
                "agent.settlement.id": settlement.settlementId,
                ...(settlement.error === undefined
                    ? {}
                    : { "agent.settlement.error": settlement.error }),
            },
            (settleCtx) => this.#settleRecord(settleCtx, settlement),
        );
    }

    /** The settlement itself, on the context of the span it belongs to. */
    async #settleRecord(ctx: Context, settlement: AgentBaseSettlement): Promise<void> {
        try {
            await this.#runPersistenceStep(this.#workContext(ctx), (lockCtx) =>
                this.#recordTransaction(lockCtx, async (txCtx) => {
                    await this.#clearPending(txCtx);
                    await this.#invokeTransactionalSettle(txCtx, settlement);
                    // The run store is erased last, so a settling hook can still read what the
                    // run concluded and keep whatever part of it belongs to the conversation.
                    // It commits with the settlement: the run is over and its notes are gone as
                    // one fact, never one without the other.
                    await this.#clearRunStore(txCtx);
                }),
            );
            this.#loopId = undefined;
            this.#turnId = undefined;
            this.#inferenceId = undefined;
            // The failure has been reported by the settlement it belongs to; the next run starts
            // out having nothing to answer for.
            this.#runFailure = undefined;
            this.#settlementId = undefined;
            this.#settlement = settlement;
            // Settled means nothing is owed: the next scheduled message activates the agent
            // afresh, and nothing inherited remains to announce.
            this.#activationAnnounced = false;
            this.#restoreActivationOwed = false;
        } catch {
            // The run itself is over and succeeded; only the record of its ending failed.
        }
    }

    /**
     * Call the settling hooks that write inside the settling transaction. They run on a context
     * that lives exactly as long as the transaction does, so a store they keep hold of cannot be
     * used to write once the settlement has committed. A throwing hook rolls the settlement back
     * with it, because a hook here is writing a conclusion about the very fact being committed,
     * and half of that pair is worse than neither.
     */
    async #invokeTransactionalSettle(
        txCtx: Context,
        settlement: AgentBaseSettlement,
    ): Promise<void> {
        const hook = this.#hooks.afterAgentSettledTransact;
        if (hook === undefined) return;
        await this.#withTransactionalContext(insideTurn.set(txCtx, []), (liveCtx) =>
            hook(liveCtx, settlement),
        );
    }

    /**
     * Erase everything the run wrote about itself, inside the transaction that settles the agent:
     * the clear runs on that transaction's own context, so it commits with the settlement.
     */
    async #clearRunStore(txCtx: Context): Promise<void> {
        await this.#runKV.clear(txCtx);
    }

    /**
     * Open the scope the next stretch of work is cancelled on, and make it the one an abort
     * signals. A cancellation that arrived before this point is not carried into the new scope:
     * it cancelled the work it was aimed at, and that work is over.
     */
    #openAbortScope(): AbortController {
        const abort = new AbortController();
        this.#abortController = abort;
        return abort;
    }

    /**
     * Commit and announce the settle, once the loop has actually stopped rather than as its last
     * act. The difference matters to whoever is listening: a hook told the agent has settled is
     * being told something it can act on, and asking for a compaction — or anything else the
     * loop carries out — has to reach a loop that can still be started.
     *
     * The work is admitted rather than left to run loose, so an idle agent is one whose settle
     * has finished, and a close waits for it like anything else it took on.
     */
    #announceSettled(): void {
        const announced = (async () => {
            // The settle runs once the loop has stopped, so its hook is not inside a turn and
            // its context does not claim to be: a compaction it waits for reaches a loop that
            // can still be started.
            const settlement = this.#settlement;
            if (settlement !== undefined) {
                await this.#invokeHookOn(
                    insideTurn.set(this.#ctx, []),
                    this.#hooks.afterAgentSettled,
                    settlement,
                );
                this.#settlement = undefined;
            }
        })();
        this.#admitted.add(announced);
        void announced.finally(() => this.#admitted.delete(announced));
    }

    /** Call an observing hook on the given context; a throwing hook is swallowed, never fatal. */
    async #invokeHookOn<Arguments extends readonly unknown[]>(
        ctx: Context,
        hook: ((ctx: Context, ...args: Arguments) => MaybePromise<void>) | undefined,
        ...args: Arguments
    ): Promise<void> {
        try {
            await hook?.(ctx, ...args);
        } catch {
            // Hooks observe the run; they never fail it.
        }
    }

    /** Call an observing hook on the context the work in progress is running on. */
    async #invokeHook<Arguments extends readonly unknown[]>(
        ctx: Context,
        hook: ((ctx: Context, ...args: Arguments) => MaybePromise<void>) | undefined,
        ...args: Arguments
    ): Promise<void> {
        await this.#invokeHookOn(this.#workContext(ctx), hook, ...args);
    }

    /**
     * Lend a hook the transaction's context and module stores for exactly one callback. Keeping
     * the context after the callback cannot leak a transaction past its commit.
     */
    async #withTransactionalContext<Result>(
        txCtx: Context,
        work: (ctx: Context) => MaybePromise<Result>,
    ): Promise<Result> {
        const lifetime = new AbortController();
        try {
            const liveCtx = withLifetime(txCtx, lifetime.signal);
            const hookCtx = withAgentHistoryKV(withAgentKV(liveCtx, this.#kv), this.#historyKV);
            return await work(withAgentRunKV(hookCtx, this.#runKV));
        } finally {
            lifetime.abort();
        }
    }

    /**
     * Ask a hook what to do next, on a scope that may be cancelled while the hook is still
     * thinking. An abort owns the whole of the turn it cancelled, including the answer of a hook
     * that was already running when it fired: carrying that answer out would open a fresh turn
     * out of work the caller had just cancelled. The answer is dropped rather than deferred,
     * since it was a decision about a turn that no longer exists.
     */
    async #applyActions<Arguments extends readonly unknown[]>(
        ctx: Context,
        hook:
            | ((
                  ctx: Context,
                  ...args: Arguments
              ) => MaybePromise<readonly AgentModuleAction[] | undefined>)
            | undefined,
        signal: AbortSignal,
        ...args: Arguments
    ): Promise<void> {
        if (hook === undefined) return;
        let actions: readonly AgentModuleAction[] | undefined;
        try {
            actions = await hook(this.#workContext(ctx), ...args);
        } catch {
            return;
        }
        if (signal.aborted) return;
        await this.#carryOutActions(ctx, actions);
    }

    /**
     * Ask a lifecycle hook what to do next and carry its actions out: queue steering, sent
     * messages, or system notices through their durable paths, or trigger compaction. Every
     * returned action is applied before the loop continues.
     * Neither a throwing hook nor a failing action ever fails the run. Unlike `#applyActions`
     * this belongs to no turn's scope, so nothing can cancel the answer out from under it.
     */
    async #applyActionsAlways<Arguments extends readonly unknown[]>(
        ctx: Context,
        hook:
            | ((
                  ctx: Context,
                  ...args: Arguments
              ) => MaybePromise<readonly AgentModuleAction[] | undefined>)
            | undefined,
        ...args: Arguments
    ): Promise<void> {
        if (hook === undefined) return;
        let actions: readonly AgentModuleAction[] | undefined;
        try {
            actions = await hook(this.#workContext(ctx), ...args);
        } catch {
            return;
        }
        await this.#carryOutActions(ctx, actions);
    }

    /**
     * Carry out what a hook asked for. User messages keep their ordinary queues; system notices
     * enter a separate durable queue consumed only at a safe history boundary.
     */
    async #carryOutActions(
        ctx: Context,
        actions: readonly AgentModuleAction[] | undefined,
    ): Promise<void> {
        const batch: QueueRequest[] = [];
        const injections: SessionSystemMessage[] = [];
        const flush = async (): Promise<void> => {
            const pending = batch.splice(0, batch.length);
            const pendingInjections = injections.splice(0, injections.length);
            const workCtx = this.#workContext(ctx);
            try {
                await this.#enqueue(workCtx, pending);
                await this.#enqueueInjections(workCtx, pendingInjections);
            } catch {
                // A hook-driven action must not fail the run.
            }
        };
        for (const action of actions ?? []) {
            if (action.type === "compact") {
                await flush();
                this.#ensureCompaction().catch(() => undefined);
                continue;
            }
            if (action.type === "inject") {
                injections.push(structuredClone(action.message));
                continue;
            }
            const id = action.id ?? createId();
            if (!Value.Check(cuid2Schema, id)) continue;
            let metadata: AgentMessageMetadata | undefined;
            try {
                metadata = ownAgentMessageMetadata(action.metadata);
            } catch {
                continue;
            }
            batch.push({
                kind: action.type === "steer" ? "steering" : "send",
                id,
                message: structuredClone(action.message),
                ...(metadata === undefined ? {} : { metadata }),
                options: {},
            });
        }
        await flush();
    }

    /**
     * One turn's work: resume an interrupted tool batch, run a requested compaction, then cycle
     * between draining the queues and asking the model, dispatching each response's tool calls,
     * until nothing is owed an answer. Every failure is caught here and surfaced to the
     * conversation, so a turn ends with a complete context whatever went wrong.
     */
    async #runInference(ctx: Context, abort: AbortController): Promise<"complete" | "shutdown"> {
        // One shared promise for the turn's scope keeps races from piling up listeners on the
        // signal, and a scope that was aborted before this point settles it immediately: a
        // listener added afterwards would never hear the event that already happened.
        const abortPromise = abort.signal.aborted
            ? Promise.resolve(ABORTED)
            : new Promise<typeof ABORTED>((resolve) => {
                  abort.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
              });
        try {
            if (this.#stopAtSafeEdgeRequested()) return "shutdown";
            await this.#ensureLoaded(ctx);
            // A completed block proves the inherited provider request already produced durable
            // content. Ordinarily afterInference retires its identity before any tool batch or
            // later request. A process that stopped before that transaction leaves the old ID on
            // the inference stage; carrying it onward would give two provider requests one
            // identity. Retire it at the first loaded edge.
            if (
                this.#inferenceId !== undefined &&
                this.#lastRecordType === "block" &&
                this.#inherited?.stage === "inference"
            ) {
                this.#inferenceId = undefined;
            }
            // Resume a tool batch that was dispatched but cut off before its results landed, so
            // the interrupted results reach the main store before any queued message.
            const resumed = this.#pendingTools;
            const undispatched = this.#pendingToolsUndispatched;
            this.#pendingTools = [];
            this.#pendingToolsUndispatched = false;
            if (resumed.length > 0) {
                // A failed batch can leave an execution unwinding in this process while its
                // durable calls remain for resume. Do not retry a durable side effect beside its
                // earlier invocation; a restarted process has no such in-memory predecessor.
                if ((await Promise.race([this.#settled(), abortPromise])) === ABORTED) {
                    return "complete";
                }
                if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                // A batch that was never committed has certainly not run — the commit precedes
                // every execution — so it is dispatched as the fresh batch it never got to be,
                // rather than resumed, which would refuse the non-durable calls.
                if (
                    await this.#runToolBatch(
                        ctx,
                        resumed,
                        !undispatched,
                        abort.signal,
                        abortPromise,
                    )
                ) {
                    return this.#stopAtSafeEdgeRequested() ? "shutdown" : "complete";
                }
                if (this.#stopAtSafeEdgeRequested()) return "shutdown";
            }
            let needsInference = resumed.length > 0;
            // A requested compaction runs before this turn's first inference, so the model
            // always receives a settled conversation — never one still owing tool results.
            await this.#runCompaction(ctx, abort.signal, needsInference);
            if (this.#stopAtSafeEdgeRequested()) return "shutdown";
            // An inference is needed without any injection when tool results from a resumed batch
            // end the context, or — checked once, against the freshly loaded durable state —
            // when a cut-off run left its trailing user or tool message unanswered. Afterwards
            // a trailing user message can be legitimate: a response may have zero blocks.
            if (!this.#recoveryChecked) {
                this.#recoveryChecked = true;
                if (await this.#resumesInterruptedRun(ctx)) needsInference = true;
            }
            // Each cycle first drains the queues, then runs one inference. Steering injects at
            // every stop between responses and always outranks sends; sent messages inject
            // only when the agent would otherwise stop — no tool results or steering remain.
            // Queue consumption happens only here, between inferences, so an injected message
            // can never interleave with an active response's block records.
            // The message of an error response that has not been recovered from yet. A later
            // successful response clears it; a turn that ends while it is set has failed and
            // surfaces it to the context as a system message.
            let pendingError: string | undefined;
            let preparedContextTokens: number | undefined | typeof UNPREPARED_CONTEXT =
                UNPREPARED_CONTEXT;
            while (true) {
                if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                // An abort during the tool batch ends the turn here, before the next inference.
                // A cancellation arriving when the turn has nothing left to do cancels nothing:
                // the last response already reported its own terminal event, and a second one
                // would contradict it for the same response.
                if (abort.signal.aborted) {
                    const hasPendingWork =
                        needsInference ||
                        this.#steering.length > 0 ||
                        this.#sends.length > 0 ||
                        this.#injections.length > 0 ||
                        this.#noticeAwaitingResponse;
                    if (hasPendingWork) await this.#emit(ctx, { type: "done", state: "cancelled" });
                    break;
                }
                // A hook may request compaction after the response that dispatched the tool
                // batch. Its results are settled now, so replace the measured context before
                // another inference iteration or newly queued input can enter it.
                await this.#runCompaction(ctx, abort.signal, needsInference);
                if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                await this.#finishAdmittedQueueWrites();
                // A message accepted through an outer transaction becomes visible only after
                // that transaction commits. Merge those durable queue entries here, at the same
                // safe boundary where independently accepted messages are already visible, so
                // steering committed during a tool batch reaches the next inference without
                // rebuilding unrelated conversation or tool state in the middle of the turn.
                if (this.#committedQueueDirty) await this.#refreshCommittedQueues(ctx);
                if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                let injected = await this.#consumeQueue(
                    ctx,
                    this.#steering,
                    this.#steeringMode,
                    "steering",
                );
                if (!injected && !needsInference) {
                    injected = await this.#consumeQueue(ctx, this.#sends, this.#sendMode, "send");
                }
                // Notices follow queue consumption so a model-switching message can replace
                // history first. Tool settlement and compaction already finished above.
                await this.#consumeInjections(ctx);
                // Nothing to answer — a start() on an idle history, or the queues ran dry.
                if (!this.#noticeAwaitingResponse && !injected && !needsInference) break;
                if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                if (preparedContextTokens !== this.#contextTokens) {
                    preparedContextTokens = this.#contextTokens;
                    const preparation = {
                        loopId: this.#loopId ?? createId(),
                        turnId: this.#turnId ?? createId(),
                        contextTokens: this.#contextTokens,
                    };
                    this.#loopId = preparation.loopId;
                    this.#turnId = preparation.turnId;
                    await this.#applyActions(
                        ctx,
                        this.#hooks.prepareInference,
                        abort.signal,
                        preparation,
                    );
                    if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                    if (this.#compaction !== undefined) {
                        // The admitted message already owns the active run, while no inference
                        // stage has opened yet. Keep its response obligation across the boundary;
                        // the next pass compacts that settled context. A failed attempt leaves the
                        // measurement prepared, so it cannot retry forever before one request.
                        needsInference = true;
                        continue;
                    }
                }
                const response = await this.#span(ctx, "agent.inference", {}, (inferenceCtx) =>
                    this.#requestInference(inferenceCtx, abortPromise),
                );
                // A cancellation arrived before the request was made, so the turn cycles rather
                // than talking to a session it may no longer own.
                if (response === undefined) continue;
                // The response commits a new provider measurement. Even the same numeric count
                // describes a new context and must be eligible for the next preparation check.
                preparedContextTokens = UNPREPARED_CONTEXT;
                const { content, state } = response;
                needsInference = false;
                pendingError = state === "error" ? response.errorMessage : undefined;
                if (state !== "tool_call") {
                    // A response can carry a tool call and still not end in one — a stream that
                    // failed or was cut off after the call was emitted. Nothing will dispatch
                    // it, so it is settled here rather than left in the conversation for ever.
                    // A settling the store refused ends the turn instead: the call stays last,
                    // where a later attempt can still answer it.
                    if (
                        !(await this.#settleUnansweredCalls(
                            ctx,
                            "The response ended before this tool call was dispatched.",
                        ))
                    ) {
                        break;
                    }
                }
                if (state === "tool_call") {
                    if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                    const calls = content.filter(
                        (block): block is SessionToolCallBlock =>
                            block.type === "tool_call" && block.server !== true,
                    );
                    if (calls.length === 0) continue;
                    const closedDuringTools = await this.#runToolBatch(
                        ctx,
                        calls.map((call, index) => this.#newToolEntry(index, call)),
                        false,
                        abort.signal,
                        abortPromise,
                    );
                    if (closedDuringTools) break;
                    if (this.#stopAtSafeEdgeRequested()) return "shutdown";
                    needsInference = true;
                    continue;
                }
                // A natural stop keeps draining, and so does a provider-reported error: the
                // failed response never answers the queued messages, so they still get their
                // fresh inference — each drain consumes from a finite queue, so a persistently
                // failing provider cannot loop. A cancellation or a stream that ended without
                // a done event ends the turn with the queues intact.
                if (state !== "normal" && state !== "length" && state !== "error") break;
            }
            if (
                pendingError !== undefined &&
                this.#loaded !== undefined &&
                this.#unansweredCalls(this.#messages).length === 0
            ) {
                await this.#appendFailure(ctx, pendingError);
            }
        } catch (error: unknown) {
            await this.#emit(ctx, {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: error instanceof Error ? error.message : String(error),
            });
            // A turn that failed while it owed tool results must not leave them owed: the next
            // message would be appended after an unanswered call, which most providers reject
            // outright and no later turn would ever repair. When even that write is refused, the
            // note is not written either — the call stays last, and the next run settles it
            // before anything else is said.
            if (
                await this.#settleUnansweredCalls(
                    ctx,
                    "The turn failed before this tool call finished.",
                )
            ) {
                await this.#appendFailure(
                    ctx,
                    error instanceof Error ? error.message : String(error),
                );
            }
            this.#noticeAwaitingResponse = false;
            this.#clearTurnRequestIfNoPendingInput();
        }
        this.#turnAborted = abort.signal.aborted;
        return this.#stopAtSafeEdgeRequested() ? "shutdown" : "complete";
    }

    /** Whether a sticky drain or the stdlib coordinator has asked for the next durable edge. */
    #stopAtSafeEdgeRequested(): boolean {
        return this.#draining || shutdown.get(this.#ctx)?.shuttingDown === true;
    }

    /**
     * Let queue writes already admitted by a re-entrant hook publish before deciding the queues
     * are empty. Their database transactions own ordering; this waits for those concrete writes
     * without holding another agent or database lock.
     */
    async #finishAdmittedQueueWrites(): Promise<void> {
        while (this.#messageAdmissions.size > 0) {
            await Promise.allSettled(this.#messageAdmissions);
        }
    }

    /**
     * Make one request of the provider and take its answer: the instructions and tools the turn
     * is running with, the session they belong to, the inference brackets around the request, and
     * the blocks the model actually finished saying. Nothing comes back when a cancellation
     * arrived before the request was made, since there is no response to account for.
     */
    async #requestInference(
        ctx: Context,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<
        | {
              readonly content: SessionAssistantBlock[];
              readonly state: SessionDoneState | undefined;
              readonly errorMessage?: string;
          }
        | undefined
    > {
        const instructions = await this.#instructions(ctx);
        const tools = await this.#tools(ctx);
        const session = await this.#ensureSession(instructions, tools);
        // Nothing from the previous response may still be holding the session — but that
        // unwinding was detached from an earlier abort precisely so it could never hold a
        // cancellation open, so a new cancellation must not start waiting for it either.
        if ((await Promise.race([this.#settled(), abortPromise])) === ABORTED) return undefined;
        this.#inferenceId ??= createId();
        const inferenceStart: AgentBaseInferenceStart = {
            loopId: this.#loopId ?? createId(),
            turnId: this.#turnId ?? createId(),
            inferenceId: this.#inferenceId,
            contextTokens: this.#contextTokens,
        };
        this.#loopId = inferenceStart.loopId;
        this.#turnId = inferenceStart.turnId;
        setAgentSpanAttributes(ctx, {
            "agent.loop.id": inferenceStart.loopId,
            "agent.turn.id": inferenceStart.turnId,
            "agent.inference.id": inferenceStart.inferenceId,
        });
        await this.#enterStage(
            ctx,
            "inference",
            this.#hooks.beforeInferenceTransact === undefined
                ? undefined
                : (hookCtx) => this.#hooks.beforeInferenceTransact?.(hookCtx, inferenceStart),
        );
        await this.#invokeHook(ctx, this.#hooks.beforeInference, inferenceStart);
        // Explicit drain takes the earliest pre-request edge. Preserve the stdlib coordinator's
        // established behavior: once its inference hook has begun, graceful shutdown lets that
        // operation proceed through the provider request before stopping.
        if (this.#draining) return undefined;
        const stream = session.run(this.#workContext(ctx), {
            context: {
                instructions,
                messages: this.#messagesForProvider(this.#messages),
            },
            ...(this.#model === undefined ? {} : { model: this.#model }),
            ...(this.#effort === undefined ? {} : { effort: this.#effort }),
            ...(this.#serviceTier === undefined ? {} : { serviceTier: this.#serviceTier }),
        });
        const { content, state, errorMessage, tokens } = await this.#collect(
            ctx,
            stream,
            abortPromise,
        );
        // A cancellation or a stream ending without a done event did not answer an appended
        // notice. Keep that obligation and reopen it under a fresh turn scope. Every terminal
        // provider outcome counts as the response, including an error.
        if (this.#noticeAwaitingResponse && (state === "cancelled" || state === undefined)) {
            this.#turnRequested = true;
        } else {
            this.#noticeAwaitingResponse = false;
            this.#clearTurnRequestIfNoPendingInput();
        }
        // A cancelled or failed response measures nothing, so the conversation keeps the last
        // real measurement instead of forgetting how large it had become.
        const inference = {
            ...inferenceStart,
            state,
            tokens,
            ...(errorMessage === undefined ? {} : { errorMessage }),
        };
        const afterInferenceTransact =
            this.#hooks.afterInferenceTransact === undefined
                ? undefined
                : (hookCtx: Context) => this.#hooks.afterInferenceTransact?.(hookCtx, inference);
        const completedInferenceId = this.#inferenceId;
        this.#inferenceId = undefined;
        try {
            if (tokens === undefined) {
                await this.#enterStage(ctx, "inference", afterInferenceTransact);
            } else {
                await this.#recordContextTokens(
                    ctx,
                    tokens.input + tokens.output,
                    afterInferenceTransact,
                );
            }
        } catch (error: unknown) {
            this.#inferenceId = completedInferenceId;
            throw error;
        }
        await this.#invokeHook(ctx, this.#hooks.afterInference, inference);
        if (content.length > 0) {
            this.#messages.push({ role: "assistant", content });
        }
        return { content, state, ...(errorMessage === undefined ? {} : { errorMessage }) };
    }

    /**
     * Whether this agent is picking up a run that was cut off rather than starting a fresh one,
     * and so owes an inference nobody asked for again.
     *
     * Liveness comes only from the inherited pending record. Within that active run, a consumed
     * message, tool result, or failure note is owed an answer. A compaction replacement is owed
     * one only when its transaction preserved the inference identity of the active continuation.
     * A listener shown the beginning of a block that will now never arrive is told to drop it.
     * Only finished blocks are persisted, so the conversation is intact and it is the view being
     * corrected.
     */
    async #resumesInterruptedRun(ctx: Context): Promise<boolean> {
        const continuedAfterCompaction =
            this.#lastRecordType === "compaction" &&
            this.#inherited?.stage === "inference" &&
            this.#inherited.inferenceId !== undefined;
        const owed =
            this.#lastRecordType === "user" ||
            this.#lastRecordType === "tool" ||
            this.#lastRecordType === "system" ||
            continuedAfterCompaction;
        if (owed && this.#inherited?.stage === "inference") {
            await this.#emit(ctx, { type: "block_reset" });
        }
        return owed;
    }

    /** Load the durable state once. A failed load is not sticky: the next turn retries it. */
    async #ensureLoaded(ctx: Context): Promise<void> {
        this.#loaded ??= this.#loadHistory(ctx).catch((error: unknown) => {
            this.#loaded = undefined;
            throw error;
        });
        await this.#loaded;
    }

    /**
     * Remember the conversation's true size, as the provider just measured it. The durable copy
     * lets a restarted agent keep knowing how large the conversation is without inferring it;
     * a failed write costs only that knowledge and never the response that produced it.
     */
    async #recordContextTokens(
        ctx: Context,
        tokens: number | undefined,
        transact?: (ctx: Context) => MaybePromise<void>,
    ): Promise<void> {
        const previousTokens = this.#contextTokens;
        this.#contextTokens = tokens;
        try {
            await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                const write = (writeCtx: Context): Promise<void> =>
                    tokens === undefined
                        ? this.#persistence.deleteValue(writeCtx, "context")
                        : this.#persistence.writeValue(writeCtx, "context", { tokens });
                if (transact === undefined) {
                    await write(lockCtx);
                    return;
                }
                await this.#recordTransaction(lockCtx, async (txCtx) => {
                    await write(txCtx);
                    await this.#recordPending(txCtx, "inference", true);
                    await this.#withTransactionalContext(txCtx, transact);
                });
            });
        } catch (error) {
            // The prior committed measurement stays authoritative in memory. A transactional
            // observer is part of the same durable conclusion and therefore fails the turn when
            // that conclusion cannot commit; an ordinary best-effort measurement still does not.
            this.#contextTokens = previousTokens;
            if (transact !== undefined) throw error;
        }
    }

    /**
     * Run the pending compaction, if any. This pass is the only history writer, so the provider
     * summarizes exactly the conversation that the replacement supersedes. The replacement is
     * appended as a compaction record — the load-time reset point — and settles the shared
     * promise for every caller awaiting it. A provider failure rejects them and leaves history
     * untouched.
     */
    async #runCompaction(
        ctx: Context,
        signal: AbortSignal,
        continueWithInference: boolean,
    ): Promise<void> {
        if (this.#compaction === undefined) return;
        await this.#span(ctx, "agent.compaction", {}, (compactionCtx) =>
            this.#compactHistory(compactionCtx, signal, continueWithInference),
        );
    }

    /** The compaction itself, on the context of the span it belongs to. */
    async #compactHistory(
        ctx: Context,
        signal: AbortSignal,
        continueWithInference: boolean,
    ): Promise<void> {
        const pending = this.#compaction;
        if (pending === undefined) return;
        try {
            await this.#enterStage(ctx, "compaction");
            const instructions = await this.#instructions(ctx);
            const session = await this.#ensureSession(instructions, await this.#tools(ctx));
            const snapshot = this.#messagesForProvider(this.#messages);
            await this.#settled();
            const compactionStart: AgentBaseCompactionStart = {
                loopId: this.#loopId ?? createId(),
                turnId: this.#turnId ?? createId(),
                compactionId: createId(),
                contextTokens: this.#contextTokens,
            };
            this.#loopId = compactionStart.loopId;
            this.#turnId = compactionStart.turnId;
            setAgentSpanAttributes(ctx, {
                "agent.loop.id": compactionStart.loopId,
                "agent.turn.id": compactionStart.turnId,
                "agent.compaction.id": compactionStart.compactionId,
            });
            await this.#invokeHook(ctx, this.#hooks.beforeCompaction, compactionStart);
            // Provider compaction is this turn's work, so it runs on this turn's lifetime: an
            // abort reaches the provider operation itself rather than waiting for it to finish
            // work nobody wants any more.
            const result = await session.compact(withLifetime(this.#workContext(ctx), signal), {
                context: { instructions, messages: snapshot },
                ...(this.#model === undefined ? {} : { model: this.#model }),
            });
            const cancelledContext =
                result.status === "cancelled"
                    ? baseContextMessages(result.context.messages, this.#providerToolIds)
                    : undefined;
            let hookResult =
                result.status === "cancelled" && cancelledContext !== undefined
                    ? {
                          ...result,
                          context: { ...result.context, messages: cancelledContext.messages },
                      }
                    : result;
            if (result.status === "failed") {
                await this.#preserveCompactionContinuation(
                    ctx,
                    continueWithInference && !signal.aborted,
                );
                await this.#invokeHook(ctx, this.#hooks.afterCompaction, {
                    ...compactionStart,
                    result,
                });
                throw new Error(result.message);
            }
            if (result.status === "completed") {
                const replacement = baseContextMessages(
                    result.context.messages,
                    this.#providerToolIds,
                );
                const preserved = baseContextMessages(
                    result.preservedMessages,
                    this.#providerToolIds,
                );
                const publicResult = {
                    ...result,
                    preservedMessages: preserved.messages,
                    context: { ...result.context, messages: replacement.messages },
                };
                hookResult = publicResult;
                const completed: AgentBaseCompletedCompaction = {
                    ...compactionStart,
                    result: publicResult,
                };
                await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                    // Physically delete the superseded records and write the replacement —
                    // which keeps the messages that stay — in one atomic step.
                    await this.#recordTransaction(lockCtx, async (txCtx) => {
                        await this.#deleteRecordIdentities(
                            txCtx,
                            await this.#persistence.load(txCtx),
                        );
                        await this.#historyKV.clear(txCtx);
                        await this.#persistence.clearRecords(txCtx);
                        if (this.#hooks.historyErasedTransact !== undefined) {
                            await this.#withTransactionalContext(txCtx, (hookCtx) =>
                                this.#hooks.historyErasedTransact?.(hookCtx, completed),
                            );
                        }
                        await this.#persistence.append(txCtx, {
                            type: "compaction",
                            contextToolIds: storedContextToolIds(replacement.toolIds),
                            messages: replacement.messages,
                        });
                        if (continueWithInference) {
                            // The replacement and the response it still owes are one durable
                            // transition. Reserving the inference identity here distinguishes an
                            // active automatic compaction from standalone maintenance even if the
                            // process stops before the provider request can open.
                            this.#inferenceId ??= createId();
                            await this.#recordPending(txCtx, "inference", true);
                        }
                    });
                    this.#rotateHistoryKV();
                    this.#messages = replacement.messages;
                    this.#providerToolIds = replacement.toolIds;
                    this.#lastRecordType = "compaction";
                });
                // The conversation the measurement described is gone; its size is unknown
                // again until the next response measures the replacement.
                await this.#recordContextTokens(ctx, undefined);
            }
            if (result.status !== "completed") {
                await this.#preserveCompactionContinuation(
                    ctx,
                    continueWithInference && !signal.aborted,
                );
            }
            await this.#invokeHook(ctx, this.#hooks.afterCompaction, {
                ...compactionStart,
                result: hookResult,
            });
            this.#compaction = undefined;
            pending.resolve();
        } catch (error: unknown) {
            await this.#preserveCompactionContinuation(
                ctx,
                continueWithInference && !signal.aborted,
            );
            this.#compaction = undefined;
            pending.reject(error);
        }
    }

    /** Keep a response owed when an automatic compaction did not reach its replacement commit. */
    async #preserveCompactionContinuation(ctx: Context, shouldContinue: boolean): Promise<void> {
        if (!shouldContinue) return;
        this.#inferenceId ??= createId();
        await this.#enterStage(ctx, "inference");
    }

    /**
     * Answer every call the last response left unanswered with an error result, and report
     * whether the conversation now owes none. The rule this keeps is that the durable
     * conversation never holds a tool call without its result: a call is settled while it is
     * still the last thing said, because a result appended after anything else would sit in the
     * wrong place, where nothing could put it right again. So a caller told the settling did not
     * happen must append nothing either — leaving the call last is what lets a later attempt,
     * here or after a restart, still answer it.
     */
    async #settleUnansweredCalls(ctx: Context, reason: string): Promise<boolean> {
        // Nothing is known about the conversation, so nothing may be said about it.
        if (this.#loaded === undefined) return false;
        const owed = this.#unansweredCalls(this.#messages);
        if (owed.length === 0) return true;
        let settled = false;
        let staged = false;
        try {
            await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                // A call the durable batch still holds belongs to the resume, which answers it
                // properly — and re-executes it when the tool is durable. This run cannot settle
                // it independently without racing that batch, and it cannot settle the agent
                // while the call remains open, so leave the durable stage untouched for resume.
                const pending = await this.#persistence.readValues(lockCtx, "tool.");
                const dispatched = new Set(
                    pending.map(({ key, value }) => this.#restoreToolEntry(key, value).id),
                );
                if (owed.some((call) => dispatched.has(call.callId))) {
                    this.#durableWorkBlocked = true;
                    return;
                }
                const entries = owed.map((call, index) => {
                    const entry = this.#newToolEntry(index, call);
                    return {
                        ...entry,
                        committed: toolFailure(entry.id, reason),
                    };
                });
                // Give every otherwise-undispatched call a durable internal identity and staged
                // result first. If the settlement transaction below fails, restart resumes these
                // exact entries and commits their staged errors without executing the tools.
                await this.#recordTransaction(lockCtx, async (txCtx) => {
                    for (const entry of entries) {
                        await this.#persistence.writeValue(
                            txCtx,
                            entry.key,
                            this.#storedToolEntry(entry),
                        );
                    }
                    await this.#recordPending(txCtx, "tools");
                });
                staged = true;
                await this.#recordTransaction(lockCtx, async (txCtx) => {
                    for (const entry of entries) {
                        const result = entry.committed;
                        await this.#appendRecord(
                            txCtx,
                            toolContextRecord(result, this.#providerToolIds),
                        );
                        await this.#persistence.deleteValue(txCtx, entry.key);
                        // A result the conversation records is a result the hook sees, however
                        // little of a run produced it. A hook that fails here leaves the calls
                        // unsettled, which is what lets a later attempt answer them properly.
                        await this.#invokeToolTransactHook(
                            txCtx,
                            entry.id,
                            this.#hooks.afterToolCallTransact,
                            result,
                        );
                        await this.#kv.scoped("call", entry.id).clear(txCtx);
                    }
                    await this.#recordPending(txCtx, "inference");
                });
                this.#messages.push(...entries.map(({ committed }) => committed));
                settled = true;
            });
        } catch {
            if (staged) this.#durableWorkBlocked = true;
            // The turn is already failing; a restart settles what this could not, as long as
            // nothing is written over the top of the call in the meantime.
        }
        return settled;
    }

    /**
     * Append one record to the durable conversation.
     */
    async #appendRecord(ctx: Context, record: AgentRecord): Promise<void> {
        await this.#persistence.append(ctx, record);
    }

    /** Remove deduplication identities for user records a history replacement is deleting. */
    async #deleteRecordIdentities(ctx: Context, records: readonly AgentRecord[]): Promise<void> {
        for (const record of records) {
            if (record.type === "user") {
                await this.#persistence.deleteValue(ctx, `message.${record.id}`);
                this.#offeredMessageIds.delete(record.id);
            }
        }
    }

    /**
     * A transaction whose pending-state cache unwinds with it.
     */
    async #recordTransaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        // The outstanding work unwinds with the records for the same reason: a stage staged by a
        // transaction that rolled back was never written, and memory claiming it would make the
        // agent skip the write that actually records what it is doing.
        const pending = this.#pending;
        const written = this.#pendingWritten;
        const loopId = this.#loopId;
        const turnId = this.#turnId;
        const inferenceId = this.#inferenceId;
        const settlementId = this.#settlementId;
        try {
            return await this.#persistence.transaction(ctx, work);
        } catch (error: unknown) {
            this.#pending = pending;
            this.#pendingWritten = written;
            this.#loopId = loopId;
            this.#turnId = turnId;
            this.#inferenceId = inferenceId;
            this.#settlementId = settlementId;
            throw error;
        }
    }

    /**
     * Surface a failed turn to the conversation as a system message, so the next inference sees
     * what went wrong. Only unrecovered failures reach here — a later successful response in the
     * same turn clears its error without a trace. Skipped when the history never loaded, since
     * there is no context to append to; its own failure is swallowed, so surfacing a failure can
     * never cause another.
     */
    async #appendFailure(ctx: Context, message: string): Promise<void> {
        // The settlement reports it whether or not the conversation can be written to: an owner
        // waiting on this agent learns why it stopped from the settlement alone, and a failure
        // the history never recorded is exactly the one nobody else would ever see.
        this.#runFailure = message;
        if (this.#loaded === undefined) return;
        const failure: SessionSystemMessage = {
            role: "system",
            content: [{ type: "text", text: `The last turn failed: ${message}` }],
        };
        try {
            await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                await this.#appendRecord(lockCtx, { type: "system", message: failure });
                this.#messages.push(failure);
            });
        } catch {
            // The turn already failed; a failing write must not escalate it.
        }
    }

    /** Move every pending hook notice into history as one atomic, ordered append batch. */
    async #consumeInjections(ctx: Context): Promise<boolean> {
        return await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
            if (this.#injections.length === 0) return false;
            const durable = new Set(
                (await this.#persistence.readValues(lockCtx, "inject.")).map(({ key }) => key),
            );
            const remaining = this.#injections.filter((entry) => durable.has(entry.key));
            if (remaining.length !== this.#injections.length) {
                this.#injections.splice(0, this.#injections.length, ...remaining);
            }
            if (this.#injections.length === 0) return false;
            const batch = [...this.#injections];
            await this.#recordTransaction(lockCtx, async (txCtx) => {
                for (const entry of batch) {
                    await this.#persistence.deleteValue(txCtx, entry.key);
                    await this.#appendRecord(txCtx, {
                        type: "system",
                        message: entry.message,
                    });
                }
                await this.#recordPending(txCtx, "inference");
            });
            this.#injections.splice(0, batch.length);
            this.#messages.push(...batch.map(({ message }) => message));
            this.#lastRecordType = "system";
            this.#noticeAwaitingResponse = true;
            this.#turnRequested = true;
            return true;
        });
    }

    /** Drop a redundant requested turn only when no accepted input still needs one. */
    #clearTurnRequestIfNoPendingInput(): void {
        if (
            this.#steering.length === 0 &&
            this.#sends.length === 0 &&
            !this.#committedQueueDirty &&
            this.#injections.length === 0 &&
            !this.#noticeAwaitingResponse &&
            this.#compaction === undefined
        ) {
            this.#turnRequested = false;
        }
    }

    /** Accepted notice work is drained even when close has already raised its admission barrier. */
    #hasNoticeWorkToFinish(): boolean {
        return this.#injections.length > 0 || this.#noticeAwaitingResponse;
    }

    /**
     * Move the oldest queued message — or, in "all" mode, every queued message — into the main
     * context store and the in-memory history. The moves run in one transaction, so a message
     * is never durable in both stores or neither, and memory changes only after the commit.
     *
     * What the consumption has to announce is announced once the transaction has committed. A
     * hook told a message has landed may perfectly well answer by sending another one without
     * re-entering the transaction that delivered the first message.
     */
    async #consumeQueue(
        ctx: Context,
        queue: QueueEntry[],
        mode: AgentBaseQueueMode,
        kind: QueueRequest["kind"],
    ): Promise<boolean> {
        const prefix = `${kind}.`;
        /** Filled in once the consumption has committed, then reported to observers. */
        const accepted: AgentBaseAcceptedMessage[] = [];
        let permissionChange: AgentBasePermissionModeChange | undefined;
        const consumed = await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
            if (queue.length === 0) return false;
            // The durable queue, not memory, decides what is left to consume after a restart.
            const durable = new Set(
                (await this.#persistence.readValues(lockCtx, prefix)).map(({ key }) => key),
            );
            const remaining = queue.filter((entry) => durable.has(entry.key));
            if (remaining.length !== queue.length) queue.splice(0, queue.length, ...remaining);
            if (queue.length === 0) return false;
            const count = mode === "all" ? queue.length : 1;
            const batch = queue.slice(0, count);
            // Settings carried by the consumed messages become the effective settings for the
            // inference that follows, each defined field superseding the previous value. The
            // effective values are persisted alongside the consumption so a restart keeps them.
            let provider = this.#providerId;
            let model = this.#model;
            let effort = this.#effort;
            let serviceTier = this.#serviceTier;
            let permissionMode = this.#permissionMode;
            let changed = false;
            for (const entry of batch) {
                if (entry.options.provider !== undefined) {
                    provider = entry.options.provider;
                    changed = true;
                }
                if (entry.options.model !== undefined) {
                    model = entry.options.model;
                    changed = true;
                }
                if (entry.options.effort !== undefined) {
                    effort = entry.options.effort;
                    changed = true;
                }
                if (entry.options.serviceTier !== undefined) {
                    serviceTier = entry.options.serviceTier;
                    changed = true;
                }
                if (entry.options.permissionMode !== undefined) {
                    permissionMode = entry.options.permissionMode;
                    changed = true;
                }
            }
            // The mode the messages make effective, kept apart from the rest because it is the one
            // setting with hooks of its own: a change is announced, and what a module concludes
            // from it commits with the message that carried it.
            const modeChange: AgentBasePermissionModeChange | undefined =
                permissionMode === this.#permissionMode
                    ? undefined
                    : { previousMode: this.#permissionMode, mode: permissionMode };
            // A provider or model change is checked against the provider-model compatibility
            // matrix. An incompatible change resets the conversation: the history is erased
            // completely, the old provider session is destroyed, and the `modelChanged` hook
            // may inject one handoff system message at the very beginning of the fresh
            // context. A compatible provider change keeps the history but still gets a fresh
            // session, since a session is bound to the provider that created it.
            const selectionChanged = provider !== this.#providerId || model !== this.#model;
            let reset = false;
            let injected: SessionSystemMessage | undefined;
            if (selectionChanged) {
                if (this.#model !== undefined && model !== undefined) {
                    const previousType = this.#providers.typeOf(this.#providerId);
                    const nextType = this.#providers.typeOf(provider);
                    if (previousType === null || nextType === null || previousType !== nextType) {
                        reset = true;
                    } else {
                        const [previousKey, nextKey] = await Promise.all([
                            this.#providers.contextCompatibilityKeyOf(
                                this.#providerId,
                                this.#model,
                            ),
                            this.#providers.contextCompatibilityKeyOf(provider, model),
                        ]);
                        reset =
                            previousKey === null ||
                            nextKey === null ||
                            !areProviderModelsCompatible(
                                {
                                    modelId: this.#model,
                                    providerId: previousKey,
                                    providerType: previousType,
                                },
                                {
                                    modelId: model,
                                    providerId: nextKey,
                                    providerType: nextType,
                                },
                            );
                    }
                } else {
                    // A selection without a model on either side cannot be judged compatible.
                    reset = model !== this.#model;
                }
            }
            await this.#recordTransaction(lockCtx, async (txCtx) => {
                if (selectionChanged) {
                    if (this.#hooks.modelChanged !== undefined && model !== undefined) {
                        // The hook runs inside the transaction that commits the switch, so its store executes directly on
                        // that transaction: what it writes lands and rolls back with the change
                        // it was told about, never on its own. The context it is given ends with
                        // the transaction, so a store it keeps cannot outlive the switch.
                        const committed = new AbortController();
                        // Derived from the transaction's own context, which is what makes
                        // the hook's writes part of the switch rather than a second,
                        // separate commit, and ending with it.
                        const changeLifetime = withLifetime(
                            withAgentContext(txCtx, {
                                id: this.id,
                                provider,
                                model,
                                effort,
                                serviceTier,
                                permissionMode,
                            }),
                            committed.signal,
                        );
                        const changeCtx = withAgentRunKV(
                            withAgentHistoryKV(
                                withAgentKV(changeLifetime, this.#kv),
                                this.#historyKV,
                            ),
                            this.#runKV,
                        );
                        try {
                            injected = await this.#hooks.modelChanged(changeCtx, {
                                previousModel: this.#model,
                                model,
                                previousProvider: this.#providerId,
                                provider,
                                providers: this.#providers,
                                wasReset: reset,
                            });
                        } catch {
                            // A failing handoff must not cost the conversation: an incompatible
                            // switch is rejected outright — the previous selection stays
                            // effective and the history is not cleared. A compatible change
                            // proceeds; the hook only observed it.
                            if (reset) {
                                provider = this.#providerId;
                                model = this.#model;
                                reset = false;
                            }
                        } finally {
                            // The store belonged to the hook's call, not to the hook.
                            committed.abort();
                        }
                        if (!reset) injected = undefined;
                    }
                }
                // The queue move is atomic with appending the consumed messages and recording
                // the inference they make due. The store has one owner, so ordinary deletes
                // are sufficient.
                for (const entry of batch) {
                    await this.#persistence.deleteValue(txCtx, entry.key);
                }
                if (reset) {
                    await this.#deleteRecordIdentities(txCtx, await this.#persistence.load(txCtx));
                    await this.#historyKV.clear(txCtx);
                    await this.#persistence.clearRecords(txCtx);
                    // The erased conversation is what the measurement described.
                    await this.#persistence.deleteValue(txCtx, "context");
                    if (injected !== undefined) {
                        await this.#appendRecord(txCtx, {
                            type: "system",
                            message: injected,
                        });
                    }
                }
                for (const entry of batch) {
                    await this.#appendRecord(txCtx, {
                        type: "user",
                        id: entry.id,
                        message: entry.message,
                        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
                    });
                }
                if (changed) {
                    await this.#persistence.writeValue(txCtx, "settings", {
                        provider,
                        ...(model === undefined ? {} : { model }),
                        ...(effort === undefined ? {} : { effort }),
                        ...(serviceTier === undefined ? {} : { serviceTier }),
                        permissionMode,
                    });
                }
                // Consuming a message is precisely the act that makes an inference owed, so
                // the two commit as one. A crash cannot land between them and leave a
                // message in the conversation that nothing remembers having to answer.
                await this.#recordPending(txCtx, "inference");
                // Last, so a hook writing its own account of the consumption sees a transaction
                // holding all of it. The mode comes before the messages: it is what they were
                // said under, and a listener recording them wants to know that first.
                const selection = { provider, model, effort, serviceTier, permissionMode };
                if (modeChange !== undefined) {
                    await this.#invokeTransactHook(
                        txCtx,
                        selection,
                        this.#hooks.permissionModeChangedTransact,
                        modeChange,
                    );
                }
                for (const entry of batch) {
                    await this.#invokeTransactHook(
                        txCtx,
                        selection,
                        this.#hooks.messageAcceptedTransact,
                        {
                            id: entry.id,
                            kind,
                            message: entry.message,
                            ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
                        },
                    );
                }
            });
            if (reset) this.#rotateHistoryKV();
            // Committed: from here the messages are part of the conversation, so what has to be
            // announced about them is decided now and reported once the transaction commits.
            permissionChange = modeChange;
            accepted.push(
                ...batch.map((entry) => ({
                    id: entry.id,
                    kind,
                    message: entry.message,
                    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
                })),
            );
            queue.splice(0, count);
            if (reset) {
                this.#messages = injected === undefined ? [] : [injected];
                this.#providerToolIds.clear();
                this.#contextTokens = undefined;
            }
            this.#messages.push(...batch.map((entry) => entry.message));
            // This turn is answering the request that these messages raised. A send accepted
            // while the turn was already running raised it again, and letting that stand would
            // buy an extra turn with an empty queue and a full set of lifecycle hooks.
            this.#clearTurnRequestIfNoPendingInput();
            if (changed) {
                this.#providerId = provider;
                this.#model = model;
                this.#effort = effort;
                this.#serviceTier = serviceTier;
                this.#permissionMode = permissionMode;
                this.#ctx = this.#deriveCtx();
            }
            return true;
        });
        // Outside the lock, and on a context carrying whatever these messages made effective:
        // the selection is read now rather than when the turn opened.
        if (permissionChange !== undefined) {
            await this.#invokeHook(ctx, this.#hooks.permissionModeChanged, permissionChange);
        }
        for (const message of accepted) {
            await this.#invokeHook(ctx, this.#hooks.messageAccepted, message);
        }
        return consumed;
    }

    /**
     * Call a hook that writes inside the consumption's transaction, on a context carrying the
     * selection those messages made effective rather than the one they replaced. Its failure is
     * not contained: it rolls the whole consumption back, leaving the messages queued.
     */
    async #invokeTransactHook<Argument>(
        txCtx: Context,
        selection: {
            readonly provider: string;
            readonly model: string | undefined;
            readonly effort: SessionReasoningEffort | undefined;
            readonly serviceTier: SessionServiceTier | undefined;
            readonly permissionMode: AgentPermissionMode;
        },
        hook: ((ctx: Context, argument: Argument) => MaybePromise<void>) | undefined,
        argument: Argument,
    ): Promise<void> {
        if (hook === undefined) return;
        const hookCtx = withAgentContext(txCtx, { id: this.id, ...selection });
        await this.#withTransactionalContext(hookCtx, (liveCtx) => hook(liveCtx, argument));
    }

    /** Restore one queued message envelope from durable storage. */
    #restoreQueueEntry(key: string, value: unknown): QueueEntry {
        const envelope = value as {
            readonly id: string;
            readonly message: AgentQueuedMessage;
            readonly metadata?: AgentMessageMetadata;
            readonly options?: AgentBaseMessageOptions;
        };
        if (!Value.Check(cuid2Schema, envelope.id)) {
            throw new Error(`The queued message under "${key}" has an invalid ID.`);
        }
        const metadata = ownAgentMessageMetadata(envelope.metadata);
        return {
            key,
            id: envelope.id,
            message: envelope.message,
            ...(metadata === undefined ? {} : { metadata }),
            options: envelope.options ?? {},
        };
    }

    /**
     * Merge queue entries published by outer transactions into memory without reloading the
     * conversation. An independently accepted message can publish its in-memory entry while the
     * reads are in flight, so merging by durable key preserves both paths and sorting restores the
     * queues' durable FIFO order. Clearing the marker before each read means a commit racing that
     * read raises it again and gets another pass before this boundary continues.
     */
    async #refreshCommittedQueues(ctx: Context): Promise<void> {
        while (this.#committedQueueDirty) {
            this.#committedQueueDirty = false;
            try {
                const queueCtx = this.#workContext(ctx);
                const [steering, sends] = await Promise.all([
                    this.#persistence.readValues(queueCtx, "steering."),
                    this.#persistence.readValues(queueCtx, "send."),
                ]);
                const merge = (
                    queue: QueueEntry[],
                    stored: readonly { readonly key: string; readonly value: unknown }[],
                ): void => {
                    const known = new Set(queue.map(({ key }) => key));
                    for (const { key, value } of stored) {
                        if (known.has(key)) continue;
                        queue.push(this.#restoreQueueEntry(key, value));
                        known.add(key);
                    }
                    queue.sort((left, right) =>
                        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
                    );
                };
                merge(this.#steering, steering);
                merge(this.#sends, sends);
            } catch (error) {
                this.#committedQueueDirty = true;
                throw error;
            }
        }
    }

    /**
     * Replace the in-memory state with the durable one. Durable queue acceptance guarantees every
     * message already in memory reached storage first, so the load result supersedes memory
     * entirely: the main store rebuilds the context, and the sorted queue keys rebuild the
     * not-yet-consumed queues. Consecutive block records reassemble into one assistant message.
     */
    async #loadHistory(ctx: Context): Promise<void> {
        await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
            const records = await this.#persistence.load(lockCtx);
            const last = records[records.length - 1];
            this.#lastRecordType = last?.type;
            const restored = contextFromRecords(records);
            const steering = await this.#persistence.readValues(lockCtx, "steering.");
            const sends = await this.#persistence.readValues(lockCtx, "send.");
            const injections = await this.#persistence.readValues(lockCtx, "inject.");
            const pendingTools = await this.#persistence.readValues(lockCtx, "tool.");
            const settings = await this.#persistence.readValues(lockCtx, "settings");
            const context = await this.#persistence.readValues(lockCtx, "context");
            this.#messages = restored.messages;
            this.#providerToolIds = restored.toolIds;
            // The measured size of the restored context, so the first turn after a reload can
            // still decide whether it needs a compaction.
            const measured = context[0]?.value as { readonly tokens: number } | undefined;
            this.#contextTokens = measured?.tokens;
            this.#steering = steering.map(({ key, value }) => this.#restoreQueueEntry(key, value));
            this.#sends = sends.map(({ key, value }) => this.#restoreQueueEntry(key, value));
            this.#injections = injections.map(({ key, value }) => ({
                key,
                message: structuredClone(value as SessionSystemMessage),
            }));
            // The persisted settings are the complete effective triple from the last change; an
            // absent field means that setting was effectively unset when it was written.
            const persisted = settings[0]?.value as AgentBaseMessageOptions | undefined;
            if (persisted !== undefined) {
                if (persisted.provider !== undefined) this.#providerId = persisted.provider;
                this.#model = persisted.model;
                this.#effort = persisted.effort;
                this.#serviceTier = persisted.serviceTier;
                // The permission mode is the one setting whose absence is not a decision: a record
                // written before any message carried a mode says nothing about it, and a value
                // that is not a mode at all says nothing either. Both keep the mode the agent was
                // built with rather than running under something nothing can interpret.
                if (isAgentPermissionMode(persisted.permissionMode)) {
                    this.#permissionMode = persisted.permissionMode;
                }
                this.#ctx = this.#deriveCtx();
            }
            this.#pendingTools = pendingTools.map(({ key, value }) =>
                this.#restoreToolEntry(key, value),
            );
            this.#pendingToolsUndispatched = false;
            if (this.#pendingTools.length === 0) {
                // A crash between the response's last block and the batch commit leaves calls
                // the conversation still owes results for, with nothing durable to resume: the
                // context would keep an unanswered tool call for ever, which most providers
                // reject outright. They are recovered as the batch that was about to be
                // dispatched.
                const owed = this.#unansweredCalls(restored.messages);
                if (owed.length > 0) {
                    this.#pendingTools = owed.map((call, index) => this.#newToolEntry(index, call));
                    this.#pendingToolsUndispatched = true;
                }
            }
            this.#committedQueueDirty = false;
        });
    }

    /**
     * Run one batch of tool calls. The whole batch is committed to the sorted store before any
     * call executes, so a crash mid-batch leaves a durable record of the calls still owed a
     * result. All calls run in parallel, but results land strictly in call order: a finished
     * result waits until every earlier call in the batch has committed, and each commit appends
     * the tool record and removes the pending entry in one transaction before memory changes.
     * On resume, only durable tools execute again; the rest become error results. An abort
     * settles every call still running as an aborted error result, so the batch always leaves a
     * complete context behind.
     */
    async #runToolBatch(
        ctx: Context,
        entries: readonly ToolBatchEntry[],
        resume: boolean,
        signal: AbortSignal,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<boolean> {
        return await this.#span(
            ctx,
            "agent.tools",
            { "agent.tool.count": entries.length, "agent.tool.resume": resume },
            (batchCtx) => this.#dispatchToolBatch(batchCtx, entries, resume, signal, abortPromise),
        );
    }

    /** The batch itself, on the context of the span it belongs to. */
    async #dispatchToolBatch(
        ctx: Context,
        entries: readonly ToolBatchEntry[],
        resume: boolean,
        signal: AbortSignal,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<boolean> {
        if (!resume) {
            await this.#runPersistenceStep(this.#workContext(ctx), (lockCtx) =>
                this.#recordTransaction(lockCtx, async (txCtx) => {
                    for (const entry of entries) {
                        await this.#persistence.writeValue(
                            txCtx,
                            entry.key,
                            this.#storedToolEntry(entry),
                        );
                    }
                    // The batch and the stage that describes it commit together. A crash can
                    // then never find calls owed with no record of a run owing them, nor a run
                    // recorded as running tools that were never written.
                    await this.#recordPending(txCtx, "tools");
                    // Last, so a hook noting a call about to happen sees a transaction holding
                    // the whole batch it belongs to.
                    for (const entry of entries) {
                        const { vendor: _vendor, ...call } = entry.call;
                        await this.#invokeToolTransactHook(
                            txCtx,
                            entry.id,
                            this.#hooks.beforeToolCallTransact,
                            call,
                        );
                    }
                }),
            );
        } else {
            await this.#enterStage(ctx, "tools");
        }
        const results: (SessionToolResultMessage | undefined)[] = new Array(entries.length);
        // Every execution actually started, whether or not its result reached the conversation.
        const running: Promise<SessionToolResultMessage>[] = [];
        let closedDuringTools = false;
        let committed = 0;
        // A failed commit blocks the turn with its pending calls intact for resume. A sibling
        // still running at that moment no longer owns the append-only tail: its result could
        // race the resumed batch and give one call two answers. So the first failed commit closes
        // the batch to every result that was not committed yet.
        let commitFailed = false;
        let commitAvailable = Promise.resolve();
        const commitReady = async (): Promise<void> => {
            const previous = commitAvailable;
            let release!: () => void;
            commitAvailable = new Promise<void>((resolve) => {
                release = resolve;
            });
            await previous;
            try {
                if (commitFailed) return;
                await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                    while (committed < entries.length) {
                        const entry = entries[committed];
                        const proposed = results[committed];
                        if (entry === undefined || proposed === undefined) return;
                        let winner = proposed;
                        await this.#recordTransaction(lockCtx, async (txCtx) => {
                            const resultKey = this.#toolResultKey(entry.id);
                            await this.#persistence.writeValueIfAbsent(txCtx, resultKey, proposed);
                            const claims = await this.#persistence.readValues(txCtx, resultKey);
                            const stored = claims.find(({ key }) => key === resultKey)?.value;
                            if (!Value.Check(storedToolResultSchema, stored)) {
                                throw new Error(
                                    `The committed result claim for tool "${entry.id}" is not valid.`,
                                );
                            }
                            const result = stored as SessionToolResultMessage;
                            if (result.callId !== entry.id) {
                                throw new Error(
                                    `The committed result claim for tool "${entry.id}" has the wrong identity.`,
                                );
                            }
                            winner = result;
                            results[committed] = result;
                            await this.#appendRecord(
                                txCtx,
                                toolContextRecord(result, this.#providerToolIds),
                            );
                            // The call is answered, so both its retry record and its temporary
                            // invocation store disappear in this same result transaction.
                            await this.#persistence.deleteValue(txCtx, entry.key);
                            await this.#persistence.deleteValue(txCtx, resultKey);
                            await this.#invokeToolTransactHook(
                                txCtx,
                                entry.id,
                                this.#hooks.afterToolCallTransact,
                                result,
                            );
                            await this.#kv.scoped("call", entry.id).clear(txCtx);
                        });
                        this.#messages.push(winner);
                        committed += 1;
                    }
                    // The batch is fully answered, so its results are what the model is owed a
                    // response to. Recording that here means a crash between the last result and
                    // the next request resumes as an inference rather than as a finished batch.
                    if (committed === entries.length) {
                        await this.#recordPending(lockCtx, "inference");
                    }
                });
            } catch (error: unknown) {
                commitFailed = true;
                throw error;
            } finally {
                release();
            }
        };
        this.#toolsRunning += 1;
        const batch = Promise.all(
            entries.map(async (entry, index) => {
                let outcome: SessionToolResultMessage | typeof ABORTED;
                if (entry.committed !== undefined) {
                    outcome = entry.committed;
                } else if (resume && !(await this.#isDurable(ctx, entry.call))) {
                    outcome = toolFailure(
                        entry.id,
                        "The tool call was interrupted by a restart and was not retried.",
                    );
                } else {
                    const toolLifetime = AbortSignal.any([signal, this.#closeController.signal]);
                    // The call's own span hangs off the batch's. Every call in the batch runs at
                    // the same time, so each opens its span from the batch's context and carries
                    // its own from there.
                    const execution = this.#span(
                        ctx,
                        "agent.tool",
                        {
                            "agent.tool.id": entry.id,
                            "agent.tool.name": entry.call.name,
                            ...(entry.call.namespace === undefined
                                ? {}
                                : { "agent.tool.namespace": entry.call.namespace }),
                        },
                        (toolCtx) =>
                            this.#executeToolCall(
                                withLifetime(this.#workContext(toolCtx), toolLifetime),
                                entry,
                            ),
                    );
                    running.push(execution);
                    outcome = await Promise.race([execution, abortPromise, this.#closingTools()]);
                }
                if (outcome === ABORTED && !signal.aborted) closedDuringTools = true;
                results[index] =
                    outcome === ABORTED
                        ? {
                              role: "tool",
                              callId: entry.id,
                              content: [
                                  {
                                      type: "text",
                                      text: signal.aborted
                                          ? "The tool call was aborted."
                                          : "The tool call was abandoned when the agent closed.",
                                  },
                              ],
                              isError: true,
                          }
                        : outcome;
                await commitReady();
            }),
        );
        try {
            await batch;
        } finally {
            this.#toolsRunning -= 1;
            this.#settleLater(Promise.allSettled(running), "tool");
        }
        // An abort or failure may settle the conversation or block the batch without settling the
        // actual execution. Track that unwinding so another in-process attempt cannot overlap it;
        // the batch itself does not wait, so an uncooperative tool cannot hold this turn open.
        return closedDuringTools;
    }

    /**
     * Settles once close begins, so a batch stops waiting for tools that a shutdown may itself
     * be blocking. A close that has already begun settles it at once, since a listener added
     * afterwards would never hear the event that already happened.
     */
    #closingTools(): Promise<typeof ABORTED> {
        if (this.#closeController.signal.aborted) return Promise.resolve(ABORTED);
        return new Promise<typeof ABORTED>((resolve) => {
            this.#closeController.signal.addEventListener("abort", () => resolve(ABORTED), {
                once: true,
            });
        });
    }

    /** Whether this call's tool may safely be executed again after a restart interrupted it. */
    async #isDurable(ctx: Context, call: SessionToolCallBlock): Promise<boolean> {
        const tool = (await this.#tools(ctx)).find(
            (candidate) => candidate.name === call.name && candidate.namespace === call.namespace,
        );
        return tool?.durable === true;
    }

    /** Every client tool call in the conversation that has no matching result yet. */
    #unansweredCalls(messages: readonly SessionMessage[]): SessionToolCallBlock[] {
        const unanswered: SessionToolCallBlock[] = [];
        for (const message of messages) {
            if (message.role === "assistant") {
                unanswered.push(
                    ...message.content.filter(
                        (block): block is SessionToolCallBlock =>
                            block.type === "tool_call" && block.server !== true,
                    ),
                );
                continue;
            }
            if (message.role !== "tool") continue;
            const index = unanswered.findIndex((call) => call.callId === message.callId);
            if (index !== -1) unanswered.splice(index, 1);
        }
        return unanswered;
    }

    /** Whether settlement would erase the active marker while a tool result is still owed. */
    #hasOpenToolCalls(): boolean {
        return this.#loaded !== undefined && this.#unansweredCalls(this.#messages).length > 0;
    }

    /**
     * Give providers protocol-valid tool ordering even when recovering history written by an
     * older process that put an operational failure or user retry between a call and its result.
     * Durable history remains append-only; this view moves known results beside their calls and
     * preserves every intervening message afterwards.
     */
    #messagesForProvider(messages: readonly SessionMessage[]): SessionMessage[] {
        const calls = new Set<string>();
        const results = new Map<string, SessionToolResultMessage[]>();
        for (const message of messages) {
            if (message.role === "assistant") {
                for (const block of message.content) {
                    if (block.type === "tool_call" && block.server !== true) {
                        calls.add(block.callId);
                    }
                }
            } else if (message.role === "tool") {
                const queued = results.get(message.callId) ?? [];
                queued.push(message);
                results.set(message.callId, queued);
            }
        }

        const ordered: SessionMessage[] = [];
        for (const message of messages) {
            if (message.role === "tool" && calls.has(message.callId)) continue;
            ordered.push(message);
            if (message.role !== "assistant") continue;
            for (const block of message.content) {
                if (block.type !== "tool_call" || block.server === true) continue;
                const queued = results.get(block.callId);
                const result = queued?.shift();
                if (result !== undefined) ordered.push(result);
            }
        }
        return providerContextMessages(ordered, this.#providerToolIds);
    }

    /** Turn one canonical call into its durable Base-owned batch entry. */
    #newToolEntry(index: number, call: SessionToolCallBlock): ToolBatchEntry {
        if (!Value.Check(cuid2Schema, call.callId)) {
            throw new Error(`Tool call "${call.callId}" is not a Base-generated ID.`);
        }
        return {
            key: this.#toolKey(index, call.callId),
            id: call.callId,
            call,
        };
    }

    /** Restore the Base/provider context identity pair dispatched before a restart. */
    #restoreToolEntry(key: string, value: unknown): ToolBatchEntry {
        if (!Value.Check(storedToolCallSchema, value)) {
            throw new Error(`The pending tool call under "${key}" is not valid.`);
        }
        const stored = value as StoredToolCall;
        if (
            stored.committed !== undefined &&
            !Value.Check(storedToolResultSchema, stored.committed)
        ) {
            throw new Error(`The committed result under "${key}" is not valid.`);
        }
        const call: SessionToolCallBlock = { ...stored.call, callId: stored.id };
        return {
            key,
            id: stored.id,
            call,
            ...(stored.committed === undefined
                ? {}
                : { committed: stored.committed as SessionToolResultMessage }),
        };
    }

    /** The durable representation pairs one Base identity with provider-context replay data. */
    #storedToolEntry(entry: ToolBatchEntry): StoredToolCall {
        if (entry.call.callId !== entry.id) {
            throw new Error(`Pending tool "${entry.id}" has a mismatched Base identity.`);
        }
        if (entry.committed !== undefined && entry.committed.callId !== entry.id) {
            throw new Error(`Pending tool "${entry.id}" has a mismatched committed result ID.`);
        }
        const { callId: _callId, server: _server, ...call } = entry.call;
        return {
            id: entry.id,
            call,
            ...(entry.committed === undefined ? {} : { committed: entry.committed }),
        };
    }

    /** Sorted by position in the batch; only one batch is ever pending at a time. */
    #toolKey(index: number, id: string): string {
        return `tool.${String(index).padStart(6, "0")}.${id}`;
    }

    /** The first-writer-wins durable claim shared by tool commit and ordinary settlement. */
    #toolResultKey(id: string): string {
        return `toolResult.${id}`;
    }

    /**
     * The scope one call owns: state lives under its Base ID and is erased when the call commits.
     * The same ID locates the call in conversation history.
     */
    #callScoped(ctx: Context, id: string): Context {
        return withAgentTaskContext(
            withAgentRunKV(
                withAgentKV(ctx, this.#kv.scoped("call", id)),
                this.#runKV.scoped("call", id),
            ),
            taskContextBeforeToolCall(this.#messages, id),
        );
    }

    /**
     * Call a tool hook that writes inside a transaction of its own call's. The lifetime ends with
     * the callback, so a context kept afterwards cannot outlive the transaction it belongs to.
     * Its failure is not contained: it rolls that transaction back.
     */
    async #invokeToolTransactHook<Argument>(
        txCtx: Context,
        id: string,
        hook: ((ctx: Context, argument: Argument) => MaybePromise<void>) | undefined,
        argument: Argument,
    ): Promise<void> {
        if (hook === undefined) return;
        const lifetime = new AbortController();
        try {
            await hook(this.#callScoped(withLifetime(txCtx, lifetime.signal), id), argument);
        } finally {
            lifetime.abort();
        }
    }

    /**
     * Run one tool call; every failure becomes an error tool result instead of an exception.
     * The context carries the turn's abort signal as its lifetime, so a running tool can
     * observe cancellation and stop its own work.
     */
    async #executeToolCall(ctx: Context, entry: ToolBatchEntry): Promise<SessionToolResultMessage> {
        const { call } = entry;
        const failure = (text: string): SessionToolResultMessage => ({
            role: "tool",
            callId: entry.id,
            content: [{ type: "text", text }],
            isError: true,
        });
        let tool: AnyAgentTool | undefined;
        try {
            tool = (await this.#tools(ctx)).find(
                (candidate) =>
                    candidate.name === call.name && candidate.namespace === call.namespace,
            );
        } catch (error: unknown) {
            return failure(error instanceof Error ? error.message : String(error));
        }
        if (tool === undefined) {
            return failure(`Tool "${call.name}" is not available.`);
        }
        if (call.incomplete === true) {
            return failure("The tool call was incomplete and was not executed.");
        }
        let args: unknown;
        if (tool.grammar !== undefined) {
            // A grammar tool is freeform: its own syntax constrained the model, so what arrives is
            // the text that grammar produced and never JSON. Reading it as JSON would refuse every
            // call a correct patch or query makes, so it is handed over as written.
            args = { input: call.arguments };
        } else {
            try {
                args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
            } catch {
                return failure(`The arguments for "${call.name}" were not valid JSON.`);
            }
        }
        if (tool.parameters !== undefined) {
            const argumentError = agentToolArgumentsError(call.name, tool.parameters, args);
            if (argumentError !== undefined) return failure(argumentError);
        }
        const callKV = this.#kv.scoped("call", entry.id);
        const callLifetime = new AbortController();
        let committing = false;
        const boundedCallKV = callKV.until(callLifetime.signal, () => !committing);
        const callCtx = withAgentKV(this.#callScoped(ctx, entry.id), boundedCallKV);
        // From here the call is one the two tool hooks bracket: a tool that exists, a call that
        // finished, and arguments its schema accepts. A call refused before that reaches neither
        // hook, because there is nothing yet to decide about or to report.
        let ran = tool;
        let ranArguments = args;
        let outcome: AgentBaseToolOutcome;
        let committedOutcome: AgentBaseToolOutcome | undefined;
        let commitAttempt: Promise<unknown> | undefined;
        let resolveCommitted!: (outcome: AgentBaseToolOutcome) => void;
        const committed = new Promise<AgentBaseToolOutcome>((resolve) => {
            resolveCommitted = resolve;
        });
        const outcomeFor = (result: unknown): AgentBaseToolOutcome => ({
            callId: entry.id,
            tool: ran,
            arguments: ranArguments,
            content: [...ran.toLLM(result)],
            isError: ran.isError?.(result) === true,
            result,
        });
        const commit = async (commitCtx: Context, result: unknown): Promise<unknown> => {
            if (commitAttempt !== undefined) return await commitAttempt;
            if (callLifetime.signal.aborted || commitCtx.lifetime?.aborted === true) {
                throw new Error("The tool call can no longer commit a result.");
            }
            if (!Value.Check(ran.returnType, result)) {
                throw new Error(`Tool "${ran.name}" committed an invalid result.`);
            }
            const candidate = outcomeFor(result);
            const message: SessionToolResultMessage = {
                role: "tool",
                callId: entry.id,
                content: candidate.content,
                ...(candidate.isError ? { isError: true } : {}),
            };
            committing = true;
            const attempt = (async () => {
                if (agentKV(commitCtx)?.prefix !== callKV.prefix) {
                    throw new Error(
                        "A tool result can only be committed with its own live call context.",
                    );
                }
                await this.#persistence.transaction(commitCtx, async (txCtx) => {
                    const claimed = await this.#persistence.writeValueIfAbsent(
                        txCtx,
                        this.#toolResultKey(entry.id),
                        message,
                    );
                    if (!claimed) {
                        throw new Error("The tool call already has a committed result.");
                    }
                    const pending = await this.#persistence.readValues(txCtx, entry.key);
                    const stored = pending.find(({ key }) => key === entry.key);
                    if (stored === undefined) {
                        throw new Error("The tool call has already been settled.");
                    }
                    const current = this.#restoreToolEntry(entry.key, stored.value);
                    if (current.id !== entry.id) {
                        throw new Error("The pending tool identity changed before commit.");
                    }
                    if (current.committed === undefined) {
                        await this.#persistence.writeValue(
                            txCtx,
                            entry.key,
                            this.#storedToolEntry({ ...entry, committed: message }),
                        );
                        await callKV.clear(txCtx);
                    }
                    afterCommit(txCtx, () => {
                        committedOutcome = candidate;
                        callLifetime.abort();
                        resolveCommitted(candidate);
                    });
                });
                return result;
            })();
            commitAttempt = attempt;
            try {
                return await attempt;
            } catch (error: unknown) {
                if (commitAttempt === attempt) {
                    commitAttempt = undefined;
                    committing = false;
                }
                throw error;
            }
        };
        try {
            const decision = await this.#hooks.beforeToolCall?.(callCtx, {
                callId: entry.id,
                tool,
                arguments: args,
            });
            if (decision?.type === "answer") {
                // The hook answered the model itself, so the tool never runs and there is no
                // structured result — only what the model is told.
                outcome = {
                    callId: entry.id,
                    tool,
                    arguments: args,
                    content: [...decision.content],
                    isError: decision.isError === true,
                };
            } else {
                if (decision?.tool !== undefined) ran = decision.tool;
                if (decision?.arguments !== undefined) ranArguments = decision.arguments;
                // An amended call is validated again: the schema that mattered is the one belonging
                // to the tool that is about to run, on the arguments it is about to receive.
                if ((ran !== tool || ranArguments !== args) && ran.parameters !== undefined) {
                    const argumentError = agentToolArgumentsError(
                        ran.name,
                        ran.parameters,
                        ranArguments,
                    );
                    if (argumentError !== undefined) throw new Error(argumentError);
                }
                const runCtx =
                    decision?.permissionMode === undefined
                        ? callCtx
                        : withAgentPermissionMode(callCtx, decision.permissionMode);
                const executionCtx = withLifetime(
                    runCtx,
                    AbortSignal.any(
                        runCtx.lifetime === undefined
                            ? [callLifetime.signal]
                            : [runCtx.lifetime, callLifetime.signal],
                    ),
                );
                const toolCall = {
                    id: entry.id,
                    kv: boundedCallKV,
                    commit,
                };
                const returned =
                    ran.transactional === true
                        ? this.#persistence.transaction(executionCtx, async (txCtx) => {
                              const result = await ran.execute(txCtx, ranArguments, toolCall);
                              if (!Value.Check(ran.returnType, result)) {
                                  throw new Error(`Tool "${ran.name}" returned an invalid result.`);
                              }
                              return await commit(txCtx, result);
                          })
                        : Promise.resolve(ran.execute(executionCtx, ranArguments, toolCall));
                const execution = returned.then(
                    (result) => ({ type: "returned", result }) as const,
                    (error: unknown) => ({ type: "threw", error }) as const,
                );
                const settled = await Promise.race([
                    execution,
                    committed.then((committed) => ({ type: "committed", committed }) as const),
                ]);
                if (settled.type === "committed") {
                    outcome = settled.committed;
                } else if (settled.type === "threw") {
                    throw settled.error;
                } else if (committedOutcome !== undefined) {
                    outcome = committedOutcome;
                } else {
                    if (!Value.Check(ran.returnType, settled.result)) {
                        throw new Error(`Tool "${ran.name}" returned an invalid result.`);
                    }
                    outcome = outcomeFor(settled.result);
                }
            }
        } catch (error: unknown) {
            outcome =
                committedOutcome ??
                ({
                    callId: entry.id,
                    tool: ran,
                    arguments: ranArguments,
                    content: [
                        {
                            type: "text",
                            text: error instanceof Error ? error.message : String(error),
                        },
                    ],
                    isError: true,
                } satisfies AgentBaseToolOutcome);
        }
        try {
            await this.#invokeHookOn(callCtx, this.#hooks.afterToolCall, outcome);
            return {
                role: "tool",
                callId: entry.id,
                content: outcome.content,
                ...(outcome.isError ? { isError: true } : {}),
            };
        } finally {
            callLifetime.abort();
        }
    }

    /**
     * A key that sorts after every entry the queue already holds. The order comes from the store
     * rather than from an in-memory counter, because a restarted agent begins counting again.
     * Reading the tail also keeps order correct when the clock moves backwards.
     */
    async #queueKey(ctx: Context, prefix: string): Promise<string> {
        const existing = await this.#persistence.readValues(ctx, prefix);
        const last = existing[existing.length - 1]?.key;
        const time = String(Date.now()).padStart(14, "0");
        const key = (slot: string, sequence: number): string =>
            `${prefix}${slot}.${String(sequence).padStart(6, "0")}`;
        if (last === undefined) return key(time, 0);
        const [lastSlot, lastSequence] = last.slice(prefix.length).split(".");
        if (lastSlot === undefined || time > lastSlot) return key(time, 0);
        // The queue already holds an entry from this millisecond, or from one still to come on
        // a clock that went backwards: continue the sequence rather than starting it again.
        return key(lastSlot, Number(lastSequence) + 1);
    }

    /**
     * Write a queue entry under a key nothing else holds. An enqueue running outside the
     * database transaction can race an independent one for the tail position, so the key is claimed
     * with an absent-only write and a taken key moves one sequence further rather than
     * overwriting whatever claimed it first.
     */
    async #claimQueueKey(ctx: Context, prefix: string, envelope: unknown): Promise<string> {
        let key = await this.#queueKey(ctx, prefix);
        for (let attempt = 0; attempt < 1000; attempt += 1) {
            if (await this.#persistence.writeValueIfAbsent(ctx, key, envelope)) return key;
            const [slot, sequence] = key.slice(prefix.length).split(".");
            key = `${prefix}${slot}.${String(Number(sequence) + 1).padStart(6, "0")}`;
        }
        throw new Error("A queue key could not be claimed after repeated collisions.");
    }

    /**
     * Consume one response stream into the assistant message it spells out, appending each block
     * to the store as it finishes and reporting every event to the hooks. What comes back is what
     * the model actually finished saying: a response cut off mid-block keeps the finished blocks
     * alone, so memory never differs from what a reload would rebuild.
     */
    async #collect(
        ctx: Context,
        stream: AsyncIterable<SessionEvent>,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<{
        readonly content: SessionAssistantBlock[];
        readonly state: SessionDoneState | undefined;
        /** Reported only by a response that completed; a cancelled or failed one measures none. */
        readonly tokens?: SessionTokens;
        readonly errorMessage?: string;
    }> {
        const content: SessionAssistantBlock[] = [];
        // Blocks that finished and were durably appended. An abort keeps exactly these, so the
        // in-memory assistant message never diverges from what a reload would rebuild.
        const persisted: SessionAssistantBlock[] = [];
        const toolCallIndexes = new Map<string, number>();
        const toolResultIndexes = new Map<string, number>();
        // Provider IDs remain only in the private context blocks. Every event and transactional
        // projection leaving this method uses the generated Base ID instead.
        const responseToolIds = new Map<string, string>();
        const persist = async (
            block: SessionAssistantBlock | undefined,
            event: AgentBasePersistedEvent | undefined,
        ): Promise<void> => {
            if (block === undefined) return;
            const record = assistantContextRecord(block, this.#providerToolIds);
            await this.#runPersistenceStep(this.#workContext(ctx), async (lockCtx) => {
                if (event === undefined || this.#hooks.onEventTransact === undefined) {
                    await this.#appendRecord(lockCtx, record);
                } else {
                    await this.#recordTransaction(lockCtx, async (txCtx) => {
                        await this.#appendRecord(txCtx, record);
                        await this.#withTransactionalContext(txCtx, (hookCtx) =>
                            this.#hooks.onEventTransact?.(hookCtx, event),
                        );
                    });
                }
            });
            persisted.push(block);
        };
        const iterator = stream[Symbol.asyncIterator]();
        // A response usually ends before its stream does — at the done event, or at an abort —
        // and the provider holds a connection behind that stream. Whichever way this method
        // leaves, an unfinished stream is asked to close, so nothing is left dangling. The
        // closure is not awaited: a provider that stalls while cleaning up must not stall the
        // turn, exactly as an abort must not wait for it either.
        let exhausted = false;
        try {
            while (true) {
                const next = await Promise.race([iterator.next(), abortPromise]);
                if (next === ABORTED) {
                    // Drop the unfinished block and end the turn.
                    await this.#emit(ctx, { type: "done", state: "cancelled" });
                    return { content: persisted, state: "cancelled" };
                }
                if (next.done === true) {
                    exhausted = true;
                    break;
                }
                const providerEvent = next.value;
                const event = baseSessionEvent(
                    providerEvent,
                    responseToolIds,
                    this.#providerToolIds,
                );
                await this.#emit(ctx, event);
                switch (event.type) {
                    case "text_start":
                        content.push({ type: "text", text: "" });
                        break;
                    case "text_delta": {
                        const last = content[content.length - 1];
                        if (last?.type === "text") {
                            content[content.length - 1] = {
                                type: "text",
                                text: last.text + event.delta,
                            };
                        }
                        break;
                    }
                    case "text_end": {
                        const last = content[content.length - 1];
                        await persist(
                            last?.type === "text" ? last : undefined,
                            last?.type === "text" ? { ...event, block: last } : undefined,
                        );
                        break;
                    }
                    case "reasoning_start":
                        content.push({ type: "reasoning", text: "" });
                        break;
                    case "reasoning_delta": {
                        const last = content[content.length - 1];
                        if (last?.type === "reasoning") {
                            content[content.length - 1] = {
                                ...last,
                                text: (last.text ?? "") + event.delta,
                            };
                        }
                        break;
                    }
                    case "reasoning_end": {
                        const last = content[content.length - 1];
                        if (last?.type === "reasoning") {
                            const finished = {
                                ...last,
                                ...(event.reasoning === undefined
                                    ? {}
                                    : { reasoning: event.reasoning }),
                            };
                            content[content.length - 1] = finished;
                            await persist(finished, { ...event, block: finished });
                        }
                        break;
                    }
                    case "toolcall_start": {
                        if (providerEvent.type !== "toolcall_start") {
                            throw new Error("The provider tool-call start changed event type.");
                        }
                        toolCallIndexes.set(event.callId, content.length);
                        content.push({
                            type: "tool_call",
                            callId: event.callId,
                            name: event.name,
                            arguments: "",
                            ...(event.namespace === undefined
                                ? {}
                                : { namespace: event.namespace }),
                            ...(event.server === undefined ? {} : { server: event.server }),
                            ...(providerEvent.vendor === undefined
                                ? {}
                                : { vendor: providerEvent.vendor }),
                        });
                        break;
                    }
                    case "toolcall_end": {
                        const index = toolCallIndexes.get(event.callId);
                        const block = index === undefined ? undefined : content[index];
                        if (index !== undefined && block?.type === "tool_call") {
                            const finished = {
                                ...block,
                                arguments: event.arguments,
                                ...(event.incomplete === undefined
                                    ? {}
                                    : { incomplete: event.incomplete }),
                            };
                            content[index] = finished;
                            const { vendor: _vendor, ...publicBlock } = finished;
                            await persist(finished, {
                                ...event,
                                block: publicBlock,
                            });
                        }
                        break;
                    }
                    case "toolcall_result_start": {
                        if (providerEvent.type !== "toolcall_result_start") {
                            throw new Error("The provider tool-result start changed event type.");
                        }
                        const callIndex = toolCallIndexes.get(event.callId);
                        const call = callIndex === undefined ? undefined : content[callIndex];
                        if (call?.type !== "tool_call") {
                            throw new Error("A provider tool result has no matching call.");
                        }
                        toolResultIndexes.set(event.callId, content.length);
                        content.push({
                            type: "tool_result",
                            callId: event.callId,
                            content: [],
                            ...(providerEvent.vendor === undefined
                                ? {}
                                : { vendor: providerEvent.vendor }),
                        });
                        break;
                    }
                    case "toolcall_result_delta":
                        break;
                    case "toolcall_result_end": {
                        const callIndex = toolCallIndexes.get(event.callId);
                        const call = callIndex === undefined ? undefined : content[callIndex];
                        const resultIndex = toolResultIndexes.get(event.callId);
                        if (resultIndex === undefined || call?.type !== "tool_call") {
                            throw new Error("A provider tool-result end has no matching start.");
                        }
                        const result = content[resultIndex];
                        if (result?.type !== "tool_result") {
                            throw new Error("A provider tool-result end has no matching start.");
                        }
                        const finished: SessionToolResultBlock = {
                            ...result,
                            content: event.content,
                            ...(event.isError === undefined ? {} : { isError: event.isError }),
                            ...(event.incomplete === undefined
                                ? {}
                                : { incomplete: event.incomplete }),
                        };
                        content[resultIndex] = finished;
                        await persist(finished, undefined);
                        break;
                    }
                    case "done":
                        return {
                            // Only blocks that finished, which are exactly the blocks that were
                            // durably appended. A response ending mid-block leaves half of
                            // something the model never finished saying, and keeping that in
                            // memory alone would make the next live request differ from the one
                            // a restart would rebuild from the store.
                            content: persisted,
                            state: event.state,
                            ...(event.state === "error" ? { errorMessage: event.message } : {}),
                            ...(event.state === "normal" ||
                            event.state === "tool_call" ||
                            event.state === "length"
                                ? { tokens: event.tokens }
                                : {}),
                        };
                    default:
                        break;
                }
            }
            return { content, state: undefined };
        } finally {
            // A done event ends the response, not the provider's ownership of its session. The
            // closure is requested here and waited for before the next request, rather than
            // now: a stream that has been told to stop and has not yet must not be able to hold
            // this turn — or an abort — open.
            if (!exhausted) {
                this.#settleLater(Promise.resolve(iterator.return?.()), "stream");
            }
        }
    }

    /**
     * Create the provider session on first use — or recreate it when the provider-facing
     * configuration changed, so the model always sees the tool descriptors the agent would
     * actually execute. The provider is resolved from the registry by its serializable ID at
     * that moment; an unregistered ID fails the turn like any thrown error.
     */
    async #ensureSession(
        instructions: string,
        tools: readonly AnyAgentTool[],
    ): Promise<BaseSession> {
        const key = sessionConfigKey(this.#providerId, this.#model, instructions, tools);
        if (this.#session !== undefined && this.#sessionConfig !== key) {
            const session = this.#session;
            this.#session = undefined;
            // The session being replaced may still be held by a response iterator that has not
            // finished unwinding. Destroying it first would tear it out from under that cleanup.
            await this.#settled();
            try {
                await session.destroy();
            } catch {
                // The stale session is abandoned either way.
            }
        }
        if (this.#session === undefined) {
            const provider = await this.#providers.resolve(this.#providerId, this.#model);
            if (provider === null) {
                throw new Error(`Provider "${this.#providerId}" is not registered.`);
            }
            this.#session = await provider.session(this.id, {
                instructions,
                tools: [...tools],
            });
            this.#sessionConfig = key;
        }
        return this.#session;
    }

    /** Report one stream event to the hooks. Hooks observe the stream; they never fail a run. */
    async #emit(ctx: Context, event: SessionEvent): Promise<void> {
        try {
            await this.#hooks.onEvent?.(this.#workContext(ctx), event);
        } catch {
            // Hooks observe the stream; they never fail a run.
        }
    }
}

/** The result that stands in for a call the agent could not, or must not, carry out. */
function toolFailure(id: string, reason: string): SessionToolResultMessage {
    return {
        role: "tool",
        callId: id,
        content: [{ type: "text", text: reason }],
        isError: true,
    };
}

/**
 * The provider-facing identity of a session configuration. Only descriptor fields the provider
 * sees participate, so re-created tool objects with identical descriptors do not churn the
 * session.
 */
function sessionConfigKey(
    provider: string,
    model: string | undefined,
    instructions: string,
    tools: readonly AnyAgentTool[],
): string {
    return deterministicStringify([
        provider,
        model ?? null,
        instructions,
        tools.map((tool) => [
            tool.name,
            tool.namespace ?? null,
            tool.namespaceDescription ?? null,
            tool.description ?? null,
            tool.parameters ?? null,
            tool.defer ?? null,
            tool.server ?? null,
            tool.grammar ?? null,
        ]),
    ]);
}
