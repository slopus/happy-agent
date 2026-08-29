import type { SessionReasoningEffort, SessionServiceTier } from "@slopus/happy-providers";
import { createContextNamespace, registerContextExtension, type Context } from "@steve.kite/stdlib";

import type { AgentDatabase } from "./AgentDatabase.js";
import type { AgentKV } from "./AgentKV.js";
import { DEFAULT_AGENT_PERMISSION_MODE, type AgentPermissionMode } from "./AgentPermissionMode.js";

/** Backing storage for `agentId`: the ID of the agent owning a context. */
const idNamespace = createContextNamespace<string | undefined>("agentId", undefined);
/** Backing storage for `agentModel`: the model configured for the agent, when one was set. */
const modelNamespace = createContextNamespace<string | undefined>("agentModel", undefined);
/** Backing storage for `agentEffort`: the reasoning effort configured, when one was set. */
const effortNamespace = createContextNamespace<SessionReasoningEffort | undefined>(
    "agentEffort",
    undefined,
);
/** Backing storage for `agentProvider`: the registry ID of the provider owning a context. */
const providerNamespace = createContextNamespace<string | undefined>("agentProvider", undefined);
/** Backing storage for `agentServiceTier`: the service tier configured, when one was set. */
const serviceTierNamespace = createContextNamespace<SessionServiceTier | undefined>(
    "agentServiceTier",
    undefined,
);
/**
 * Backing storage for `agentPermissionMode`: how much the work on a context may touch.
 *
 * Not detachable. A mode wider than the agent's own is lent to one reviewed action and to nothing
 * else, so work that detaches to a lifetime of its own starts again from the product default
 * rather than inheriting an elevation it was never reviewed for.
 */
const permissionModeNamespace = createContextNamespace<AgentPermissionMode>(
    "agentPermissionMode",
    DEFAULT_AGENT_PERMISSION_MODE,
    { detachable: false },
);
/**
 * Backing storage for `agentKV`: the scoped key-value store carried on a context. Not detachable,
 * because which store this is depends on the call: inside a tool it is that call's own, and that
 * handle stops accepting writes once the call commits. An agent that detaches to a lifetime of its
 * own is handed no store and installs its own, rather than keeping one that is about to expire.
 */
const kvNamespace = createContextNamespace<AgentKV | undefined>("agentKV", undefined, {
    detachable: false,
});
/**
 * Backing storage for `agentRunKV`: the run's own store, erased when the agent settles. Not
 * detachable, because what it holds lives exactly as long as the run that wrote it.
 */
const runKVNamespace = createContextNamespace<AgentKV | undefined>("agentRunKV", undefined, {
    detachable: false,
});
/**
 * Backing storage for `agentHistoryKV`: state belonging to the current history epoch. Not
 * detachable, because the handle expires when compaction or a model change replaces history.
 */
const historyKVNamespace = createContextNamespace<AgentKV | undefined>(
    "agentHistoryKV",
    undefined,
    { detachable: false },
);
/** Storage-owned identity and lifetime of an active transaction facade. */
export interface AgentStorageTransactionContext {
    readonly database: AgentDatabase;
    readonly root: AgentDatabase;
    readonly lifetime: AbortSignal;
}

interface AgentDatabaseContextState {
    readonly databaseNamespace: ReturnType<
        typeof createContextNamespace<AgentDatabase | undefined>
    >;
    readonly storageTransactionNamespace: ReturnType<
        typeof createContextNamespace<AgentStorageTransactionContext | undefined>
    >;
}

declare global {
    namespace stdlib {
        interface ContextExtensions {
            readonly db: AgentDatabase;
        }
    }
}

// Development loaders and Vitest can evaluate this module again while stdlib's extension registry
// remains shared. Reuse the namespaces as well as the registration because the getter closes over
// them and reloaded callers must keep writing to the same context slots.
const databaseContextRegistryKey = Symbol.for(
    "@slopus/happy-agent-base/database-context-registry/v1",
);
const existingDatabaseContextRegistry = Reflect.get(globalThis, databaseContextRegistryKey) as
    | WeakMap<object, AgentDatabaseContextState>
    | undefined;
const databaseContextRegistry = existingDatabaseContextRegistry ?? new WeakMap();
if (existingDatabaseContextRegistry === undefined) {
    Reflect.set(globalThis, databaseContextRegistryKey, databaseContextRegistry);
}

const stdlibRegistryIdentity = registerContextExtension as object;
let databaseContextState = databaseContextRegistry.get(stdlibRegistryIdentity);
if (databaseContextState === undefined) {
    // Neither of these is detachable. The transaction is the caller's in-flight write, and the
    // database is whatever facade that transaction installed, so work that detaches to a lifetime
    // of its own is handed no storage at all and has to be given the real one deliberately. That
    // is what keeps a run outliving its caller from writing through a facade that has committed.
    const databaseNamespace = createContextNamespace<AgentDatabase | undefined>(
        "agentDatabase",
        undefined,
        { detachable: false },
    );
    const storageTransactionNamespace = createContextNamespace<
        AgentStorageTransactionContext | undefined
    >("agentStorageTransaction", undefined, { detachable: false });
    registerContextExtension("db", (ctx) => {
        const transaction = storageTransactionNamespace.get(ctx);
        if (transaction?.lifetime.aborted === true) {
            throw new Error("The agent storage transaction carried by this context has ended.");
        }
        const database = databaseNamespace.get(ctx);
        if (database === undefined) throw new Error("Context has no agent database.");
        return database;
    });
    databaseContextState = { databaseNamespace, storageTransactionNamespace };
    databaseContextRegistry.set(stdlibRegistryIdentity, databaseContextState);
}
const { databaseNamespace, storageTransactionNamespace } = databaseContextState;

/**
 * Derive the agent's context carrying its ID, provider ID, model, effort, service tier, and
 * permission mode — all serializable values. The agent applies this once at construction, so hooks
 * and tool executions can read the values back through the accessors below. The ID is what lets one
 * module instance serve every agent in a collection: a shared module learns which agent a hook is
 * running for from the context rather than from something it was constructed with.
 */
export function withAgentContext(
    ctx: Context,
    values: {
        readonly id: string;
        readonly provider: string;
        readonly model?: string | undefined;
        readonly effort?: SessionReasoningEffort | undefined;
        readonly serviceTier?: SessionServiceTier | undefined;
        readonly permissionMode: AgentPermissionMode;
    },
): Context {
    const withId = idNamespace.set(ctx, values.id);
    const withProvider = providerNamespace.set(withId, values.provider);
    const withModel = modelNamespace.set(withProvider, values.model);
    const withEffort = effortNamespace.set(withModel, values.effort);
    const withTier = serviceTierNamespace.set(withEffort, values.serviceTier);
    return permissionModeNamespace.set(withTier, values.permissionMode);
}

/** The ID of the agent owning this context. */
export function agentId(ctx: Context): string | undefined {
    return idNamespace.get(ctx);
}

/** The model configured for the agent owning this context, when one was set. */
export function agentModel(ctx: Context): string | undefined {
    return modelNamespace.get(ctx);
}

/** The reasoning effort configured for the agent owning this context, when one was set. */
export function agentEffort(ctx: Context): SessionReasoningEffort | undefined {
    return effortNamespace.get(ctx);
}

/** The registry ID of the provider of the agent owning this context. */
export function agentProvider(ctx: Context): string | undefined {
    return providerNamespace.get(ctx);
}

/** The service tier configured for the agent owning this context, when one was set. */
export function agentServiceTier(ctx: Context): SessionServiceTier | undefined {
    return serviceTierNamespace.get(ctx);
}

/**
 * How much the work on this context may touch. It is the mode the agent is running in, unless a
 * narrower scope replaced it for one execution.
 */
export function agentPermissionMode(ctx: Context): AgentPermissionMode {
    return permissionModeNamespace.get(ctx);
}

/**
 * Run one stretch of work under another mode. This is how an allowed Auto action is lent the access
 * it was reviewed for: the work derived from this context sees the wider mode, and everything
 * outside it goes on seeing the agent's own. Deriving from a context the agent handed out is what
 * keeps the rest of that context — the agent's identity, its stores, its lifetime — intact.
 */
export function withAgentPermissionMode(ctx: Context, mode: AgentPermissionMode): Context {
    return permissionModeNamespace.set(ctx, mode);
}

/** Carry a scoped key-value store on the context, replacing any store carried before. */
export function withAgentKV(ctx: Context, kv: AgentKV): Context {
    return kvNamespace.set(ctx, kv);
}

/** The scoped key-value store carried on this context, when the agent attached one. */
export function agentKV(ctx: Context): AgentKV | undefined {
    return kvNamespace.get(ctx);
}

/**
 * Carry the store belonging to the run in progress, replacing any run store carried before. What
 * it holds lives exactly as long as the work does: the agent erases the whole scope in the
 * transaction that settles it, so nothing written here outlives the run that wrote it.
 */
export function withAgentRunKV(ctx: Context, kv: AgentKV): Context {
    return runKVNamespace.set(ctx, kv);
}

/** The run's own store carried on this context, when the agent attached one. */
export function agentRunKV(ctx: Context): AgentKV | undefined {
    return runKVNamespace.get(ctx);
}

/**
 * Carry the store belonging to the current conversation history. Agent Base clears it and
 * invalidates its old handle when compaction or a model/profile reset replaces history.
 */
export function withAgentHistoryKV(ctx: Context, kv: AgentKV): Context {
    return historyKVNamespace.set(ctx, kv);
}

/** State scoped to the current conversation history, when the agent attached that store. */
export function agentHistoryKV(ctx: Context): AgentKV | undefined {
    return historyKVNamespace.get(ctx);
}

/** Carry the active Drizzle database or transaction facade on a derived context. */
export function withAgentDatabase(ctx: Context, database: AgentDatabase): Context {
    const transaction = storageTransactionNamespace.get(ctx);
    if (
        transaction !== undefined &&
        (database === transaction.database || database === transaction.root)
    ) {
        return ctx;
    }
    return databaseNamespace.set(storageTransactionNamespace.set(ctx, undefined), database);
}

/** The active Drizzle database or transaction facade, when this work has durable storage. */
export function agentDatabase(ctx: Context): AgentDatabase | undefined {
    return databaseNamespace.get(ctx);
}

/** Install the active facade for the duration of one transaction callback. */
export function withAgentStorageTransaction(
    ctx: Context,
    transaction: AgentStorageTransactionContext,
): Context {
    if (databaseNamespace.get(ctx) !== transaction.root) {
        throw new Error("A transaction context cannot be used with another agent storage.");
    }
    return storageTransactionNamespace.set(
        databaseNamespace.set(ctx, transaction.database),
        transaction,
    );
}

/** The storage transaction carried by this context, including its ended state when retained. */
export function agentStorageTransaction(ctx: Context): AgentStorageTransactionContext | undefined {
    return storageTransactionNamespace.get(ctx);
}
