import type { SessionSystemMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import { agentConfig } from "./AgentConfig.js";
import { AgentBase, type AgentBaseMessageOptions, type AgentBaseOptions } from "./AgentBase.js";
import {
    agentDatabase,
    agentEffort,
    agentHistoryKV,
    agentKV,
    agentModel,
    agentPermissionMode,
    agentProvider,
    agentRunKV,
    agentServiceTier,
    withAgentKV,
    withAgentHistoryKV,
    withAgentRunKV,
} from "./AgentContexts.js";
import type { AgentBaseHooks, MaybePromise } from "./AgentBaseHooks.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import type { AgentDatabase } from "./AgentDatabase.js";
import type { AgentModule, AgentModuleRuntime, AgentModuleScope } from "./AgentModule.js";
import type { AgentPermissionMode } from "./AgentPermissionMode.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";
import type { AgentModuleAction } from "./AgentModuleAction.js";
import type { AgentKV } from "./AgentKV.js";
import type { AgentMetadata } from "./AgentMetadata.js";
import type { AgentMessageAcceptance } from "./AgentMessageAcceptance.js";
import type { AnyAgentTool } from "./AgentTool.js";
import type { AgentBasePendingStage } from "./AgentBasePending.js";

/**
 * Everything `AgentBase` is constructed with, except its hooks: an agent's behavior comes from
 * its modules, and the singular hooks the base runs with are merged from them.
 */
export interface AgentOptions<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
> extends Omit<AgentBaseOptions, "hooks"> {
    /** Modules resolved by the owning system: each name beside the hooks its beforeStart returned. */
    readonly modules?: readonly AgentModuleRuntime<Tool, Database>[];
    /**
     * The store modules share with every other agent built over the same storage. Each module
     * is handed its own scope of it, which is where anything outliving one conversation belongs.
     */
    readonly sharedKV: AgentKV;
}

/**
 * A thin wrapper around `AgentBase` that assembles its behavior from modules. Each module
 * implements any subset of the agent hooks on its own; the agent merges them into the singular
 * private hooks its internal base runs with.
 *
 * Modules are independent. Observing hooks — events and lifecycle brackets — fan out to every
 * module in array order with per-module isolation, so one throwing module never silences the
 * others, and lifecycle actions concatenate across modules with a failing module losing only
 * its own actions. Correctness hooks are loud instead: instructions and tools concatenate in
 * module order — extending the base state, which `AgentBase` puts first — and a failure there
 * fails the turn rather than running with a wrong configuration. For a model change, every
 * module observes the change, the first returned handoff wins, and a module failure during an
 * incompatible change rejects the switch so the history survives.
 */
export class Agent<
    Tool extends AnyAgentTool = AnyAgentTool,
    Database extends AgentDatabase = AgentDatabase,
> {
    /** The session this agent is a facade over; every operation delegates straight to it. */
    readonly #base: AgentBase;
    /** The resolved modules whose hooks were merged into the base, in the order they were given. */
    readonly #modules: readonly AgentModuleRuntime<Tool, Database>[];

    /**
     * A new agent over a fresh identity, with its modules' hooks merged into one set. Touches
     * no storage.
     */
    static async create<
        Tool extends AnyAgentTool = AnyAgentTool,
        Database extends AgentDatabase = AgentDatabase,
    >(ctx: Context, options: AgentOptions<Tool, Database>): Promise<Agent<Tool, Database>> {
        const { modules, base } = split(options);
        return new Agent(await AgentBase.create(ctx, base), modules);
    }

    /**
     * An agent over an identity that may already have durable state, with that state's one
     * externally meaningful fact — whether it has work left — read before it is handed back.
     * A caller resolving the agent from inside an open storage transaction passes `loadCtx` so
     * that one read rides the transaction's own connection.
     */
    static async load<
        Tool extends AnyAgentTool = AnyAgentTool,
        Database extends AgentDatabase = AgentDatabase,
    >(
        ctx: Context,
        options: AgentOptions<Tool, Database>,
        loadCtx?: Context,
    ): Promise<Agent<Tool, Database>> {
        const { modules, base } = split(options);
        return new Agent(await AgentBase.load(ctx, base, loadCtx), modules);
    }

    /**
     * Load the agent and set it going again if it has work left, or answer with nothing when it
     * has none — how an owner coming up carries on what an earlier process was in the middle of.
     */
    static async loadActive<
        Tool extends AnyAgentTool = AnyAgentTool,
        Database extends AgentDatabase = AgentDatabase,
    >(
        ctx: Context,
        options: AgentOptions<Tool, Database>,
    ): Promise<Agent<Tool, Database> | undefined> {
        const { modules, base } = split(options);
        const loaded = await AgentBase.loadActive(ctx, base);
        return loaded === undefined ? undefined : new Agent(loaded, modules);
    }

    /**
     * Wrap an already-built base. Private, because an agent is made by `create` or by `load`,
     * and which of the two the caller means is worth saying.
     */
    private constructor(base: AgentBase, modules: readonly AgentModuleRuntime<Tool, Database>[]) {
        this.#modules = modules;
        this.#base = base;
    }

    /** The stable session identity this agent was created with. */
    get id(): string {
        return this.#base.id;
    }

    /** Whether durable state says this agent still has work to resume. */
    get active(): boolean {
        return this.#base.active;
    }

    /** The durable stage this agent is finishing while a drain is pending. */
    get drainStage(): AgentBasePendingStage | undefined {
        return this.#base.drainStage;
    }

    /**
     * The module this agent runs under `name`, when it has one. An individual module holds the
     * state of the single agent it was built for, so this is how that agent's owner reaches what
     * belongs to it — a goal to pause, for instance. A shared module is answered here too, but
     * it is the collection's instance, serving every agent at once.
     */
    module(name: string): AgentModule<Tool, Database> | undefined {
        return this.#modules.find((module) => module.name === name)?.module;
    }

    /**
     * The base's mutable instructions and tools, which every inference reads and every module's
     * own contribution extends.
     */
    get state(): AgentBaseState {
        return this.#base.state;
    }

    /** Queue a message that injects as soon as the current response and tool batch finish. */
    async steer(
        ctx: Context,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        return await this.#base.steer(ctx, message, options);
    }

    /** Queue a message that injects only when the agent would otherwise stop. */
    async send(
        ctx: Context,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        return await this.#base.send(ctx, message, options);
    }

    /** Shallow-merge fields into this agent's immutable metadata. */
    async updateMetadata(ctx: Context, update: AgentMetadata): Promise<void> {
        await this.#base.updateMetadata(ctx, update);
    }

    /** Start the loop without a new message, continuing a turn an earlier run left unfinished. */
    start(): void {
        this.#base.start();
    }

    /** Stop at the next durable edge, interrupting tools that opt into stop or reload behavior. */
    drain(): Promise<void> {
        return this.#base.drain();
    }

    /** Wait until the agent has nothing left to do, including work it accepted but never began. */
    async waitForIdle(): Promise<void> {
        await this.#base.waitForIdle();
    }

    /** Ask for the conversation to be replaced by the provider's summary of it. */
    async compact(ctx: Context): Promise<void> {
        await this.#base.compact(ctx);
    }

    /** Cancel the active turn, leaving queued messages durable for the next one. */
    async abort(ctx: Context): Promise<void> {
        await this.#base.abort(ctx);
    }

    /** Finish everything already accepted, then destroy the provider session. */
    async close(): Promise<void> {
        await this.#base.close();
    }

    /**
     * Wait for a close that has already been requested to finish, including when its original
     * caller was inside the agent and could not wait for its own turn.
     */
    async waitForClosed(): Promise<void> {
        await this.#base.waitForClosed();
    }
}

/**
 * Merge every module's hook implementations into one `AgentBaseHooks`. A hook is provided only
 * when at least one module implements it, so the base's own behavior — the mutable state alone
 * for instructions and tools — stays in effect otherwise.
 */
/**
 * Separate the modules from the options the base is built with, and merge their hooks into the
 * one set the base observes the run through. Both factories need exactly this, and the merge has
 * to happen before the base exists.
 */
function split<Tool extends AnyAgentTool, Database extends AgentDatabase>(
    options: AgentOptions<Tool, Database>,
): { modules: readonly AgentModuleRuntime<Tool, Database>[]; base: AgentBaseOptions } {
    const { modules, sharedKV, ...rest } = options;
    const resolved = modules ?? [];
    return {
        modules: resolved,
        base: { ...rest, hooks: mergeModules(resolved, options, sharedKV) },
    };
}

function mergeModules<Tool extends AnyAgentTool, Database extends AgentDatabase>(
    modules: readonly AgentModuleRuntime<Tool, Database>[],
    options: AgentOptions<Tool, Database>,
    sharedKV: AgentKV,
): AgentBaseHooks {
    /** What one module's hook is handed alongside the context, for this call. */
    const scopeOf = (
        ctx: Context,
        module: AgentModuleRuntime<Tool, Database>,
    ): AgentModuleScope<Database> => moduleScope(ctx, module, options, sharedKV);
    const withInstructions = modules.filter((module) => module.hooks.instructions !== undefined);
    const withTools = modules.filter((module) => module.hooks.tools !== undefined);
    const withBeforeToolCall = modules.filter(
        (module) => module.hooks.beforeToolCall !== undefined,
    );
    const withModelChanged = modules.filter((module) => module.hooks.modelChanged !== undefined);
    const withEvents = modules.filter((module) => module.hooks.onEvent !== undefined);
    // Observing hooks fan out with per-module isolation: one throwing module must never
    // prevent the modules after it from observing.
    const fanOut = <Arguments extends readonly unknown[]>(
        pick: (
            module: AgentModuleRuntime<Tool, Database>,
        ) =>
            | ((
                  ctx: Context,
                  scope: AgentModuleScope<Database>,
                  ...args: Arguments
              ) => MaybePromise<void>)
            | undefined,
    ): ((ctx: Context, ...args: Arguments) => Promise<void>) | undefined => {
        const implemented = modules.filter((module) => pick(module) !== undefined);
        if (implemented.length === 0) return undefined;
        return async (ctx, ...args) => {
            for (const module of implemented) {
                try {
                    await pick(module)?.(moduleCtx(ctx, module), scopeOf(ctx, module), ...args);
                } catch {
                    // Modules observe independently; one failing never silences the rest.
                }
            }
        };
    };
    // Transactional hooks run in order inside one transaction, and a failure propagates: the
    // modules here are writing alongside the fact being committed, so containing one module's
    // failure would commit a conclusion the rest of the transaction contradicts.
    const chain = <Arguments extends readonly unknown[]>(
        pick: (
            module: AgentModuleRuntime<Tool, Database>,
        ) =>
            | ((
                  ctx: Context,
                  scope: AgentModuleScope<Database>,
                  ...args: Arguments
              ) => MaybePromise<void>)
            | undefined,
    ): ((ctx: Context, ...args: Arguments) => Promise<void>) | undefined => {
        const implemented = modules.filter((module) => pick(module) !== undefined);
        if (implemented.length === 0) return undefined;
        return async (ctx, ...args) => {
            for (const module of implemented) {
                await pick(module)?.(moduleCtx(ctx, module), scopeOf(ctx, module), ...args);
            }
        };
    };
    // Action hooks concatenate what every module asks for; a failing module loses only its
    // own actions.
    const collect = <
        Arguments extends readonly unknown[],
        Action extends AgentModuleAction = AgentModuleAction,
    >(
        pick: (
            module: AgentModuleRuntime<Tool, Database>,
        ) =>
            | ((
                  ctx: Context,
                  scope: AgentModuleScope<Database>,
                  ...args: Arguments
              ) => MaybePromise<readonly Action[] | undefined>)
            | undefined,
    ): ((ctx: Context, ...args: Arguments) => Promise<readonly Action[]>) | undefined => {
        const implemented = modules.filter((module) => pick(module) !== undefined);
        if (implemented.length === 0) return undefined;
        return async (ctx, ...args) => {
            const actions: Action[] = [];
            for (const module of implemented) {
                try {
                    actions.push(
                        ...((await pick(module)?.(
                            moduleCtx(ctx, module),
                            scopeOf(ctx, module),
                            ...args,
                        )) ?? []),
                    );
                } catch {
                    // Modules act independently; one failing never discards the rest.
                }
            }
            return actions;
        };
    };
    return {
        ...(withEvents.length === 0
            ? {}
            : {
                  onEvent: (async (ctx, event) => {
                      for (const module of withEvents) {
                          try {
                              await module.hooks.onEvent?.(
                                  moduleCtx(ctx, module),
                                  scopeOf(ctx, module),
                                  event,
                              );
                          } catch {
                              // Modules observe independently; one failing never silences
                              // the rest.
                          }
                      }
                  }) satisfies AgentBaseHooks["onEvent"],
              }),
        ...spread(
            "onEventTransact",
            chain((module) => module.hooks.onEventTransact),
        ),
        ...(withInstructions.length === 0
            ? {}
            : {
                  // Correctness hook: a failing module propagates and fails the turn.
                  instructions: async (ctx: Context) => {
                      const texts: string[] = [];
                      for (const module of withInstructions) {
                          texts.push(
                              (await module.hooks.instructions?.(
                                  moduleCtx(ctx, module),
                                  scopeOf(ctx, module),
                              )) ?? "",
                          );
                      }
                      return texts.filter((text) => text.length > 0).join("\n\n");
                  },
              }),
        ...(withTools.length === 0
            ? {}
            : {
                  // Correctness hook: a failing module propagates and fails the turn; the
                  // base validates the merged list against duplicate names.
                  tools: async (ctx: Context) => {
                      const tools: AnyAgentTool[] = [];
                      for (const module of withTools) {
                          tools.push(
                              ...((await module.hooks.tools?.(
                                  moduleCtx(ctx, module),
                                  scopeOf(ctx, module),
                              )) ?? []),
                          );
                      }
                      return tools;
                  },
              }),
        ...spread(
            "beforeCompaction",
            fanOut((module) => module.hooks.beforeCompaction),
        ),
        ...spread(
            "historyErasedTransact",
            chain((module) => module.hooks.historyErasedTransact),
        ),
        ...spread(
            "afterCompaction",
            fanOut((module) => module.hooks.afterCompaction),
        ),
        ...spread(
            "beforeToolCallTransact",
            chain((module) => module.hooks.beforeToolCallTransact),
        ),
        ...(withBeforeToolCall.length === 0
            ? {}
            : {
                  // Correctness hook: modules decide in array order, each seeing the call as the
                  // one before it left it, and a failure propagates to the base so it becomes
                  // this call's error result.
                  beforeToolCall: async (ctx, call) => {
                      let current = call;
                      // Nothing carries a mode into the next module's view of the call, so the
                      // last module to name one is the one that meant it about the run itself.
                      let permissionMode: AgentPermissionMode | undefined;
                      for (const module of withBeforeToolCall) {
                          const decision = await module.hooks.beforeToolCall?.(
                              moduleCtx(ctx, module),
                              scopeOf(ctx, module),
                              current,
                          );
                          if (decision === undefined) continue;
                          // An answer settles the call: there is no longer a run for the
                          // modules after it to have an opinion about.
                          if (decision.type === "answer") return decision;
                          current = {
                              callId: current.callId,
                              tool: decision.tool ?? current.tool,
                              arguments: decision.arguments ?? current.arguments,
                          };
                          permissionMode = decision.permissionMode ?? permissionMode;
                      }
                      if (
                          current.tool === call.tool &&
                          current.arguments === call.arguments &&
                          permissionMode === undefined
                      ) {
                          return undefined;
                      }
                      return {
                          type: "run",
                          ...(current.tool === call.tool ? {} : { tool: current.tool }),
                          ...(current.arguments === call.arguments
                              ? {}
                              : { arguments: current.arguments }),
                          ...(permissionMode === undefined ? {} : { permissionMode }),
                      };
                  },
              }),
        ...spread(
            "afterToolCall",
            fanOut((module) => module.hooks.afterToolCall),
        ),
        ...spread(
            "afterToolCallTransact",
            chain((module) => module.hooks.afterToolCallTransact),
        ),
        ...(withModelChanged.length === 0
            ? {}
            : {
                  modelChanged: async (ctx, change) => {
                      let injected: SessionSystemMessage | undefined;
                      let failed = false;
                      let failure: unknown;
                      // Every module observes the change even when an earlier one fails;
                      // the first returned handoff wins.
                      for (const module of withModelChanged) {
                          try {
                              const message = await module.hooks.modelChanged?.(
                                  moduleCtx(ctx, module),
                                  scopeOf(ctx, module),
                                  change,
                              );
                              injected ??= message;
                          } catch (error: unknown) {
                              if (!failed) {
                                  failed = true;
                                  failure = error;
                              }
                          }
                      }
                      // A failing module during an incompatible change rejects the switch,
                      // preserving the history; on a compatible change it merely observed.
                      if (failed && change.wasReset) throw failure;
                      return injected;
                  },
              }),
        ...spread(
            "messageAcceptedTransact",
            chain((module) => module.hooks.messageAcceptedTransact),
        ),
        ...spread(
            "messageAccepted",
            fanOut((module) => module.hooks.messageAccepted),
        ),
        ...spread(
            "permissionModeChangedTransact",
            chain((module) => module.hooks.permissionModeChangedTransact),
        ),
        ...spread(
            "permissionModeChanged",
            fanOut((module) => module.hooks.permissionModeChanged),
        ),
        ...spread(
            "metadataChangedTransact",
            chain((module) => module.hooks.metadataChangedTransact),
        ),
        ...spread(
            "metadataChanged",
            fanOut((module) => module.hooks.metadataChanged),
        ),
        ...spread(
            "afterAgentActivatedTransact",
            chain((module) => module.hooks.afterAgentActivatedTransact),
        ),
        ...spread(
            "beforeAgentLoopTransact",
            chain((module) => module.hooks.beforeAgentLoopTransact),
        ),
        ...spread(
            "beforeAgentLoop",
            fanOut((module) => module.hooks.beforeAgentLoop),
        ),
        ...spread(
            "beforeTurnTransact",
            chain((module) => module.hooks.beforeTurnTransact),
        ),
        ...spread(
            "beforeTurn",
            collect((module) => module.hooks.beforeTurn),
        ),
        ...spread(
            "prepareInference",
            collect((module) => module.hooks.prepareInference),
        ),
        ...spread(
            "beforeInferenceTransact",
            chain((module) => module.hooks.beforeInferenceTransact),
        ),
        ...spread(
            "beforeInference",
            fanOut((module) => module.hooks.beforeInference),
        ),
        ...spread(
            "afterInferenceTransact",
            chain((module) => module.hooks.afterInferenceTransact),
        ),
        ...spread(
            "afterInference",
            fanOut((module) => module.hooks.afterInference),
        ),
        ...spread(
            "afterTurnTransact",
            chain((module) => module.hooks.afterTurnTransact),
        ),
        ...spread(
            "afterTurn",
            collect((module) => module.hooks.afterTurn),
        ),
        ...spread(
            "afterAgentLoopTransact",
            chain((module) => module.hooks.afterAgentLoopTransact),
        ),
        ...spread(
            "afterAgentLoop",
            collect((module) => module.hooks.afterAgentLoop),
        ),
        ...spread(
            "afterAgentSettledTransact",
            chain((module) => module.hooks.afterAgentSettledTransact),
        ),
        ...spread(
            "afterAgentSettled",
            fanOut((module) => module.hooks.afterAgentSettled),
        ),
    };
}

/**
 * The context a module's hooks run on: the agent's context with its key-value stores narrowed
 * to the module's own name, so modules never see each other's persisted entries — and neither
 * does a tool one of them runs.
 */
function moduleCtx(ctx: Context, module: { readonly name: string }): Context {
    const kv = agentKV(ctx);
    const historyKV = agentHistoryKV(ctx);
    const runKV = agentRunKV(ctx);
    const scoped = kv === undefined ? ctx : withAgentKV(ctx, kv.scoped("module", module.name));
    const withHistory =
        historyKV === undefined
            ? scoped
            : withAgentHistoryKV(scoped, historyKV.scoped("module", module.name));
    return runKV === undefined
        ? withHistory
        : withAgentRunKV(withHistory, runKV.scoped("module", module.name));
}

/**
 * What a module's hook is handed alongside the context: the agent it is serving, and its own
 * scope of each store. The selection comes from the context the agent derived for
 * this call, so a hook always sees the model, effort, and tier the work is actually running on
 * rather than the ones the agent was built with.
 */
function moduleScope<Tool extends AnyAgentTool, Database extends AgentDatabase>(
    ctx: Context,
    module: { readonly name: string },
    options: AgentOptions<Tool, Database>,
    sharedKV: AgentKV,
): AgentModuleScope<Database> {
    const kv = agentKV(ctx);
    const historyKV = agentHistoryKV(ctx);
    const runKV = agentRunKV(ctx);
    if (
        kv === undefined ||
        historyKV === undefined ||
        runKV === undefined ||
        agentDatabase(ctx) === undefined
    ) {
        throw new Error(
            `The module "${module.name}" was called without its agent storage context.`,
        );
    }
    const provider = agentProvider(ctx) ?? options.provider;
    return {
        agent: {
            id: options.id,
            metadata: agentConfig(ctx)?.metadata,
            provider,
            providerKind: options.providers.typeOf(provider) ?? undefined,
            model: agentModel(ctx) ?? options.model,
            effort: agentEffort(ctx) ?? options.effort,
            tier: agentServiceTier(ctx) ?? options.serviceTier,
            permissionMode: agentPermissionMode(ctx),
        },
        kv: kv.scoped("module", module.name),
        sharedKV: sharedKV.scoped(module.name),
        runKV: runKV.scoped("module", module.name),
        historyKV: historyKV.scoped("module", module.name),
    };
}

/**
 * One optional entry to spread into the merged hooks: the key when a merged implementation
 * exists, and nothing at all when no module implemented it, so the base keeps its own behavior.
 */
function spread<Key extends string, Value>(
    key: Key,
    value: Value | undefined,
): { [K in Key]?: Value } {
    return value === undefined ? {} : ({ [key]: value } as { [K in Key]: Value });
}
