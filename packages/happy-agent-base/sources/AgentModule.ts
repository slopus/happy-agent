import type {
    ProviderModelCompatibilityType,
    SessionEvent,
    SessionReasoningEffort,
    SessionServiceTier,
    SessionSystemMessage,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentDatabase, AgentModuleMigration } from "./AgentDatabase.js";
import type {
    AgentBaseAcceptedMessage,
    AgentBaseActivation,
    AgentBaseCompaction,
    AgentBaseCompactionStart,
    AgentBaseCompletedCompaction,
    AgentBaseInference,
    AgentBaseInferencePreparation,
    AgentBaseInferenceStart,
    AgentBaseLoop,
    AgentBaseModelChange,
    AgentBasePermissionModeChange,
    AgentBasePersistedEvent,
    AgentBaseToolCall,
    AgentBaseToolCallDecision,
    AgentBaseToolOutcome,
    AgentBaseSettlement,
    AgentBaseTurn,
    AgentBaseTurnStart,
    MaybePromise,
} from "./AgentBaseHooks.js";
import type {
    AgentModuleAction,
    AgentModuleInferencePreparationAction,
} from "./AgentModuleAction.js";
import type { AgentKV } from "./AgentKV.js";
import type { AgentMetadata, AgentMetadataChange } from "./AgentMetadata.js";
import type { AgentPermissionMode } from "./AgentPermissionMode.js";
import type { AgentSystemRef } from "./AgentSystemRef.js";
import type { AnyAgentTool } from "./AgentTool.js";

/**
 * The agent a hook is serving, in full. One module instance serves every agent in a collection,
 * so this — rather than anything the module was constructed with — is what tells it whose turn
 * it is looking at, and what that agent is about to run on.
 */
export interface AgentModuleAgent {
    /** The generated or caller-supplied cuid2 identity, stable for the agent's whole life. */
    readonly id: string;
    /** The immutable descriptive metadata currently stored in this agent's configuration. */
    readonly metadata: AgentMetadata | undefined;
    /** The registry ID of the provider in force, which one agent may switch between. */
    readonly provider: string;
    /**
     * What kind of provider that ID is registered as — `"claude"`, `"codex"`, and so on. It is
     * the vendor shape a module has to reason about when a provider ID alone says nothing, and
     * is absent when the ID is not registered.
     */
    readonly providerKind: ProviderModelCompatibilityType | undefined;
    /** The model in force, absent when none was ever selected. */
    readonly model: string | undefined;
    /** The reasoning effort in force, absent when none was ever selected. */
    readonly effort: SessionReasoningEffort | undefined;
    /** The service tier in force, absent when none was ever selected. */
    readonly tier: SessionServiceTier | undefined;
    /**
     * How much of the machine the agent may touch. The runtime carries it and makes its changes
     * durable but enforces nothing, so a module whose tools act on the machine is what decides
     * what this mode actually permits.
     */
    readonly permissionMode: AgentPermissionMode;
}

/**
 * What every hook of a module is handed alongside the context: which agent it is running for,
 * and the four stores it may write to, each with its own lifetime.
 * Database work uses the active root or transaction facade carried by `ctx.db`.
 *
 * They are passed rather than read off the context because a module's own dependencies are not
 * ambient state to be looked up: a hook is given exactly what it is entitled to, and cannot be
 * handed a context that quietly means a different agent.
 */
export interface AgentModuleScope<_Database extends AgentDatabase = AgentDatabase> {
    /** The agent this hook is running for, and the selection it is running on. */
    readonly agent: AgentModuleAgent;
    /**
     * The module's durable store for this one agent, scoped to `module.<name>`. It belongs to
     * the agent's conversation: it outlives every run, and it is cleared when the identity is
     * created again. Renaming a module orphans everything it stored here.
     */
    readonly kv: AgentKV;
    /**
     * The module's durable store shared by every agent in the collection, and outliving all of
     * them. Work one agent owes another lives here, since an agent's own store belongs to its
     * conversation alone.
     */
    readonly sharedKV: AgentKV;
    /**
     * The module's store for the run in progress, erased in the transaction that settles the
     * agent. It is where a module keeps what only makes sense while the agent is working, so a
     * crash mid-run leaves notes a resumed run can read, and a finished run leaves none at all.
     */
    readonly runKV: AgentKV;
    /**
     * Durable state belonging only to the current conversation history. It survives turns and
     * restarts, then is cleared and its old handle expires when compaction or an incompatible
     * model change replaces that history.
     */
    readonly historyKV: AgentKV;
}

/** Immutable agent identity and metadata observed at a system lifecycle boundary. */
export interface AgentModuleAgentLifecycle {
    readonly id: string;
    readonly metadata: AgentMetadata | undefined;
}

/** System-owned capabilities handed to module lifecycle observers. */
export interface AgentModuleSystemScope<Database extends AgentDatabase = AgentDatabase> {
    readonly agents: AgentSystemRef<Database>;
    readonly sharedKV: AgentKV;
}

/**
 * One independent capability of an `Agent`: a name, its durable migrations, and one entry
 * point. Everything the module does at runtime is in the hooks `beforeStart` returns, so an
 * implementation closes over whatever state that entry point built rather than exposing it on
 * the module object.
 */
export interface AgentModule<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
> {
    /**
     * A stable identifier for the module. Its persisted key-value entries live under this
     * name, so renaming a module orphans everything it stored.
     */
    readonly name: string;
    /**
     * Ordered durable migrations owned by this module. Keys are immutable identities and may
     * only be appended; each function and its success marker commit atomically before beforeStart.
     */
    readonly migrations?: readonly AgentModuleMigration<Database>[];
    /**
     * The module's one entry point. Called once after the owning AgentSystem acquires its store
     * lock and before any agent is restored or started. Every module initializes concurrently,
     * and agent work begins only after all of them settle successfully. The hooks it returns are
     * the module's whole runtime behavior; returning nothing means the module only migrates and
     * initializes.
     */
    readonly beforeStart?: (
        ctx: Context,
        agents: AgentSystemRef<Database>,
    ) => MaybePromise<AgentModuleHooks<Tool, Database> | void>;
}

/**
 * One module resolved for runtime: its identity beside the hooks its `beforeStart` returned.
 * The system resolves every module once at start and hands these to the agents it builds.
 */
export interface AgentModuleRuntime<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
> {
    /** The module's stable name, which scopes its key-value stores. */
    readonly name: string;
    /** The module these hooks came from. */
    readonly module: AgentModule<Tool, Database>;
    /** What the module's beforeStart returned, or nothing at all. */
    readonly hooks: AgentModuleHooks<Tool, Database>;
}

/**
 * The runtime behavior one module returned from its `beforeStart`: any subset of the agent
 * hooks, which the agent merges into the singular hooks its internal `AgentBase` runs with. The
 * hook contracts are the same as `AgentBaseHooks`; see there for when each hook fires and what
 * its return value means.
 *
 * Agent-scoped hooks receive the agent's context first and their `AgentModuleScope<Database>` second.
 * System hooks instead receive the system context and its deadlock-safe `AgentSystemRef`.
 */
export interface AgentModuleHooks<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
> {
    /**
     * Called once after every durable-active agent has been restored and started. Every module
     * runs concurrently, and system creation resolves only after all of them settle successfully.
     */
    readonly afterStart?: (ctx: Context, agents: AgentSystemRef<Database>) => MaybePromise<void>;
    readonly agentCreatedTransact?: (
        ctx: Context,
        scope: AgentModuleSystemScope<Database>,
        agent: AgentModuleAgentLifecycle,
    ) => MaybePromise<void>;
    readonly agentCreated?: (
        ctx: Context,
        scope: AgentModuleSystemScope<Database>,
        agent: AgentModuleAgentLifecycle,
    ) => MaybePromise<void>;
    readonly agentRestoredTransact?: (
        ctx: Context,
        scope: AgentModuleSystemScope<Database>,
        agent: AgentModuleAgentLifecycle,
    ) => MaybePromise<void>;
    readonly agentRestored?: (
        ctx: Context,
        scope: AgentModuleSystemScope<Database>,
        agent: AgentModuleAgentLifecycle,
    ) => MaybePromise<void>;
    readonly agentArchivedTransact?: (
        ctx: Context,
        scope: AgentModuleSystemScope<Database>,
        agent: AgentModuleAgentLifecycle,
    ) => MaybePromise<void>;
    readonly agentArchived?: (
        ctx: Context,
        scope: AgentModuleSystemScope<Database>,
        agent: AgentModuleAgentLifecycle,
    ) => MaybePromise<void>;
    /** Observes published session events; context-only provider lifecycles are omitted. */
    readonly onEvent?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        event: SessionEvent,
    ) => MaybePromise<unknown>;
    /** Runs inside a published assistant-block transaction; context-only provider calls are omitted. */
    readonly onEventTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        event: AgentBasePersistedEvent,
    ) => MaybePromise<void>;
    /** Merged after the base state and every earlier module's instructions, in module order. */
    readonly instructions?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
    ) => MaybePromise<string>;
    /** Merged after the base state and every earlier module's tools, in module order. */
    readonly tools?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
    ) => MaybePromise<readonly Tool[]>;
    /** Observes the start of a provider compaction attempt. */
    readonly beforeCompaction?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        compaction: AgentBaseCompactionStart,
    ) => MaybePromise<void>;
    /** Runs inside the transaction replacing history after a successful compaction. */
    readonly historyErasedTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        compaction: AgentBaseCompletedCompaction,
    ) => MaybePromise<void>;
    /** Observes the provider compaction outcome, after commit for a completed replacement. */
    readonly afterCompaction?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        compaction: AgentBaseCompaction,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction that makes a dispatched batch durable, once per call in it.
     * Modules run in array order and a failure propagates, rolling the dispatch back.
     */
    readonly beforeToolCallTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        call: SessionToolCallBlock,
    ) => MaybePromise<void>;
    /**
     * Decides what to do with one validated call before it runs. Modules are asked in array
     * order: what one of them amends is what the next one sees, and the first to answer the model
     * settles the call and ends the chain.
     */
    readonly beforeToolCall?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        call: AgentBaseToolCall,
    ) => MaybePromise<AgentBaseToolCallDecision | undefined>;
    /** Observes what one call produced, before its result is committed. */
    readonly afterToolCall?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        outcome: AgentBaseToolOutcome,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction appending one Base-executed tool result to the durable
     * conversation. Modules run in array order and a failure propagates, rolling that commit back.
     */
    readonly afterToolCallTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        result: SessionToolResultMessage,
    ) => MaybePromise<void>;
    /** The first module that returns a handoff message wins the reset injection. */
    readonly modelChanged?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        change: AgentBaseModelChange,
    ) => MaybePromise<SessionSystemMessage | undefined>;
    /**
     * Runs inside the transaction appending a queued message to the durable conversation, once per
     * message. Modules run in array order and a failure propagates, rolling the consumption back.
     */
    readonly messageAcceptedTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        accepted: AgentBaseAcceptedMessage,
    ) => MaybePromise<void>;
    /** Observes the same messages once the consumption has committed. */
    readonly messageAccepted?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        accepted: AgentBaseAcceptedMessage,
    ) => MaybePromise<void>;
    /** Transactional counterpart to `permissionModeChanged`; a failure rolls the change back. */
    readonly permissionModeChangedTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        change: AgentBasePermissionModeChange,
    ) => MaybePromise<void>;
    /** Observes a permission-mode change a consumed message made, once it is durable. */
    readonly permissionModeChanged?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        change: AgentBasePermissionModeChange,
    ) => MaybePromise<void>;
    /** Transactional counterpart to `metadataChanged`; a failure rolls the merge back. */
    readonly metadataChangedTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        change: AgentMetadataChange,
    ) => MaybePromise<void>;
    /** Observes the complete merged agent metadata after it commits. */
    readonly metadataChanged?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        change: AgentMetadataChange,
    ) => MaybePromise<void>;
    /**
     * Runs inside the transaction that makes a settled agent owe work again: scheduling a
     * message activates it, and a restart reactivates one that still owed work, with `restored`
     * true. Modules run in array order and a failure propagates, rolling the activation back.
     */
    readonly afterAgentActivatedTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        activation: AgentBaseActivation,
    ) => MaybePromise<void>;
    /** Transactional counterpart to `beforeAgentLoop`. */
    readonly beforeAgentLoopTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        loop: AgentBaseLoop,
    ) => MaybePromise<void>;
    /** Called when the loop leaves the settled state and begins working. */
    readonly beforeAgentLoop?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        loop: AgentBaseLoop,
    ) => MaybePromise<void>;
    /** Transactional counterpart to `beforeTurn`. */
    readonly beforeTurnTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<void>;
    /**
     * Receives the measured size of the context the turn is about to run on. Actions from every
     * module are concatenated and applied before the turn's first inference. Injected notices
     * wait for pending tool settlement and compaction before joining history.
     */
    readonly beforeTurn?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<readonly AgentModuleAction[] | undefined>;
    /**
     * Receives the settled context after queued input joins its active run and before every
     * possible provider request. Compaction actions from all modules are concatenated; when one
     * is returned, compaction runs and this boundary is evaluated again before inference starts.
     */
    readonly prepareInference?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        preparation: AgentBaseInferencePreparation,
    ) => MaybePromise<readonly AgentModuleInferencePreparationAction[] | undefined>;
    /** Transactional counterpart to `beforeInference`. */
    readonly beforeInferenceTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        inference: AgentBaseInferenceStart,
    ) => MaybePromise<void>;
    /** Called immediately before each inference request. */
    readonly beforeInference?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        inference: AgentBaseInferenceStart,
    ) => MaybePromise<void>;
    /** Transactional counterpart to `afterInference`. */
    readonly afterInferenceTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        inference: AgentBaseInference,
    ) => MaybePromise<void>;
    /** Receives how the response ended and the token counts the provider measured for it. */
    readonly afterInference?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        inference: AgentBaseInference,
    ) => MaybePromise<void>;
    /** Transactional counterpart to `afterTurn`. */
    readonly afterTurnTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        turn: AgentBaseTurn,
    ) => MaybePromise<void>;
    /**
     * Receives the token counts the turn's last measured response reported. Actions from every
     * module are concatenated and applied together.
     */
    readonly afterTurn?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        turn: AgentBaseTurn,
    ) => MaybePromise<readonly AgentModuleAction[] | undefined>;
    /** Transactional counterpart to `afterAgentLoop`. */
    readonly afterAgentLoopTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        loop: AgentBaseLoop,
    ) => MaybePromise<void>;
    /** Actions from every module are concatenated and applied together. */
    readonly afterAgentLoop?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        loop: AgentBaseLoop,
    ) => MaybePromise<readonly AgentModuleAction[] | undefined>;
    /**
     * Called inside the transaction that records the agent as settled. The module's stores write
     * into that transaction, so what a module concludes about the run and the fact that the run
     * is over become durable together. The `Transact` suffix is what marks a hook as running
     * inside a transaction. The run store is erased by that same transaction, so this is the last
     * chance to keep any part of what the run wrote about itself.
     *
     * Unlike the observing hooks, a failure here is not contained: it rolls the settlement back
     * along with everything every module wrote, and the agent stays recorded as working.
     */
    readonly afterAgentSettledTransact?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        settlement: AgentBaseSettlement,
    ) => MaybePromise<void>;
    /** Called once after the loop has fully settled and no module reopened it. */
    readonly afterAgentSettled?: (
        ctx: Context,
        scope: AgentModuleScope<Database>,
        settlement: AgentBaseSettlement,
    ) => MaybePromise<void>;
}
