import type {
    CompletedSessionCompaction,
    SessionCompaction,
    SessionDoneState,
    SessionEvent,
    SessionOutputBlock,
    SessionReasoningBlock,
    SessionSystemMessage,
    SessionTextBlock,
    SessionTokens,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type {
    AgentModuleAction,
    AgentModuleInferencePreparationAction,
} from "./AgentModuleAction.js";
import type { AgentMessageMetadata, AgentMetadataChange } from "./AgentMetadata.js";
import type { AgentPermissionMode } from "./AgentPermissionMode.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AnyAgentTool } from "./AgentTool.js";
import type {
    AgentInstructionsContribution,
    AgentInstructionsOverride,
    AgentToolsOverride,
} from "./AgentConfigurationOverride.js";

/** A value or a promise of it; every hook may answer either synchronously or asynchronously. */
export type MaybePromise<Value> = Value | Promise<Value>;

/**
 * A provider event whose completed assistant block is being committed to durable history.
 *
 * Raw stream observation still belongs to `onEvent`. This narrower event is delivered only for
 * valid terminal block events, inside the transaction that appends `block`, so starts, deltas,
 * retries, usage, done events, unmatched ends, and abandoned partial blocks never appear here.
 */
export type AgentBasePersistedEvent =
    | (Extract<SessionEvent, { readonly type: "text_end" }> & {
          readonly block: SessionTextBlock;
      })
    | (Extract<SessionEvent, { readonly type: "reasoning_end" }> & {
          readonly block: SessionReasoningBlock;
      })
    | (Extract<SessionEvent, { readonly type: "toolcall_end" }> & {
          readonly block: SessionToolCallBlock;
      });

/** What the `modelChanged` hook sees when a consumed message changes the effective model. */
export interface AgentBaseModelChange {
    /** The model in force before this change, absent when none had been set yet. */
    readonly previousModel: string | undefined;
    /** The model now in force. */
    readonly model: string;
    /** The registry ID of the provider serving the previous model. */
    readonly previousProvider: string;
    /** The registry ID of the provider serving the new model. */
    readonly provider: string;
    /** The registry the agent resolves its providers from. */
    readonly providers: AgentProviders;
    /** True when the change was incompatible and the conversation history was erased. */
    readonly wasReset: boolean;
}

/**
 * What the message-accepted hooks see: one queued message at the moment it stops being something
 * waiting outside the conversation and becomes part of it.
 *
 * The two queues are the same thing at different times — steering injects between responses, a send
 * waits until the agent would otherwise stop — so the kind is what tells a listener which of the two
 * it is looking at. Everything else about the message is in the message.
 */
export interface AgentBaseAcceptedMessage {
    /** The stable cuid2 identity assigned when this message was first offered. */
    readonly id: string;
    /** Which queue the message waited in, and therefore what made it inject when it did. */
    readonly kind: "steering" | "send";
    /** The message exactly as it entered the conversation, in the role it was queued under. */
    readonly message: AgentQueuedMessage;
    /** Immutable module-owned metadata supplied with the message. */
    readonly metadata?: AgentMessageMetadata;
}

/** What the activation hook sees when the agent stops being settled and starts owing work. */
export interface AgentBaseActivation {
    /**
     * True when the work being taken up was inherited from a previous process: the agent was
     * already recorded as owing it when this process started, so it is being reactivated by the
     * agent system's restart rather than by a message scheduled just now.
     */
    readonly restored: boolean;
}

/** What the permission-mode hooks see when a consumed message changes how much may be touched. */
export interface AgentBasePermissionModeChange {
    /** The mode in force until this message was consumed. */
    readonly previousMode: AgentPermissionMode;
    /** The mode now in force, and carried on every context the agent derives from here on. */
    readonly mode: AgentPermissionMode;
}

/** Stable Base-owned identity of one settled-to-settled loop. */
export interface AgentBaseLoop {
    readonly loopId: string;
}

/** Stable identity of one turn within a loop. */
export interface AgentBaseTurnStart extends AgentBaseLoop {
    readonly turnId: string;
    /**
     * The true size of the conversation context in tokens, as the provider last measured it:
     * the complete input it received plus the output it generated. It is durable, so it
     * survives a restart, and it is cleared whenever the conversation is replaced — by a
     * compaction or by a reset — until the next response measures the new one. Absent only
     * before any response has been measured.
     */
    readonly contextTokens: number | undefined;
}

/** The conversation state at a safe boundary immediately before a possible inference request. */
export type AgentBaseInferencePreparation = AgentBaseTurnStart;

/** Stable identity of one provider inference within a turn. */
export interface AgentBaseInferenceStart extends AgentBaseTurnStart {
    readonly inferenceId: string;
}

/** What the `afterInference` hook sees about the response that just completed. */
export interface AgentBaseInference extends AgentBaseInferenceStart {
    /** How the response ended, or undefined when the stream ended without a done event. */
    readonly state: SessionDoneState | undefined;
    /**
     * The real token counts the provider reported for this response: the complete input context
     * it received plus the output it generated. Absent when the response was cancelled, failed,
     * or ended without a done event, since no count was measured.
     */
    readonly tokens: SessionTokens | undefined;
    /** The failure text of a provider-reported error response. */
    readonly errorMessage?: string;
}

/** What `afterTurn` sees about the turn that just ended. */
export interface AgentBaseTurn extends AgentBaseTurnStart {
    /**
     * True when the turn was cancelled by `abort`. The work it had already done stays in the
     * history, but it stopped early, so a module should generally not act on it.
     */
    readonly aborted: boolean;
}

/** Stable identity and pre-replacement state of one compaction attempt. */
export interface AgentBaseCompactionStart extends AgentBaseTurnStart {
    readonly compactionId: string;
}

/** A provider compaction outcome paired with the attempt that produced it. */
export interface AgentBaseCompaction extends AgentBaseCompactionStart {
    readonly result: SessionCompaction;
}

/** A completed outcome whose replacement history is being committed. */
export interface AgentBaseCompletedCompaction extends AgentBaseCompactionStart {
    readonly result: CompletedSessionCompaction;
}

/** Stable identity of the transaction that settles one loop, and how that loop ended. */
export interface AgentBaseSettlement extends AgentBaseLoop {
    readonly settlementId: string;
    /**
     * Why the run failed, when it did. Every run settles, including the ones that ended badly —
     * a provider error, a usage limit, a conversation that could not be read, a failure thrown
     * out of the loop itself — and this is what that ending was, in the same words the failure
     * was surfaced to the conversation with.
     *
     * Absent when the run simply ran out of work, and absent as well from a settlement resumed
     * by a later process, which knows only that a run was left unfinished and not why. A module
     * reporting a run to somebody waiting on it should treat its presence as the difference
     * between an answer and an apology.
     */
    readonly error?: string;
}

/** One validated tool invocation, as it stands before anything decides what to do with it. */
export interface AgentBaseToolCall {
    /** Base-generated CUID2 used by every hook, execution, result, and public projection. */
    readonly callId: string;
    /** The tool definition the call resolved to, already amended by any earlier decision. */
    readonly tool: AnyAgentTool;
    /** The call's arguments, validated against the tool's schema and amended the same way. */
    readonly arguments: unknown;
}

/**
 * What a `beforeToolCall` hook decides about one call. Nothing here runs anything: the hook says
 * what should happen and the loop is what carries it out, so tool execution stays in one place —
 * the place that also commits the result, retries an interrupted batch, and settles a cancelled
 * one.
 *
 * Answering `undefined` decides nothing and leaves the call exactly as it stands.
 */
export type AgentBaseToolCallDecision =
    | {
          /** Run the call, with whatever this decision changes about it. */
          readonly type: "run";
          /** Run this tool instead of the one the model named. */
          readonly tool?: AnyAgentTool;
          /** Run with these arguments instead, revalidated against the tool that will run. */
          readonly arguments?: unknown;
          /**
           * Run this one call under another permission mode. It applies to the execution and to
           * nothing else: the agent's own mode is untouched and the next call is decided again.
           */
          readonly permissionMode?: AgentPermissionMode;
      }
    | {
          /**
           * Answer the model directly; the tool never runs. This is how a call is refused, served
           * from a cache, or replaced by something the hook already knows.
           */
          readonly type: "answer";
          /** Exactly what the model is told this call produced. */
          readonly content: readonly SessionOutputBlock[];
          /** Whether the model is told the call failed. */
          readonly isError?: boolean;
      };

/**
 * What a call ended up producing, for the hooks that only watch. Every call reaches this once,
 * whether it ran, was answered by a hook, or failed before it could run at all.
 */
export interface AgentBaseToolOutcome {
    /** Base-generated CUID2 of the call. */
    readonly callId: string;
    /** The tool that actually ran, after any replacement a decision made. */
    readonly tool: AnyAgentTool;
    /** The arguments it actually ran with. */
    readonly arguments: unknown;
    /** Exactly what the model is told, whatever produced it. */
    readonly content: readonly SessionOutputBlock[];
    /** Whether the model is told the call failed. */
    readonly isError: boolean;
    /**
     * The structured result the tool returned. Absent when the tool never ran — a hook answered
     * the call, or it failed before or during execution — so its presence is what distinguishes a
     * tool that answered from one that never got the chance.
     */
    readonly result?: unknown;
}

/**
 * Optional observation and extension points. Every hook may answer synchronously or with a
 * promise, and the run waits for that answer. Observing-hook failures are contained; correctness
 * and transactional-hook failures follow the contract documented on that hook. Every hook
 * receives the agent's context, including its immutable AgentConfig and current selection.
 */
export interface AgentBaseHooks {
    /** Called and awaited for published provider session events, for observation only. */
    readonly onEvent?: (ctx: Context, event: SessionEvent) => MaybePromise<unknown>;
    /**
     * Called only for a published completed assistant block, inside the transaction that appends
     * it to durable history. A context-only provider call is omitted while Base still appends the
     * private model-context block. A failure rolls the append and every hook write back.
     */
    readonly onEventTransact?: (ctx: Context, event: AgentBasePersistedEvent) => MaybePromise<void>;
    /**
     * Extends `state.instructions` for the session, consulted before each inference and
     * compaction. This is a correctness hook: a failure fails the turn loudly instead of
     * silently running with a wrong prompt.
     */
    readonly instructions?: (ctx: Context) => MaybePromise<string>;
    /**
     * Supplies already attributed instruction fragments during facade assembly. `Agent` uses this
     * seam to preserve each module's identity while keeping ordinary instruction hooks ahead of
     * tool resolution. A failure fails the turn before any tool hook runs.
     */
    readonly instructionContributions?: (
        ctx: Context,
    ) => MaybePromise<readonly AgentInstructionsContribution[]>;
    /**
     * Replaces the complete provider-facing instructions after mutable state, `instructions`, the
     * final tools, and their generated capability guidance have contributed. The returned string
     * is final: Base appends nothing to it. The input keeps every original fragment attributed and
     * carries the effective provider/model selection. This is a correctness hook: failure fails
     * the turn.
     */
    readonly overrideInstructions?: (
        ctx: Context,
        input: AgentInstructionsOverride,
    ) => MaybePromise<string>;
    /**
     * Extends `state.tools` for the session, consulted once before each inference and compaction,
     * and before tool execution. This is a correctness hook: a failure — including duplicate
     * tool names in the merged list — fails the turn loudly instead of silently running with
     * wrong tools. When the merged descriptors change between inferences, the provider session
     * is recreated so the model sees the current tools.
     */
    readonly tools?: (ctx: Context) => MaybePromise<readonly AnyAgentTool[]>;
    /**
     * Replaces the complete provider-facing tool array after mutable state and `tools` have
     * contributed. Only the returned final descriptors are validated, so an override may remove
     * an invalid or conflicting ordinary contribution. This is a correctness hook: failure fails
     * the turn.
     */
    readonly overrideTools?: (
        ctx: Context,
        input: AgentToolsOverride,
    ) => MaybePromise<readonly AnyAgentTool[]>;
    /** Called immediately before the provider is asked to compact the current history. */
    readonly beforeCompaction?: (
        ctx: Context,
        compaction: AgentBaseCompactionStart,
    ) => MaybePromise<void>;
    /**
     * Runs inside a successful compaction's replacement transaction, after superseded history and
     * history KV have been cleared and before the replacement record is appended. A failure rolls
     * the entire replacement back.
     */
    readonly historyErasedTransact?: (
        ctx: Context,
        compaction: AgentBaseCompletedCompaction,
    ) => MaybePromise<void>;
    /**
     * Observes the provider outcome. Completed outcomes arrive only after replacement history has
     * committed; failed and cancelled outcomes arrive after the provider returns them.
     */
    readonly afterCompaction?: (
        ctx: Context,
        compaction: AgentBaseCompaction,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction that makes a dispatched batch durable, once per call in it,
     * before anything runs. That transaction is what records that these calls are owed results, so
     * a hook writing its own note of a call about to happen commits it with exactly that fact.
     *
     * The call contains the block the model produced with its provider ID replaced by Base's
     * CUID2 and opaque provider replay metadata removed; arguments remain unparsed because nothing
     * has resolved or validated it yet. A batch being resumed after a restart does not run this
     * again: it was already dispatched, and the process that dispatched it already ran the hook.
     * A failure rolls the dispatch back and fails the turn.
     */
    readonly beforeToolCallTransact?: (
        ctx: Context,
        call: SessionToolCallBlock,
    ) => MaybePromise<void>;
    /**
     * Decides what to do with one call, after the tool has been resolved and its arguments have
     * passed validation, and before anything runs. The hook may leave the call alone, amend it —
     * another tool, other arguments, another permission mode for this one execution — or answer
     * the model itself, in which case the tool never runs.
     *
     * It cannot run anything. Execution belongs to the loop, which is also what commits the
     * result, resumes an interrupted batch, and settles a cancelled one; a hook that drove
     * execution would be deciding inside machinery it cannot see. This is a correctness hook: a
     * failure becomes that call's error result.
     */
    readonly beforeToolCall?: (
        ctx: Context,
        call: AgentBaseToolCall,
    ) => MaybePromise<AgentBaseToolCallDecision | undefined>;
    /**
     * Called once per call with what it produced, before that result is committed to the
     * conversation. Observing only: the model has already been answered, so a failure here is
     * contained and changes nothing.
     */
    readonly afterToolCall?: (ctx: Context, outcome: AgentBaseToolOutcome) => MaybePromise<void>;
    /**
     * Runs inside the transaction that appends one result to the durable conversation and releases
     * the call it answers, so what a module concludes about the result and the result itself
     * become durable together.
     *
     * Every Base-executed result the conversation records reaches this, including results no
     * execution produced: a call settled as an error because an abort, shutdown, restart, or
     * failed turn ended it. It receives the public result under Base's CUID2 with opaque provider
     * replay metadata removed. A failure rolls that commit back, leaving the call unanswered.
     */
    readonly afterToolCallTransact?: (
        ctx: Context,
        result: SessionToolResultMessage,
    ) => MaybePromise<void>;
    /**
     * Called when a consumed message changes the effective model. An incompatible change —
     * judged by the provider-model compatibility matrix — erases the conversation history
     * completely and destroys the old provider session; the handoff system message this hook
     * returns is then injected at the very beginning of the fresh context, and without one the
     * context starts completely empty. On a compatible change the history stays and the return
     * value is ignored. A hook failure during an incompatible change rejects the switch: the
     * previous selection stays effective and the history is not cleared.
     */
    readonly modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => MaybePromise<SessionSystemMessage | undefined>;
    /**
     * Runs inside the transaction that moves a queued message into the durable conversation, once
     * per message and in the order the messages were appended. The context carries the selection
     * the message made effective, including its permission mode, so a hook writing its own record
     * of what was said records it under what it was actually said to.
     *
     * This is where a durable account of the conversation belongs: what it writes commits with the
     * message itself, so no reader can ever see one without the other. A failure rolls the whole
     * consumption back — the message stays queued, and the turn reports the failure — because a
     * message recorded nowhere is worse than a message not yet delivered.
     */
    readonly messageAcceptedTransact?: (
        ctx: Context,
        accepted: AgentBaseAcceptedMessage,
    ) => MaybePromise<void>;
    /**
     * Called once per message after the consumption has committed, in the order the messages were
     * appended. This is the observing half: it may take as long as it
     * likes and its failure is contained, so anything that must not be able to undo the message
     * belongs here rather than in the transactional hook.
     */
    readonly messageAccepted?: (
        ctx: Context,
        accepted: AgentBaseAcceptedMessage,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction that commits a consumed message which changed the permission
     * mode, before the message-accepted hooks for that same consumption. A failure rolls the
     * consumption back, so the mode never changes without whatever a module concluded from it.
     */
    readonly permissionModeChangedTransact?: (
        ctx: Context,
        change: AgentBasePermissionModeChange,
    ) => MaybePromise<void>;
    /**
     * Called after such a consumption has committed, with the mode that is now in force on every
     * context the agent derives. Observing only: the mode has already changed, and a failure here
     * cannot take it back.
     */
    readonly permissionModeChanged?: (
        ctx: Context,
        change: AgentBasePermissionModeChange,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction merging an agent's metadata into its durable configuration.
     * A failure rolls the configuration update back.
     */
    readonly metadataChangedTransact?: (
        ctx: Context,
        change: AgentMetadataChange,
    ) => MaybePromise<void>;
    /** Observes an agent metadata update after the merged configuration has committed. */
    readonly metadataChanged?: (ctx: Context, change: AgentMetadataChange) => MaybePromise<void>;
    /**
     * Runs inside the transaction that makes a settled agent owe work again. For a scheduled
     * message that is the transaction admitting it to its durable queue — the moment the agent
     * becomes active, before the message is ever accepted into the conversation. When a restart
     * resumes work a previous process left owing, it is the transaction in which the resumed run
     * first records its stage, and `restored` is true. A failure rolls the activation back: a
     * scheduling is refused with the message kept out of the queue, and a resumed run retries
     * the announcement with its next stage record.
     */
    readonly afterAgentActivatedTransact?: (
        ctx: Context,
        activation: AgentBaseActivation,
    ) => MaybePromise<void>;
    /**
     * Runs after the agent is staged as working, inside the transaction committing that state.
     */
    readonly beforeAgentLoopTransact?: (ctx: Context, loop: AgentBaseLoop) => MaybePromise<void>;
    /** Called when the loop leaves the settled state and begins working. */
    readonly beforeAgentLoop?: (ctx: Context, loop: AgentBaseLoop) => MaybePromise<void>;
    /** Runs inside the transaction committing the inference stage for the turn being opened. */
    readonly beforeTurnTransact?: (ctx: Context, turn: AgentBaseTurnStart) => MaybePromise<void>;
    /**
     * Called at the start of each turn, before its queues drain, with the conversation's measured
     * size. Returned actions are applied before the turn runs. An `inject` action is durably
     * queued until pending tools and compaction settle, then its system notice joins history
     * immediately before inference.
     */
    readonly beforeTurn?: (
        ctx: Context,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<readonly AgentModuleAction[] | undefined>;
    /**
     * Checks the settled, queue-admitted conversation immediately before each possible provider
     * request. A returned compaction runs first, then this boundary is checked again before the
     * durable inference stage opens.
     */
    readonly prepareInference?: (
        ctx: Context,
        preparation: AgentBaseInferencePreparation,
    ) => MaybePromise<readonly AgentModuleInferencePreparationAction[] | undefined>;
    /** Runs inside the transaction committing the inference stage for the request being made. */
    readonly beforeInferenceTransact?: (
        ctx: Context,
        inference: AgentBaseInferenceStart,
    ) => MaybePromise<void>;
    /** Called immediately before each inference request. */
    readonly beforeInference?: (
        ctx: Context,
        inference: AgentBaseInferenceStart,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction committing the response's measured context size. A response
     * without a measurement instead recommits its inference stage with this hook.
     */
    readonly afterInferenceTransact?: (
        ctx: Context,
        inference: AgentBaseInference,
    ) => MaybePromise<void>;
    /**
     * Called immediately after each inference response is collected, with how it ended and the
     * token counts the provider measured for it.
     */
    readonly afterInference?: (ctx: Context, inference: AgentBaseInference) => MaybePromise<void>;
    /** Runs inside the transaction committing the stage left by the completed turn. */
    readonly afterTurnTransact?: (ctx: Context, turn: AgentBaseTurn) => MaybePromise<void>;
    /**
     * Called when a turn ends, with the conversation's measured size and whether the turn was
     * cancelled. Returned actions are all applied together before the loop continues; any of
     * them drives the loop into another turn. An injected notice is appended after any
     * compaction requested by the same action batch.
     */
    readonly afterTurn?: (
        ctx: Context,
        turn: AgentBaseTurn,
    ) => MaybePromise<readonly AgentModuleAction[] | undefined>;
    /** Runs inside the transaction committing the stage left by the completed loop. */
    readonly afterAgentLoopTransact?: (ctx: Context, loop: AgentBaseLoop) => MaybePromise<void>;
    /**
     * Called when the loop would settle back to idle. Returned actions are all applied together
     * and start the work over instead of settling.
     */
    readonly afterAgentLoop?: (
        ctx: Context,
        loop: AgentBaseLoop,
    ) => MaybePromise<readonly AgentModuleAction[] | undefined>;
    /**
     * Called inside the transaction that settles the agent, before the settlement commits. The
     * key-value store on the context writes into that same transaction, so a conclusion about
     * the run and the fact that the run is over become durable together, without a second commit
     * a crash could land between. The `Transact` suffix is what marks this: a hook carrying it
     * runs inside a transaction, and everything it writes commits or rolls back with it.
     *
     * Unlike the observing hooks, a failure here is not swallowed. It rolls the settlement back,
     * leaving the agent recorded as still working, because a conclusion that failed to be
     * written must not be reported as one that was. The store handle is lent for the call only.
     */
    readonly afterAgentSettledTransact?: (
        ctx: Context,
        settlement: AgentBaseSettlement,
    ) => MaybePromise<void>;
    /** Called once after the loop has fully settled and no module reopened it. */
    readonly afterAgentSettled?: (
        ctx: Context,
        settlement: AgentBaseSettlement,
    ) => MaybePromise<void>;
}
