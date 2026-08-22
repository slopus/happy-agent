import { createId } from "@paralleldrive/cuid2";
import type { SessionMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    afterCommit,
    asyncLock,
    shutdown,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import { Agent } from "./Agent.js";
import { type AgentBaseMessageOptions, type AgentBaseQueueMode } from "./AgentBase.js";
import {
    agentDatabase,
    agentId as agentIdOf,
    agentStorageTransaction,
    withAgentDatabase,
    withAgentKV,
    type AgentStorageTransactionContext,
} from "./AgentContexts.js";
import type { AgentDatabase } from "./AgentDatabase.js";
import { outsideAgentDatabaseOperation } from "./AgentDatabaseConnection.js";
import type { AgentKV } from "./AgentKV.js";
import type { AgentPersistence } from "./AgentPersistence.js";
import {
    agentConfigSchema,
    ownAgentConfig,
    withAgentConfig,
    type AgentConfig,
} from "./AgentConfig.js";
import type {
    AgentModule,
    AgentModuleAgentLifecycle,
    AgentModuleHooks,
    AgentModuleRuntime,
    AgentModuleSystemScope,
} from "./AgentModule.js";
import { cuid2Schema, ownAgentMetadata, type AgentMetadata } from "./AgentMetadata.js";
import type { AgentMessageAcceptance } from "./AgentMessageAcceptance.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";
import type { AgentStorage, AgentStorageLock } from "./AgentStorage.js";
import type { AgentCreateOptions, AgentSystem, AgentSystemDrainProgress } from "./AgentSystem.js";
import { withAgentSystem } from "./AgentSystemContext.js";
import { AgentSystemRef } from "./AgentSystemRef.js";
import type { AnyAgentTool } from "./AgentTool.js";

const storedParentSchema = Type.String();

type AgentLifecycleHook<Database extends AgentDatabase> = (
    ctx: Context,
    scope: AgentModuleSystemScope<Database>,
    agent: AgentModuleAgentLifecycle,
) => void | Promise<void>;

interface TransactionAgentEntry<Database extends AgentDatabase> {
    readonly agent: Agent<AnyAgentTool, Database>;
    start: boolean;
}

/** Everything `AgentSystemLocal` needs to build and run the agents in its collection. */
export interface AgentSystemLocalOptions<Database extends AgentDatabase = AgentDatabase> {
    /**
     * The modules every agent in this collection runs with, given as instances the caller has
     * already built and ready to serve. One instance serves the whole collection: a hook is told
     * which agent it is running for by the scope it is handed, so any per-agent state a module
     * keeps in memory has to be keyed by that ID rather than held as a single value.
     */
    readonly modules?: readonly AgentModule<AnyAgentTool, Database>[];
    /** The registry providers are resolved from when an agent is built. */
    readonly providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly provider: string;
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];
    /** How every agent drains steering accepted before its next response. */
    readonly steeringMode?: AgentBaseQueueMode;
    /** How every agent drains sent follow-ups accepted before its next response. */
    readonly sendMode?: AgentBaseQueueMode;
    /** Stable name this collection reports to a stdlib graceful-shutdown coordinator. */
    readonly shutdownName?: string;
}

/**
 * The `AgentSystem` backed by this process: it lazily builds and owns the `Agent` instances for
 * the identities its storage holds. Concurrent resolutions of the same ID share one load, while a
 * failed load is forgotten so a later resolution can retry.
 *
 * Work serializes per agent rather than per collection: a collection-wide lock would make one
 * agent's module load block every other agent, including one that load itself resolves.
 *
 * This is the owner's handle, and some of what it offers waits for an agent to reach a point only
 * that agent's run loop can bring it to. Hand an `AgentSystemRef` to anything running inside an
 * agent instead.
 */
export class AgentSystemLocal<
    Database extends AgentDatabase = AgentDatabase,
> implements AgentSystem<Database> {
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];
    /**
     * The lifetime context retained by this system, its storage lock, and every agent it builds.
     * It is the root the collection was created with, so an agent's work is traced and logged as
     * the collection's rather than as whatever call happened to bring that agent into existence.
     */
    readonly #ctx: Context;

    /**
     * What this collection looks like from inside one of its agents, and the only form of it a
     * derived context ever carries.
     */
    readonly #ref: AgentSystemRef<Database> = new AgentSystemRef(this, null);
    /** The collection's module instances, every one of them serving every agent it builds. */
    readonly #modules: readonly AgentModule<AnyAgentTool, Database>[];
    /** Every module beside the hooks its beforeStart returned, resolved once at start. */
    #runtimes: readonly AgentModuleRuntime<AnyAgentTool, Database>[] = [];
    /** Where the collection's identities, configuration, and per-agent state are durable. */
    readonly #storage: AgentStorage<Database>;
    /** The registry providers are resolved from when an agent is built. */
    readonly #providers: AgentProviders;
    /** The registry ID of the provider new agents are created with. */
    readonly #provider: string;
    /** How every agent drains its steering queue. */
    readonly #steeringMode: AgentBaseQueueMode;
    /** How every agent drains its sent-message queue. */
    readonly #sendMode: AgentBaseQueueMode;
    /** Exclusive database-backed ownership of this collection's whole durable store. */
    readonly #storageLock: AgentStorageLock;
    /** The identity index and creation-time config fallback; current config lives with the agent. */
    readonly #configs: AgentKV;
    /** The durable parent of each non-root identity, keyed by child identity. */
    readonly #parents: AgentKV;
    /**
     * The root of the store modules share across the collection. Each module works under its
     * own scope of it, which is where anything outliving one agent's conversation belongs.
     */
    readonly #sharedModuleKV: AgentKV;
    /** The live `Agent` instances this process has built, keyed by identity. */
    readonly #agents = new Map<string, Agent<AnyAgentTool, Database>>();
    /** Unpublished agents built once per transaction and made live only after commit. */
    readonly #transactionAgents = new WeakMap<
        AgentStorageTransactionContext,
        Map<string, TransactionAgentEntry<Database> | null>
    >();
    // One agent has one store for the life of the collection, so inspecting an agent's durable
    // work and running that agent never end up looking at two different stores.
    readonly #persistences = new Map<string, AgentPersistence>();
    /** Per-agent locks handed out by `#lockFor`, created lazily the first time an ID is touched. */
    readonly #locks = new Map<string, AsyncLock>();
    /** Public operations admitted before shutdown and therefore allowed to finish. */
    readonly #admitted = new Set<Promise<void>>();
    /** Post-commit lifecycle observations still running outside per-agent locks. */
    readonly #lifecycleObservations = new Set<Promise<void>>();
    /** Post-commit closes and replacement resets that must finish before an ID is reused. */
    readonly #transitions = new Map<string, Promise<void>>();
    /** Agents still moving toward a requested safe drain edge. */
    readonly #drainingAgents = new Map<Agent<AnyAgentTool, Database>, Promise<void>>();
    /** Sticky for this system lifetime: a drained collection never starts another loop. */
    #draining = false;
    /** The shared completion barrier for the sticky drain. */
    #drainPromise: Promise<void> | undefined;
    /** No agent operation is admitted until every module has finished its beforeStart hook. */
    #lifecycle: "initializing" | "open" | "closing" | "closed" = "initializing";
    /** The shared shutdown, including release of the hard storage lock. */
    #closePromise: Promise<void> | undefined;
    /** Removes this collection from stdlib shutdown after its storage lock is released. */
    #unregisterShutdown: (() => void) | undefined;

    /**
     * Bring up a collection over one storage and carry on where the last process left off.
     *
     * A collection is not a passive registry that happens to be asked for agents later: whatever
     * was running when the previous process ended is still owed an answer, and this is what
     * makes it happen. Every identity the storage holds is examined, and each one that owes work
     * is resolved and resumed, so by the time this returns the collection is not merely built
     * but running.
     */
    static async create<Database extends AgentDatabase>(
        ctx: Context,
        storage: AgentStorage<Database>,
        config: AgentSystemLocalOptions<Database>,
    ): Promise<AgentSystemLocal<Database>> {
        // The context the collection is created with is the root every agent in it hangs off:
        // it is retained as the collection's own, and each agent is built on it rather than on
        // whatever call happened to ask for it. Bringing the collection up is bounded work of
        // the caller's, so it gets a span of its own and the agents get none of it.
        const systemCtx = withAgentDatabase(ctx, storage.database);
        return await systemCtx.span("agent.system.start", async (startCtx) => {
            const storageLock = await storage.acquireLock(startCtx);
            const system = new AgentSystemLocal(systemCtx, storage, storageLock, config);
            try {
                await storage.migrate(startCtx, system.#modules);
                await system.#beforeStart(startCtx);
                // beforeStart is the initialization barrier. Restoration observers receive the
                // system ref next and must be able to reconcile other durable agents through it,
                // even though restored run loops do not start until every observation finishes.
                system.#lifecycle = "open";
                const active = await system.#start(startCtx);
                for (const agent of active) agent.start();
                await system.#afterStart(startCtx);
                system.#registerShutdown(config.shutdownName ?? "agent-system");
                if (shutdown.get(systemCtx)?.shuttingDown === true) {
                    await system.close(systemCtx);
                }
                return system;
            } catch (error: unknown) {
                await system.close(systemCtx).catch(() => undefined);
                throw error;
            }
        });
    }

    /**
     * Wire this collection to its storage, providers, and module configuration, without reading
     * any of it. Private: a collection is brought up by `create`, which also resumes the work
     * the storage was left holding — building one without that is building half of it.
     */
    private constructor(
        ctx: Context,
        storage: AgentStorage<Database>,
        storageLock: AgentStorageLock,
        options: AgentSystemLocalOptions<Database>,
    ) {
        this.#ctx = ctx;
        this.#modules = options.modules ?? [];
        this.#storage = storage;
        this.#storageLock = storageLock;
        this.#providers = options.providers;
        this.#provider = options.provider;
        this.#steeringMode = options.steeringMode ?? "one-at-a-time";
        this.#sendMode = options.sendMode ?? "one-at-a-time";
        this.models = [...options.models];
        this.#configs = storage.kv.scoped("config");
        this.#parents = storage.kv.scoped("parent");
        this.#sharedModuleKV = storage.kv.scoped("modules");
    }

    /**
     * Stop every live agent, wait for operations already admitted by this owner, and only then
     * release the database lock. Repeated callers join the same shutdown.
     */
    async close(ctx: Context): Promise<void> {
        if (agentStorageTransaction(ctx) !== undefined) {
            afterCommit(ctx, () => {
                outsideAgentDatabaseOperation(() => {
                    void this.close(this.#ctx).catch((error: unknown) => {
                        this.#ctx.log.warn("The committed agent system close failed.", error);
                    });
                });
            });
            return;
        }
        if (this.#closePromise === undefined) {
            this.#lifecycle = "closing";
            this.#closePromise = this.#shutdown();
        }
        const closing = this.#closePromise;
        const caller = agentIdOf(ctx);
        if (caller !== undefined && this.#agents.has(caller)) {
            void closing.catch(() => undefined);
            throw new Error(
                "Closing the agent system from inside one of its own agents would wait for " +
                    "that agent's turn. Shutdown will finish and release the store after this " +
                    "caller returns.",
            );
        }
        await closing;
    }

    /**
     * Ask every live agent to stop at its next durable edge without cancelling current work.
     * The mode is sticky: agents published by an operation already in flight are drained before
     * they can start, and repeated callers join the same barrier.
     */
    drain(): Promise<void> {
        if (this.#drainPromise === undefined) {
            this.#draining = true;
            for (const agent of this.#agents.values()) this.#beginAgentDrain(agent);
            this.#drainPromise = this.#finishDrain();
        }
        return this.#drainPromise;
    }

    /** A bounded, ID-sorted view of agents that have not reached their drain edge yet. */
    drainProgress(limit = 100): AgentSystemDrainProgress {
        const waitingAgents = this.#drainingAgents.size;
        const boundedLimit = Math.max(0, Math.floor(limit));
        const agents = [...this.#drainingAgents.keys()]
            .map((agent) => ({
                id: agent.id,
                stage: agent.drainStage ?? ("inference" as const),
            }))
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(0, boundedLimit);
        return {
            agents,
            count: waitingAgents,
            ...(waitingAgents > agents.length ? { truncated: true as const } : {}),
        };
    }

    /** Wait for every agent that was already running to reach its durable edge. */
    async #finishDrain(): Promise<void> {
        while (this.#drainingAgents.size > 0) {
            await Promise.allSettled(this.#drainingAgents.values());
        }
    }

    /** Put one live agent into the collection's sticky drain exactly once. */
    #beginAgentDrain(agent: Agent<AnyAgentTool, Database>): void {
        if (this.#drainingAgents.has(agent)) return;
        const draining = agent.drain();
        this.#drainingAgents.set(agent, draining);
        void draining.then(
            () => this.#drainingAgents.delete(agent),
            () => this.#drainingAgents.delete(agent),
        );
    }

    /** Make this collection one named stdlib shutdown barrier when its context carries one. */
    #registerShutdown(name: string): void {
        this.#unregisterShutdown = shutdown
            .get(this.#ctx)
            ?.register(name, async (shutdownCtx) => await this.close(shutdownCtx));
    }

    /** The real shutdown barrier, which keeps the hard store lock until every agent is closed. */
    async #shutdown(): Promise<void> {
        try {
            while (this.#admitted.size > 0 || this.#transitions.size > 0) {
                await Promise.allSettled([...this.#admitted, ...this.#transitions.values()]);
            }
            const closed = [...this.#agents.values()].map((agent) => {
                void agent.close().catch(() => undefined);
                return agent.waitForClosed();
            });
            await Promise.allSettled(closed);
            this.#agents.clear();
            this.#persistences.clear();
            this.#locks.clear();
        } finally {
            try {
                await this.#storageLock.release(this.#ctx);
            } finally {
                this.#lifecycle = "closed";
                this.#unregisterShutdown?.();
                this.#unregisterShutdown = undefined;
            }
        }
    }

    /**
     * Admit one public operation while this system still owns the store. Shutdown rejects new
     * admissions and waits for every earlier one before releasing the hard lock.
     */
    #admit<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this.#lifecycle !== "open") {
            return Promise.reject(
                new Error(
                    this.#lifecycle === "initializing"
                        ? "The agent system is not ready."
                        : "The agent system is closed.",
                ),
            );
        }
        let running: Promise<Result>;
        try {
            // Begin synchronously so ownership-transfer boundaries such as create(config) copy
            // caller-owned input before the caller can mutate it after receiving the promise.
            running = operation();
        } catch (error: unknown) {
            return Promise.reject(error);
        }
        const settled = running.then(
            () => undefined,
            () => undefined,
        );
        this.#admitted.add(settled);
        void settled.finally(() => this.#admitted.delete(settled));
        return running;
    }

    /**
     * Create and resolve an agent. Its identity is either a validated caller-supplied cuid2 or
     * allocated here, and the transaction refuses an existing identity rather than overwriting
     * it. Configuration and parentage are persisted before the agent runs, so every later process
     * resolves the same agent; only its metadata may subsequently change.
     *
     * Nothing here is undone: an agent whose modules refuse to load leaves an identity that
     * exists, is resolvable, and will be built the next time something wants it. Taking a
     * provisional identity back after a failed build would add a compensation that can itself
     * fail.
     */
    async create(
        ctx: Context,
        config: AgentConfig,
        options?: AgentCreateOptions,
    ): Promise<Agent<AnyAgentTool, Database>> {
        return await this.#admit(async () => {
            const agentId = options?.id ?? createId();
            if (!Value.Check(cuid2Schema, agentId)) {
                throw new Error("The agent ID must be a cuid2 identity.");
            }
            // Preserve synchronous ownership of caller-supplied config in the ordinary case.
            // Awaiting an already-settled async helper would give the caller a microtask in which
            // it could mutate the object before we copy it below.
            if (this.#transitions.has(agentId)) {
                await this.#waitForTransition(ctx, agentId);
            }
            this.#assertNotDeletedInTransaction(ctx, agentId);
            if (!Value.Check(agentConfigSchema, config)) {
                throw new Error(`The configuration for agent "${agentId}" is not valid.`);
            }
            const parent =
                options?.parent === undefined ? (agentIdOf(ctx) ?? null) : options.parent;
            // Who made this agent is read from the call that made it: creation reached here from
            // inside some agent's work — a tool of its own, most often — and that agent is the
            // creator. A call carrying no agent came from a person or the daemon itself, which is
            // recorded as no creator rather than guessed at.
            const creator = agentIdOf(ctx);
            const provenance = {
                createdAt: Date.now(),
                ...(creator === undefined ? {} : { createdBy: creator }),
            };
            // The caller keeps its own object, and may go on editing it. What was created is what
            // was passed at this moment, so storage and this agent's context both get a copy.
            // Provenance is the system's to state, so a caller cannot claim a different one.
            const owned = ownAgentConfig({ ...config, provenance });
            const lifecycle = lifecycleAgent(agentId, owned);
            const create = async (lockCtx: Context): Promise<Agent<AnyAgentTool, Database>> => {
                if ((await this.#configs.read(lockCtx, agentId)) !== undefined) {
                    throw new Error(`Agent "${agentId}" already exists.`);
                }
                if (parent !== null && (await this.#configs.read(lockCtx, parent)) === undefined) {
                    throw new Error(`Agent "${parent}" has not been created.`);
                }
                await this.#preparePersistence(
                    lockCtx,
                    agentId,
                    owned,
                    options?.initialContext?.messages ?? [],
                );
                await this.#configs.transaction(lockCtx, async (_configs, txCtx) => {
                    if ((await this.#configs.read(txCtx, agentId)) !== undefined) {
                        throw new Error(`Agent "${agentId}" already exists.`);
                    }
                    if (
                        parent !== null &&
                        (await this.#configs.read(txCtx, parent)) === undefined
                    ) {
                        throw new Error(`Agent "${parent}" has not been created.`);
                    }
                    await this.#configs.write(txCtx, agentId, owned);
                    if (parent !== null) await this.#parents.write(txCtx, agentId, parent);
                    await this.#recordLifecycle(
                        txCtx,
                        lifecycle,
                        (hooks) => hooks.agentCreatedTransact,
                        (hooks) => hooks.agentCreated,
                    );
                });
                const agent =
                    agentStorageTransaction(lockCtx) === undefined
                        ? await this.#instantiate(agentId, owned)
                        : await this.#transactionAgent(lockCtx, agentId, owned, true, true);
                if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
                return agent;
            };
            // A carried transaction already serializes the database and must not wait for an
            // identity lock whose current owner may itself be queued behind that transaction.
            if (agentStorageTransaction(ctx) !== undefined) return await create(ctx);
            return await this.#lockFor(agentId).runInLock(ctx, create);
        });
    }

    /**
     * Close an agent and release its identity, so the same ID can be created again. Used to undo
     * a creation whose follow-up work failed; an ID that was never created is left alone.
     *
     * What the agent wrote is left where it is. The close finishes first, so the store holds a
     * whole conversation rather than a truncated one, and that record is worth more here than the
     * space it takes: whoever deleted the agent may still want to know what it did. The next
     * identity created under this ID starts from an empty store all the same, because creation is
     * what clears it.
     */
    async delete(ctx: Context, agentId: string): Promise<void> {
        await this.#admit(async () => {
            await this.#waitForTransition(ctx, agentId);
            const remove = async (lockCtx: Context): Promise<void> => {
                const config = await this.#config(lockCtx, agentId);
                const transaction = agentStorageTransaction(lockCtx);
                let provisional: Map<string, TransactionAgentEntry<Database> | null> | undefined;
                if (transaction !== undefined) {
                    provisional = this.#transactionAgents.get(transaction);
                    if (provisional === undefined) {
                        provisional = new Map();
                        this.#transactionAgents.set(transaction, provisional);
                    }
                }
                const staged = provisional?.get(agentId);
                const agent =
                    (staged === null || staged === undefined ? undefined : staged.agent) ??
                    this.#agents.get(agentId);
                if (transaction === undefined) {
                    this.#agents.delete(agentId);
                    await agent?.close();
                }
                await this.#configs.transaction(lockCtx, async (_configs, txCtx) => {
                    await this.#configs.delete(txCtx, agentId);
                    await this.#parents.delete(txCtx, agentId);
                    const children = await this.#parents.list(txCtx);
                    for (const child of children) {
                        if (child.value === agentId) await this.#parents.delete(txCtx, child.key);
                    }
                    if (config !== undefined) {
                        await this.#recordLifecycle(
                            txCtx,
                            lifecycleAgent(agentId, config),
                            (hooks) => hooks.agentArchivedTransact,
                            (hooks) => hooks.agentArchived,
                        );
                    }
                });
                provisional?.set(agentId, null);
                if (transaction === undefined) {
                    this.#persistences.delete(agentId);
                } else {
                    afterCommit(lockCtx, () => {
                        outsideAgentDatabaseOperation(() => {
                            if (this.#agents.get(agentId) === agent) this.#agents.delete(agentId);
                            this.#beginTransition(agentId, async () => {
                                await agent?.close();
                                this.#persistences.delete(agentId);
                            });
                        });
                    });
                }
            };
            if (agentStorageTransaction(ctx) !== undefined) {
                await remove(ctx);
            } else {
                await this.#lockFor(agentId).runInLock(ctx, remove);
            }
        });
    }

    /**
     * Atomically clear an earlier incarnation's isolated store and install the new configuration
     * and projected conversation before publishing the identity in the collection index.
     */
    async #preparePersistence(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
        messages: readonly SessionMessage[],
    ): Promise<void> {
        const persistence = this.#persistenceFor(agentId);
        await persistence.transaction(ctx, async (txCtx) => {
            await persistence.clearRecords(txCtx);
            for (const { key } of await persistence.readValues(txCtx, "")) {
                await persistence.deleteValue(txCtx, key);
            }
            await persistence.writeValue(txCtx, "agentConfig", config);
            if (messages.length > 0) {
                await persistence.append(txCtx, {
                    type: "compaction",
                    messages: structuredClone(messages),
                });
            }
        });
    }

    /** The current configuration of an agent, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return await this.#admit(async () => await this.#config(ctx, agentId));
    }

    /** Read one stored configuration while its owning operation is already admitted. */
    async #config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        await this.#waitForTransition(ctx, agentId);
        const indexed = await this.#configs.read(ctx, agentId);
        if (indexed === undefined) return undefined;
        const local = await this.#persistenceFor(agentId).readValues(ctx, "agentConfig");
        const stored = local.find(({ key }) => key === "agentConfig")?.value ?? indexed;
        if (!Value.Check(agentConfigSchema, stored)) {
            throw new Error(`The stored configuration of agent "${agentId}" is not valid.`);
        }
        return ownAgentConfig(stored);
    }

    /** Shallow-merge fields into one agent's immutable metadata. */
    async updateMetadata(ctx: Context, agentId: string, update: AgentMetadata): Promise<void> {
        await this.#admit(async () => {
            const agent = await this.#resolve(ctx, agentId);
            await agent.updateMetadata(ctx, update);
        });
    }

    /** The direct children of an existing agent, in durable key order. */
    async childOf(ctx: Context, agentId: string): Promise<readonly string[]> {
        return await this.#admit(async () => {
            await this.#requireAgent(ctx, agentId);
            return (await this.#parents.list(ctx)).flatMap(({ key, value }) =>
                value === agentId ? [key] : [],
            );
        });
    }

    /** The parent of an existing agent, or `null` when it is a root. */
    async parentOf(ctx: Context, agentId: string): Promise<string | null> {
        return await this.#admit(async () => {
            await this.#requireAgent(ctx, agentId);
            const parent = await this.#parents.read(ctx, agentId);
            if (parent === undefined) return null;
            if (!Value.Check(storedParentSchema, parent)) {
                throw new Error(`The stored parent of agent "${agentId}" is not valid.`);
            }
            return parent;
        });
    }

    /** Refuse relationship queries for an identity that has never been created. */
    async #requireAgent(ctx: Context, agentId: string): Promise<void> {
        if ((await this.#config(ctx, agentId)) === undefined) {
            throw new Error(`Agent "${agentId}" has not been created.`);
        }
    }

    /**
     * The live agent for an ID, loading and starting it if this process has not seen it yet.
     * Concurrent resolutions of the same ID share one load.
     */
    async resolve(ctx: Context, agentId: string): Promise<Agent<AnyAgentTool, Database>> {
        return await this.#admit(async () => await this.#resolve(ctx, agentId));
    }

    /** Resolve one agent while its owning public operation is already admitted. */
    async #resolve(ctx: Context, agentId: string): Promise<Agent<AnyAgentTool, Database>> {
        await this.#waitForTransition(ctx, agentId);
        if (agentStorageTransaction(ctx) !== undefined) {
            const config = await this.#config(ctx, agentId);
            if (config === undefined) {
                throw new Error(`Agent "${agentId}" has not been created.`);
            }
            return await this.#transactionAgent(ctx, agentId, config, true);
        }
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;

        return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
            const resolved = this.#agents.get(agentId);
            if (resolved !== undefined) return resolved;

            const config = await this.#config(lockCtx, agentId);
            if (config === undefined) {
                throw new Error(`Agent "${agentId}" has not been created.`);
            }
            const published = this.#agents.get(agentId);
            if (published !== undefined) return published;
            const agent = await this.#instantiate(agentId, config, false, false, undefined, false);
            if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
            const concurrent = this.#agents.get(agentId);
            if (concurrent !== undefined) return concurrent;
            this.#publish(agent, true);
            return agent;
        });
    }

    /**
     * Build one agent and put it to work. Called with the agent's lock held, and only for an ID
     * that has no live instance yet.
     */
    async #instantiate(
        agentId: string,
        config: AgentConfig,
        onlyIfActive = false,
        start = true,
        loadCtx?: Context,
        publish = true,
        fresh = false,
    ): Promise<Agent<AnyAgentTool, Database> | undefined> {
        // An agent outlives whatever asked for it — a restart bringing the collection up, an HTTP
        // request, another agent's tool — so it takes no context from its caller at all and is
        // built on the collection's own. A run loop still running long after the call that started
        // it returned belongs to the collection's lifetime, and traces as the collection's.
        const agentCtx = withAgentDatabase(
            withAgentConfig(withAgentSystem(this.#ctx, new AgentSystemRef(this, agentId)), config),
            this.#storage.database,
        );
        const options = {
            id: agentId,
            providers: this.#providers,
            provider: this.#provider,
            persistence: this.#persistenceFor(agentId),
            sendMode: this.#sendMode,
            sharedKV: this.#sharedModuleKV,
            steeringMode: this.#steeringMode,
            // The collection's modules come first, so the instructions they contribute — the
            // system prompt above all — open every agent's prompt.
            modules: this.#runtimes,
        };
        // An identity built here may already have durable state — this is the path a restart
        // resolves through — so the agent is loaded rather than created, and knows whether it
        // has work left before anything asks it. Bringing a collection up asks only for the
        // agents that do; anything else resolving an agent wants it whether it owes work or not.
        const agent = fresh
            ? await Agent.create(agentCtx, options)
            : await Agent.load(agentCtx, options, loadCtx);
        if (onlyIfActive && !agent.active) {
            await agent.close();
            return undefined;
        }
        if (publish) this.#publish(agent, start);
        return agent;
    }

    /** Publish one fully loaded lifetime synchronously, before the database slot is released. */
    #publish(agent: Agent<AnyAgentTool, Database>, start: boolean): void {
        const existing = this.#agents.get(agent.id);
        if (existing !== undefined && existing !== agent) {
            throw new Error(`Agent "${agent.id}" already has a live instance.`);
        }
        this.#agents.set(agent.id, agent);
        if (this.#draining) {
            this.#beginAgentDrain(agent);
        } else if (start) {
            agent.start();
        }
    }

    /**
     * Resolve and resume every agent that has work left from before this process started.
     *
     * The active index is a fast answer, not the authority. It is written by a live run and can
     * Every identity the storage holds is asked whether it has work left, and the ones that do
     * are built and set going. The question is one key in the agent's own store, and only the
     * agent answers it: the collection keeps no index of its own to go stale, and an identity is
     * never dismissed on the strength of something written about it elsewhere.
     *
     * Building the agent is all this does. An agent picks its own work back up when it is
     * loaded, so the collection has only to bring the right ones into existence.
     */
    async #start(ctx: Context): Promise<readonly Agent<AnyAgentTool, Database>[]> {
        const created = await this.#configs.list(ctx);
        const results = await Promise.allSettled(
            created.map(async ({ key: agentId }) => {
                return await this.#lockFor(agentId).runInLock(ctx, async (lockCtx) => {
                    if (this.#agents.has(agentId)) return undefined;
                    const config = await this.#config(lockCtx, agentId);
                    if (config === undefined) return undefined;
                    await this.#storage.transaction(lockCtx, async (txCtx) => {
                        await this.#recordLifecycle(
                            txCtx,
                            lifecycleAgent(agentId, config),
                            (hooks) => hooks.agentRestoredTransact,
                            (hooks) => hooks.agentRestored,
                        );
                    });
                    return await this.#instantiate(agentId, config, true, false);
                });
            }),
        );
        throwFirstStartFailure(results);
        await Promise.allSettled([...this.#lifecycleObservations]);
        return results.flatMap((result) =>
            result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
        );
    }

    /** Run one lifecycle projection in its durable transaction and observe it after commit. */
    async #recordLifecycle(
        txCtx: Context,
        agent: AgentModuleAgentLifecycle,
        transact: (
            hooks: AgentModuleHooks<AnyAgentTool, Database>,
        ) => AgentLifecycleHook<Database> | undefined,
        observe: (
            hooks: AgentModuleHooks<AnyAgentTool, Database>,
        ) => AgentLifecycleHook<Database> | undefined,
    ): Promise<void> {
        for (const runtime of this.#runtimes) {
            const hook = transact(runtime.hooks);
            if (hook === undefined) continue;
            await this.#invokeLifecycleHook(txCtx, runtime, hook, agent, true);
        }
        afterCommit(txCtx, () => {
            const observed = outsideAgentDatabaseOperation(async () => {
                for (const runtime of this.#runtimes) {
                    const hook = observe(runtime.hooks);
                    if (hook === undefined) continue;
                    try {
                        await this.#invokeLifecycleHook(this.#ctx, runtime, hook, agent);
                    } catch {
                        // The durable change already committed; observers cannot undo it.
                    }
                }
            });
            this.#admitted.add(observed);
            this.#lifecycleObservations.add(observed);
            void observed.finally(() => {
                this.#admitted.delete(observed);
                this.#lifecycleObservations.delete(observed);
            });
        });
    }

    /** Give one lifecycle hook its module-scoped shared KV and active Drizzle facade. */
    async #invokeLifecycleHook(
        ctx: Context,
        module: { readonly name: string },
        hook: AgentLifecycleHook<Database>,
        agent: AgentModuleAgentLifecycle,
        blockAgent: boolean = false,
    ): Promise<void> {
        const lifetime = new AbortController();
        const database = agentDatabase(ctx) ?? this.#storage.database;
        const sharedKV = this.#sharedModuleKV.scoped(module.name);
        const agents = new AgentSystemRef(this, null, blockAgent ? agent.id : undefined);
        const hookCtx = withLifetime(
            withAgentKV(withAgentSystem(withAgentDatabase(ctx, database), agents), sharedKV),
            lifetime.signal,
        );
        const scope: AgentModuleSystemScope<Database> = {
            agents,
            sharedKV,
        };
        try {
            await hook(hookCtx, scope, agent);
        } finally {
            lifetime.abort();
        }
    }

    /**
     * Initialize every module before any active agent is restored or started. What each
     * beforeStart returns is the module's whole runtime behavior, so this is also where the
     * collection resolves the hooks every agent it builds will run with.
     */
    async #beforeStart(ctx: Context): Promise<void> {
        const startCtx = withAgentSystem(ctx, this.#ref);
        const results = await Promise.allSettled(
            this.#modules.map(
                async (module): Promise<AgentModuleRuntime<AnyAgentTool, Database>> => {
                    const hooks = (await module.beforeStart?.(startCtx, this.#ref)) ?? {};
                    return { name: module.name, module, hooks };
                },
            ),
        );
        throwFirstStartFailure(results);
        this.#runtimes = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
        );
    }

    /** Notify every module after all active agents have been restored and started. */
    async #afterStart(ctx: Context): Promise<void> {
        const startCtx = withAgentSystem(ctx, this.#ref);
        const results = await Promise.allSettled(
            this.#runtimes.map(
                async (runtime) => await runtime.hooks.afterStart?.(startCtx, this.#ref),
            ),
        );
        throwFirstStartFailure(results);
    }

    /** The durable store for one agent, created once and reused for the life of the collection. */
    #persistenceFor(agentId: string): AgentPersistence {
        const existing = this.#persistences.get(agentId);
        if (existing !== undefined) return existing;
        const created = this.#storage.persistence(agentId);
        this.#persistences.set(agentId, created);
        return created;
    }

    /**
     * The lock serializing this collection's work on one identity. It is per agent because the
     * work it guards — building an agent, which loads every module — may itself resolve another
     * agent from this same collection, and a collection-wide lock would deadlock on it.
     */
    #lockFor(agentId: string): AsyncLock {
        const existing = this.#locks.get(agentId);
        if (existing !== undefined) return existing;
        const created = asyncLock({ reentry: "block" });
        this.#locks.set(agentId, created);
        return created;
    }

    /** Wait for an earlier incarnation of this identity to finish handing off its store. */
    async #waitForTransition(ctx: Context, agentId: string): Promise<void> {
        const transition = this.#transitions.get(agentId);
        if (transition === undefined) return;
        // A transition may itself need the database after an active turn unwinds. Waiting from
        // a transaction would keep that database slot occupied and deadlock the handoff.
        if (agentStorageTransaction(ctx) !== undefined) {
            throw new Error(
                `Agent "${agentId}" is still finishing deletion and cannot be used by a ` +
                    "storage transaction yet.",
            );
        }
        await transition;
    }

    /** Reusing a staged deletion would mix two live incarnations in one transaction. */
    #assertNotDeletedInTransaction(ctx: Context, agentId: string): void {
        const transaction = agentStorageTransaction(ctx);
        if (transaction === undefined) return;
        if (this.#transactionAgents.get(transaction)?.get(agentId) !== null) return;
        throw new Error(
            `Agent "${agentId}" cannot be recreated until its deleting transaction commits.`,
        );
    }

    /** Serialize one post-commit identity handoff without keeping the committing database slot. */
    #beginTransition(agentId: string, work: () => Promise<void>): void {
        const previous = this.#transitions.get(agentId);
        const transition = (previous === undefined ? Promise.resolve() : previous)
            .catch(() => undefined)
            .then(work);
        this.#transitions.set(agentId, transition);
        void transition
            .catch((error: unknown) => {
                this.#ctx.log.warn(`The transition for agent "${agentId}" failed.`, error);
            })
            .finally(() => {
                if (this.#transitions.get(agentId) === transition) {
                    this.#transitions.delete(agentId);
                }
            });
    }

    /** Queue a steered message for an agent. */
    async steer(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        return await this.#admit(async () => {
            const agent = await this.#messageTarget(ctx, agentId);
            return await agent.steer(ctx, message, options);
        });
    }

    /** Queue a message for an agent. */
    async send(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        return await this.#admit(async () => {
            const agent = await this.#messageTarget(ctx, agentId);
            return await agent.send(ctx, message, options);
        });
    }

    /**
     * Transactional delivery may load an idle target through the transaction it already owns.
     * The provisional object is published only after commit, before the database owner admits
     * another root operation. A rollback therefore leaves neither a live object nor leaked
     * uncommitted state, and this path never waits for an identity lock while owning the database.
     */
    async #messageTarget(ctx: Context, agentId: string): Promise<Agent<AnyAgentTool, Database>> {
        const transaction = agentStorageTransaction(ctx);
        if (transaction === undefined) return await this.#resolve(ctx, agentId);
        const config = await this.#config(ctx, agentId);
        if (config === undefined) {
            throw new Error(`Agent "${agentId}" has not been created.`);
        }
        return await this.#transactionAgent(ctx, agentId, config, false);
    }

    /**
     * Load one transaction-local agent through the carried database facade. Every operation in
     * the same transaction reuses it, and commit publishes it with the strongest requested start
     * behavior; rollback drops the publication callback.
     */
    async #transactionAgent(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
        start: boolean,
        fresh = false,
    ): Promise<Agent<AnyAgentTool, Database>> {
        const transaction = agentStorageTransaction(ctx);
        if (transaction === undefined) {
            throw new Error("A transaction-local agent requires an agent storage transaction.");
        }
        let provisional = this.#transactionAgents.get(transaction);
        if (provisional === undefined) {
            provisional = new Map();
            this.#transactionAgents.set(transaction, provisional);
        }
        const cached = provisional.get(agentId);
        if (cached !== undefined && cached !== null) {
            cached.start ||= start;
            return cached.agent;
        }
        if (cached === null) {
            throw new Error(
                `Agent "${agentId}" cannot be resolved after deletion in the same transaction.`,
            );
        }
        const concurrent = this.#agents.get(agentId);
        if (concurrent !== undefined) return concurrent;
        const agent = await this.#instantiate(agentId, config, false, false, ctx, false, fresh);
        if (agent === undefined) throw new Error(`Agent "${agentId}" could not be built.`);
        const entry: TransactionAgentEntry<Database> = { agent, start };
        provisional.set(agentId, entry);
        afterCommit(ctx, () => {
            outsideAgentDatabaseOperation(() => {
                if (provisional.get(agentId) === entry) this.#publish(agent, entry.start);
            });
        });
        return agent;
    }

    /** Cancel an agent's active turn, leaving its queued messages durable for the next one. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        await this.#admit(async () => {
            await (await this.#resolve(ctx, agentId)).abort(ctx);
        });
    }

    /** Ask an agent for its conversation to be replaced by the provider's summary of it. */
    async compact(ctx: Context, agentId: string): Promise<void> {
        await this.#admit(async () => {
            await (await this.#resolve(ctx, agentId)).compact(ctx);
        });
    }
}

/** Own and freeze the lifecycle snapshot before any module observes it. */
function lifecycleAgent(agentId: string, config: AgentConfig): AgentModuleAgentLifecycle {
    const metadata = config.metadata === undefined ? undefined : ownAgentMetadata(config.metadata);
    if (config.metadata !== undefined && metadata === undefined) {
        throw new Error(`The metadata for agent "${agentId}" is not valid.`);
    }
    return Object.freeze({ id: agentId, metadata });
}

/** Start every module even when one fails, then surface the first failure in module order. */
function throwFirstStartFailure(results: readonly PromiseSettledResult<unknown>[]): void {
    const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
}
