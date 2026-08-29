import {
    agentDatabase,
    agentModuleConfig,
    cuid2Schema,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AnyAgentTool,
    withAgentDatabase,
} from "@slopus/happy-agent-base";
import {
    createHostCompute,
    HOST_SESSION_STOP_GRACE_MS,
    hostComputeProvider,
    killProcessGroup,
    NativeProcessManager,
    type Compute,
    type ComputeHostPolicy,
    type HostComputeConfig,
} from "@slopus/happy-agent-compute";
import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { detach, mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import { FileReadLog } from "../impl/FileReadLog.js";
import type { SecretsModule } from "../secrets/index.js";
import type {
    ComputePermissions,
    ComputeSessionActivity,
    ComputeSessionSnapshot,
} from "./Compute.js";
import {
    type ComputeProcess,
    type ComputeProcessEventListener,
    type ComputeProcessUnsubscribe,
} from "./ComputeProcess.js";
import { ComputeProcessRegistry } from "./ComputeProcessRegistry.js";
import { computeToolVendor, type ComputeToolVendor } from "./ComputeToolVendor.js";
import { computeInstructionsForVendor } from "./impl/computeInstructionsForVendor.js";
import { computePermissionsForContext } from "./impl/computePermissionsForContext.js";
import { createAttachedSecretsHostShell } from "./impl/createAttachedSecretsHostShell.js";
import { describeComputePathAction } from "./impl/describeComputePathAction.js";
import {
    basenameComputePath,
    parentComputePath,
    resolveComputePath,
} from "./impl/resolveComputePath.js";
import { shouldReviewComputePath } from "./impl/shouldReviewComputePath.js";
import { assembleComputeTools } from "./tools/assembleComputeTools.js";
import { assembleReviewerTools } from "./tools/assembleReviewerTools.js";

/**
 * The lock key the reviewer's machine is created under. It carries a NUL so it can never be an
 * agent ID, and therefore never serializes against the creation of an agent's own machine.
 */
const REVIEWER_COMPUTE_KEY = "\u0000permission-reviewer";

const exact = { additionalProperties: false } as const;
const callableSchema = Type.Function([], Type.Any());
const contextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));
const MAX_ABORT_NOTICE_SESSIONS = 16;
const MAX_ABORT_NOTICE_COMMAND_LENGTH = 1_000;
const computeAbortNoticeSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9]+$" }),
        killedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        processTrees: Type.Integer({ minimum: 1, maximum: 10_000 }),
        sessions: Type.Array(
            Type.Object(
                {
                    command: Type.String({ maxLength: MAX_ABORT_NOTICE_COMMAND_LENGTH }),
                    sessionId: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
                },
                exact,
            ),
            { maxItems: MAX_ABORT_NOTICE_SESSIONS },
        ),
    },
    exact,
);
type ComputeAbortNotice = Static<typeof computeAbortNoticeSchema>;
const ABORT_NOTICES_SCOPE = "abort-notices";
const ABORT_NOTICE_KEY = "pending";

const computeFileSystemSchema = Type.Object(
    {
        cwd: Type.String(),
        home: Type.Optional(Type.String()),
        chmod: callableSchema,
        exists: callableSchema,
        lstat: callableSchema,
        lstatMany: callableSchema,
        mkdir: callableSchema,
        move: callableSchema,
        realpath: callableSchema,
        readFile: callableSchema,
        readFileBuffer: callableSchema,
        readdir: callableSchema,
        readdirPage: callableSchema,
        rm: callableSchema,
        setModificationTime: callableSchema,
        stat: callableSchema,
        writeFile: callableSchema,
    },
    exact,
);

const computeShellSchema = Type.Object(
    {
        cwd: Type.String(),
        activeSessionCount: Type.Optional(callableSchema),
        activeSessions: Type.Optional(callableSchema),
        detachSession: Type.Optional(callableSchema),
        interruptSession: Type.Optional(callableSchema),
        killAllSessions: Type.Optional(callableSchema),
        killSession: callableSchema,
        readSession: callableSchema,
        run: callableSchema,
        sessionUsesSecrets: Type.Optional(callableSchema),
        setActiveSessionCountListener: Type.Optional(callableSchema),
        setSessionExitListener: Type.Optional(callableSchema),
        startSession: callableSchema,
        supportsSessionInput: Type.Boolean(),
        writeSession: callableSchema,
    },
    exact,
);

/** The host compute resolved for one agent. */
export type HostCompute = Compute & { readonly kind: "host" };

export const hostComputeSchema = Type.Unsafe<HostCompute>(
    Type.Object(
        {
            id: Type.Literal("host"),
            kind: Type.Literal("host"),
            cwd: Type.String({ minLength: 1 }),
            fs: computeFileSystemSchema,
            shell: computeShellSchema,
            dispose: callableSchema,
        },
        exact,
    ),
);

/** Per-agent configuration read from `AgentConfig.modules.compute`. */
export const agentComputeConfigSchema = Type.Object(
    {
        cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
        providerId: Type.Optional(Type.Literal("host")),
        secretScope: Type.Optional(
            Type.Object(
                {
                    projectId: Type.Optional(cuid2Schema),
                    workspaceId: Type.Optional(cuid2Schema),
                },
                exact,
            ),
        ),
    },
    exact,
);
export type AgentComputeConfig = Static<typeof agentComputeConfigSchema>;

const hostComputeProviderSchema = Type.Object(
    {
        id: Type.Literal("host"),
        create: Type.Function(
            [contextSchema, Type.Object({ cwd: Type.String({ minLength: 1 }) }, exact)],
            Type.Promise(hostComputeSchema),
        ),
    },
    exact,
);

/** The one global host provider used to create every agent's separate compute. */
export type HostComputeProvider = Pick<typeof hostComputeProvider, "id" | "create">;

interface CachedCompute {
    abortGeneration: number;
    readonly cwd: string;
    readonly compute: HostCompute;
    readonly processContext: Context;
    readonly processManager: NativeProcessManager | undefined;
}

/** Running work visible at the instant an agent subtree is aborted. */
export interface ComputeAbortSnapshot {
    readonly processGroups: number;
    readonly sessions: readonly ComputeSessionActivity[];
}

/**
 * The shared compute module.
 *
 * One instance serves the whole AgentSystem. It reads each agent's immutable compute config,
 * creates one host compute for that agent through the global provider, and retains that exact
 * instance in memory for every module and tool serving the same agent.
 *
 * The module is built from the configuration and secrets modules. The boundary a restricted
 * command runs inside — which directories are the product's own, which project files decide what
 * later commands may do — is a fact about this installation's layout and settings, so it is
 * derived here from the config module that owns those paths. Secret bundle IDs are resolved by the
 * secrets module immediately before a command starts, so values never enter a model-facing tool
 * argument.
 */
export class ComputeModule implements AgentModule {
    readonly name = "compute";
    readonly #config: ConfigModule;
    readonly #secrets: SecretsModule;
    /** Present only for the named alternate construction used by scripted machines. */
    #provider: HostComputeProvider | undefined;
    readonly #computes = new Map<string, CachedCompute>();
    readonly #promptedAbortNotices = new Map<string, string>();
    readonly #computeLocks: MapAsyncLock<string> = mapAsyncLock<string>();
    readonly #activeOperations = new Set<Promise<unknown>>();
    readonly #processes = new ComputeProcessRegistry();
    readonly #readLocks: MapAsyncLock<string> = mapAsyncLock<string>();
    /**
     * Read locks for the automatic permission reviewer's tools. The reviewer runs over a compute the
     * host owns for it — a different object entirely from the per-agent computes this module caches —
     * so its file-read bookkeeping must not share the main agents' lock map. Keying reviewer reads
     * here keeps a review's reads consistent among themselves without ever serializing against, or
     * being serialized by, a reviewed agent's own reads.
     */
    readonly #reviewerReadLocks: MapAsyncLock<string> = mapAsyncLock<string>();
    /** The one machine the automatic permission reviewer investigates local state through. */
    #reviewer: HostCompute | undefined;
    /** Compute's one durable store shared by every agent in this collection. */
    #sharedKV: AgentKV | undefined;
    #closed = false;
    #disposePromise: Promise<void> | undefined;

    constructor(config: ConfigModule, secrets: SecretsModule) {
        this.#config = config;
        this.#secrets = secrets;
        this.#provider = undefined;
    }

    /**
     * The same module over a different machine.
     *
     * This is the one named alternate construction: a test runs the whole agent on a scripted
     * machine rather than this computer, and a sandboxed or Docker deployment offers the agent a
     * machine that is not the host it started on. The boundary policy still comes from the
     * configuration, so a swapped machine is a different machine and not a different set of rules.
     */
    static withProvider(
        config: ConfigModule,
        secrets: SecretsModule,
        provider: HostComputeProvider,
    ): ComputeModule {
        const candidate = { id: provider.id, create: provider.create };
        if (!Value.Check(hostComputeProviderSchema, candidate)) {
            throw new Error("The host compute provider is invalid.");
        }
        const module = new ComputeModule(config, secrets);
        module.#provider = provider;
        return module;
    }

    /** Resolve the exact compute cached for this agent, or no compute when none was configured. */
    async resolve(ctx: Context, agentId: string): Promise<HostCompute | undefined> {
        if (agentId.length === 0) throw new Error("Compute agent ID is invalid.");
        const raw = agentModuleConfig(ctx, this.name);
        if (raw === undefined) return undefined;
        if (!Value.Check(agentComputeConfigSchema, raw)) {
            throw new Error("Agent compute configuration is invalid.");
        }
        const config = raw as AgentComputeConfig;
        const providerId = config.providerId ?? "host";
        const configuredProviderId = this.#provider?.id ?? "host";
        if (providerId !== configuredProviderId) {
            throw new Error(
                `Agent requested compute provider "${providerId}", but "${configuredProviderId}" is configured.`,
            );
        }

        return await this.#track(
            this.#computeLocks.runInLock(ctx, agentId, async (lockCtx) => {
                if (this.#closed) throw new Error("Compute module is closed.");
                const existing = this.#computes.get(agentId);
                if (existing !== undefined) {
                    if (existing.cwd !== config.cwd) {
                        throw new Error("An agent's cached compute configuration cannot change.");
                    }
                    return existing.compute;
                }

                const created = await this.#create(
                    lockCtx,
                    config,
                    `compute.agent.${agentId}`,
                    agentId,
                );
                const { compute } = created;
                if (this.#closed) {
                    await compute.dispose(lockCtx);
                    throw new Error("Compute module is closed.");
                }
                const cached: CachedCompute = {
                    abortGeneration: 0,
                    cwd: config.cwd,
                    compute,
                    processContext: created.processContext,
                    processManager: created.processManager,
                };
                this.#guardSessionStarts(agentId, cached);
                this.#computes.set(agentId, cached);
                this.#processes.attach(agentId, compute);
                return compute;
            }),
        );
    }

    /**
     * Observe background-process lifecycle transitions after the new state is available to readers.
     *
     * Subscribe during startup, before agents can run commands, to see this daemon lifetime in
     * full. A failing observer cannot make a command start, exit, or stop appear to have failed.
     */
    onProcessEvent(listener: ComputeProcessEventListener): ComputeProcessUnsubscribe {
        return this.#processes.onEvent(listener);
    }

    /** Running commands and bounded exited history for one agent, newest first. */
    async listProcesses(ctx: Context, agentId: string): Promise<readonly ComputeProcess[]> {
        void ctx;
        if (agentId.length === 0) throw new Error("Compute agent ID is invalid.");
        return this.#processes.list(agentId);
    }

    /** Commands currently running for one already-resolved agent compute. */
    runningCommands(agentId: string): readonly ComputeSessionActivity[] {
        const compute = this.#computes.get(agentId)?.compute;
        return compute?.shell.activeSessions?.() ?? [];
    }

    /** Capture the process trees an abort notice will describe before its transaction commits. */
    abortSnapshot(agentId: string): ComputeAbortSnapshot {
        const cached = this.#computes.get(agentId);
        if (cached === undefined) return { processGroups: 0, sessions: [] };
        const sessions = cached.compute.shell.activeSessions?.() ?? [];
        return {
            processGroups: cached.processManager?.reapableCount() ?? sessions.length,
            sessions: structuredClone(sessions) as ComputeSessionActivity[],
        };
    }

    /** Durably remember what this abort is about to kill for the agent's next model request. */
    async recordAbortNotice(ctx: Context, agentId: string): Promise<ComputeAbortSnapshot> {
        const snapshot = this.abortSnapshot(agentId);
        await this.#storeAbortNotice(ctx, agentId, snapshot);
        return snapshot;
    }

    async #storeAbortNotice(
        ctx: Context,
        agentId: string,
        snapshot: ComputeAbortSnapshot,
    ): Promise<void> {
        const processTrees = Math.max(snapshot.processGroups, snapshot.sessions.length);
        if (processTrees === 0) return;
        const sharedKV = this.#sharedKV;
        if (sharedKV === undefined) {
            throw new Error("Compute cannot record an abort notice before its shared KV exists.");
        }
        const notice: ComputeAbortNotice = {
            id: createId(),
            killedAt: Date.now(),
            processTrees,
            sessions: snapshot.sessions
                .slice(0, MAX_ABORT_NOTICE_SESSIONS)
                .map(({ command, sessionId }) => ({
                    command: boundedAbortNoticeCommand(command),
                    sessionId,
                })),
        };
        if (!Value.Check(computeAbortNoticeSchema, notice)) {
            throw new Error("Compute produced an invalid abort notice.");
        }
        await abortNoticeStore(sharedKV, agentId).write(ctx, ABORT_NOTICE_KEY, notice);
    }

    /** Immediately mark and hard-kill every process tree owned by one agent compute. */
    async hardKillAgentProcesses(ctx: Context, agentId: string): Promise<void> {
        const cached = this.#computes.get(agentId);
        if (cached === undefined) return;
        cached.abortGeneration += 1;
        await this.#hardKillCached(ctx, agentId, cached);
    }

    /** Read command output without advancing the model's output cursor. */
    async readCommand(
        agentId: string,
        commandId: number,
    ): Promise<ComputeSessionSnapshot | undefined> {
        const compute = this.#computes.get(agentId)?.compute;
        const snapshot = await compute?.shell.readSession(commandId, { peek: true });
        if (compute !== undefined && snapshot !== undefined && snapshot.status !== "running") {
            this.#processes.exit(agentId, compute, commandId, snapshot.exitCode);
        }
        return snapshot;
    }

    /** Stop a command by hand, returning whether it was still present. */
    async stopCommand(agentId: string, commandId: number): Promise<boolean> {
        const compute = this.#computes.get(agentId)?.compute;
        if (compute === undefined) return false;
        const stopped = await compute.shell.killSession(commandId);
        if (stopped !== undefined && stopped.status !== "running") {
            this.#processes.exit(agentId, compute, commandId, stopped.exitCode);
        }
        return stopped !== undefined;
    }

    /** Stop one command addressed by its public process ID and return its final public state. */
    async stopProcess(
        ctx: Context,
        agentId: string,
        processId: string,
    ): Promise<ComputeProcess | undefined> {
        void ctx;
        return await this.#processes.stop(agentId, processId);
    }

    /** Ends one archived agent's machine and every background process it still owns. */
    async archiveAgent(ctx: Context, agentId: string): Promise<void> {
        this.#promptedAbortNotices.delete(agentId);
        await this.#track(
            this.#computeLocks.runInLock(ctx, agentId, async (lockCtx) => {
                if (this.#closed) return;
                const cached = this.#computes.get(agentId);
                if (cached === undefined) return;
                this.#computes.delete(agentId);
                this.#processes.detach(cached.compute);
                await this.#processes.drain();
                await cached.compute.dispose(lockCtx);
                this.#processes.exitAll(agentId, cached.compute);
            }),
        );
    }

    /**
     * The permission boundary every compute operation in the current tool call runs under.
     *
     * This is Agent Base's durable per-agent mode translated into the immutable boundary the
     * compute demands. Any module holding a machine — reading a skill, writing generated media,
     * reading a project's instructions — asks for it here rather than deriving one of its own, so
     * every operation on that machine is bounded the same way.
     */
    permissionsForContext(ctx: Context): ComputePermissions {
        return computePermissionsForContext(ctx);
    }

    /**
     * The absolute path a machine means by what the model wrote.
     *
     * The paths belong to the machine rather than to the process holding these tools, so `~`, the
     * separator, and what counts as absolute are all read from that machine instead of from
     * `node:path`.
     */
    resolvePath(compute: Compute, path: string): string {
        return resolveComputePath(path, compute.cwd, compute.fs.home);
    }

    /** The directory holding a path on a machine, or the path itself once there is nowhere left. */
    parentPath(path: string): string {
        return parentComputePath(path);
    }

    /** The last segment of a path on a machine: the file's or directory's own name. */
    pathName(path: string): string {
        return basenameComputePath(path);
    }

    /**
     * Whether one file operation is something Auto has to decide on rather than simply allow.
     *
     * Work inside the workspace is what the agent is for. What leaves it is not, and neither is a
     * change to a path this machine protects, so a tool anywhere in the product asks the module
     * that owns the boundary instead of judging a path itself.
     */
    async shouldReviewPath(
        ctx: Context,
        compute: Compute,
        path: string,
        options: { readonly write: boolean },
    ): Promise<boolean> {
        return await shouldReviewComputePath(compute, path, options, ctx);
    }

    /** The exact action a reviewer is deciding on: what happens, to what, and across which boundary. */
    describePathAction(
        compute: Compute,
        path: string,
        operation: string,
        options: { readonly write?: boolean } = {},
    ): string {
        return describeComputePathAction(compute, path, operation, options);
    }

    /** Dispose every cached compute when the owning host shuts down. */
    async dispose(ctx: Context): Promise<void> {
        if (this.#disposePromise !== undefined) return await this.#disposePromise;
        this.#closed = true;
        this.#disposePromise = (async () => {
            for (const { compute } of this.#computes.values()) this.#processes.detach(compute);
            await this.#processes.drain();
            await Promise.allSettled([...this.#activeOperations]);
            const cached = [...this.#computes.values()];
            this.#computes.clear();
            this.#promptedAbortNotices.clear();
            this.#sharedKV = undefined;
            const reviewer = this.#reviewer;
            this.#reviewer = undefined;
            await Promise.all([
                ...cached.map(async ({ compute }) => await compute.dispose(ctx)),
                ...(reviewer === undefined ? [] : [reviewer.dispose(ctx)]),
            ]);
            this.#processes.clear();
        })();
        return await this.#disposePromise;
    }

    /**
     * The fixed, read-only tool array the automatic permission reviewer runs with, over a machine
     * this module keeps for the reviewer alone.
     *
     * This is the reviewer counterpart to the `tools` hook, but it is a method rather than a hook:
     * the reviewer lives in its own private agent system that this `ComputeModule` never serves, so
     * it asks for its tools here instead of being served them. The machine behind them is created
     * once, on the same provider and under the same boundary policy every agent's machine is, in
     * the folder this installation works in; it is not one of the per-agent machines and is
     * disposed with this module. The vendor is the reviewer's own model route — a Claude review
     * gets Claude's read-only tools, a Codex review Codex's — chosen from `scope.agent.model`
     * exactly as an ordinary agent's tools are chosen from its model, so the reviewer sees the tool
     * names it was trained on. Read bookkeeping uses the reviewer's own read-lock map, under the
     * reviewer's own agent ID and store, so a reviewer's file reads stay consistent among
     * themselves without touching any main agent's read log.
     */
    async reviewerTools(ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> {
        const compute = await this.#reviewerCompute(ctx);
        const reads = new FileReadLog(scope.kv, this.#reviewerReadLocks, scope.agent.id);
        return assembleReviewerTools(vendorFor(scope), compute, reads);
    }

    /** The reviewer's own machine, created on first use and kept for as long as this module runs. */
    async #reviewerCompute(ctx: Context): Promise<HostCompute> {
        const existing = this.#reviewer;
        if (existing !== undefined) return existing;
        return await this.#track(
            this.#computeLocks.runInLock(ctx, REVIEWER_COMPUTE_KEY, async (lockCtx) => {
                if (this.#closed) throw new Error("Compute module is closed.");
                const cached = this.#reviewer;
                if (cached !== undefined) return cached;
                const { compute } = await this.#create(
                    lockCtx,
                    {
                        cwd: this.#config.configuration.paths.publicHome,
                    },
                    "compute.permission-reviewer",
                );
                if (this.#closed) {
                    await compute.dispose(lockCtx);
                    throw new Error("Compute module is closed.");
                }
                this.#reviewer = compute;
                return compute;
            }),
        );
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            // Agent Base always supplies the shared store. Keeping this guard preserves the hook's
            // use in small host-side probes that only ask for static vendor instructions.
            const sharedKV = scope.sharedKV;
            if (sharedKV !== undefined) this.#sharedKV = sharedKV;
            const compute = await this.resolve(ctx, scope.agent.id);
            if (compute === undefined) return "";
            const rawNotice =
                sharedKV === undefined
                    ? undefined
                    : await abortNoticeStore(sharedKV, scope.agent.id).read(ctx, ABORT_NOTICE_KEY);
            let notice = "";
            if (rawNotice === undefined) {
                this.#promptedAbortNotices.delete(scope.agent.id);
            } else {
                if (!Value.Check(computeAbortNoticeSchema, rawNotice)) {
                    throw new Error("Stored compute abort notice is invalid.");
                }
                const parsed = rawNotice as ComputeAbortNotice;
                this.#promptedAbortNotices.set(scope.agent.id, parsed.id);
                notice = formatAbortNotice(parsed);
            }
            return [notice, computeInstructionsForVendor(vendorFor(scope))]
                .filter((part) => part.length > 0)
                .join("\n\n");
        },

        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            this.#sharedKV = scope.sharedKV;
            const compute = await this.resolve(ctx, scope.agent.id);
            if (compute === undefined) return [];
            const reads = new FileReadLog(scope.kv, this.#readLocks, scope.agent.id);
            return assembleComputeTools(vendorFor(scope), compute, reads);
        },

        beforeInferenceTransact: async (ctx: Context, scope: AgentModuleScope): Promise<void> => {
            this.#sharedKV = scope.sharedKV;
            const promptedId = this.#promptedAbortNotices.get(scope.agent.id);
            if (promptedId === undefined) return;
            const store = abortNoticeStore(scope.sharedKV, scope.agent.id);
            const rawNotice = await store.read(ctx, ABORT_NOTICE_KEY);
            if (rawNotice !== undefined && !Value.Check(computeAbortNoticeSchema, rawNotice)) {
                throw new Error("Stored compute abort notice is invalid.");
            }
            if (rawNotice !== undefined && rawNotice.id === promptedId) {
                await store.delete(ctx, ABORT_NOTICE_KEY);
            }
            if (this.#promptedAbortNotices.get(scope.agent.id) === promptedId) {
                this.#promptedAbortNotices.delete(scope.agent.id);
            }
        },

        agentCreatedTransact: async (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: { readonly id: string },
        ): Promise<void> => {
            this.#sharedKV = scope.sharedKV;
            await abortNoticeStore(scope.sharedKV, agent.id).delete(ctx, ABORT_NOTICE_KEY);
        },

        agentRestoredTransact: (_ctx: Context, scope: AgentModuleSystemScope): void => {
            this.#sharedKV = scope.sharedKV;
        },

        agentArchivedTransact: async (
            ctx: Context,
            scope: AgentModuleSystemScope,
            agent: { readonly id: string },
        ): Promise<void> => {
            this.#sharedKV = scope.sharedKV;
            await abortNoticeStore(scope.sharedKV, agent.id).delete(ctx, ABORT_NOTICE_KEY);
        },

        agentArchived: async (
            ctx: Context,
            _scope: AgentModuleSystemScope,
            agent: { readonly id: string },
        ): Promise<void> => {
            await this.archiveAgent(ctx, agent.id);
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    async #track<Result>(operation: Promise<Result>): Promise<Result> {
        this.#activeOperations.add(operation);
        try {
            return await operation;
        } finally {
            this.#activeOperations.delete(operation);
        }
    }

    /**
     * What this installation calls its own, in the compute package's terms.
     *
     * The private root holds the agent's credentials and databases, so a restricted command may not
     * read it for the same reason it may not read a person's `.ssh`. The protected project files are
     * the ones that decide what later commands may do — the instruction and security documents, and
     * whatever else the configuration names — so they sit above the boundary rather than inside it.
     */
    get hostPolicy(): ComputeHostPolicy {
        const values = this.#config.configuration.values;
        return {
            privateDirectories: [this.#config.configuration.paths.agentHome],
            protectedProjectFiles: [
                ...new Set([
                    "AGENTS.md",
                    "AGENTS_SECURITY.md",
                    "happy.toml",
                    "mcp.toml",
                    ...values.permissions.protectedPaths,
                    ...values.workspace.protectedSync,
                ]),
            ],
        };
    }

    async #create(
        ctx: Context,
        config: AgentComputeConfig,
        lifetimeName: string,
        agentId?: string,
    ): Promise<{
        readonly compute: HostCompute;
        readonly processContext: Context;
        readonly processManager: NativeProcessManager | undefined;
    }> {
        const providerConfig: HostComputeConfig = {
            cwd: config.cwd,
            hostPolicy: this.hostPolicy,
        };
        const detachedProcessContext = detach(ctx).named(lifetimeName);
        const database = agentDatabase(ctx);
        const processContext =
            database === undefined
                ? detachedProcessContext
                : withAgentDatabase(detachedProcessContext, database);
        const processManager =
            this.#provider === undefined ? new NativeProcessManager(processContext) : undefined;
        const compute =
            processManager === undefined
                ? await this.#provider!.create(ctx, providerConfig)
                : createHostCompute({
                      ctx: processContext,
                      ...providerConfig,
                      processManager,
                  });
        const candidate = runtimeCompute(compute);
        if (!Value.Check(hostComputeSchema, candidate)) {
            if (typeof compute.dispose === "function") await compute.dispose(ctx);
            throw new Error("Host compute provider returned an invalid compute.");
        }
        if (
            compute.cwd !== config.cwd ||
            compute.fs.cwd !== config.cwd ||
            compute.shell.cwd !== config.cwd
        ) {
            await compute.dispose(ctx);
            throw new Error("Host compute provider returned mismatched working directories.");
        }
        const validatedCompute = compute as HostCompute;
        if (processManager === undefined) {
            return { compute: validatedCompute, processContext, processManager: undefined };
        }
        const originalDispose = validatedCompute.dispose.bind(validatedCompute);
        const shell =
            agentId === undefined || database === undefined
                ? validatedCompute.shell
                : createAttachedSecretsHostShell({
                      agentId,
                      ctx: processContext,
                      cwd: config.cwd,
                      hostPolicy: this.hostPolicy,
                      processManager,
                      ...(config.secretScope === undefined
                          ? {}
                          : { targetScope: config.secretScope }),
                      secrets: this.#secrets,
                  });
        const hostCompute: HostCompute = {
            ...validatedCompute,
            shell,
            async dispose(disposeCtx: Context): Promise<void> {
                await shell.killAllSessions?.();
                await originalDispose(disposeCtx);
                await processManager.killAll(processContext, {
                    forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
                    includeDetached: true,
                });
            },
        };
        return { compute: hostCompute, processContext, processManager };
    }

    /** A process whose spawn crosses an abort boundary is part of that abort, not the next turn. */
    #guardSessionStarts(agentId: string, cached: CachedCompute): void {
        const shell = cached.compute.shell;
        const originalStart = shell.startSession;
        shell.startSession = async (options) => {
            const generation = cached.abortGeneration;
            const sessionId = await originalStart.call(shell, options);
            if (cached.abortGeneration !== generation) {
                try {
                    await this.#storeAbortNotice(
                        cached.processContext,
                        agentId,
                        this.abortSnapshot(agentId),
                    );
                } catch (error: unknown) {
                    cached.processContext.log.error(
                        "Compute could not record a late abort process notice.",
                        { agentId },
                        error,
                    );
                }
                await this.#hardKillCached(cached.processContext, agentId, cached);
            }
            return sessionId;
        };
    }

    /** Make public state terminal first, then send an uncatchable signal to every whole group. */
    async #hardKillCached(ctx: Context, agentId: string, cached: CachedCompute): Promise<void> {
        this.#processes.exitAll(agentId, cached.compute);
        const processManager = cached.processManager;
        if (processManager === undefined) {
            await cached.compute.shell.killAllSessions?.();
            return;
        }
        const processGroups = [...processManager.pendingProcessGroups()];
        await Promise.all(
            processGroups.map(
                async (processGroupId) => await killProcessGroup(ctx, processGroupId, "SIGKILL"),
            ),
        );
    }
}

/** One-shot system-prompt prefix for the first inference after an abort killed processes. */
function formatAbortNotice(notice: ComputeAbortNotice): string {
    const processWord = notice.processTrees === 1 ? "tree" : "trees";
    const sessionLines = notice.sessions.map(
        ({ command, sessionId }) =>
            `- shell session ${String(sessionId)}: ${JSON.stringify(command)}`,
    );
    const omitted = Math.max(0, notice.processTrees - notice.sessions.length);
    return [
        `The previous abort hard-killed ${String(notice.processTrees)} background process ${processWord} owned by this agent with SIGKILL.`,
        ...sessionLines,
        ...(omitted === 0
            ? []
            : [`- ${String(omitted)} additional process ${omitted === 1 ? "tree" : "trees"}`]),
    ].join("\n");
}

function boundedAbortNoticeCommand(command: string): string {
    if (command.length <= MAX_ABORT_NOTICE_COMMAND_LENGTH) return command;
    return `${command.slice(0, MAX_ABORT_NOTICE_COMMAND_LENGTH - 1)}…`;
}

/** One affected agent's namespace inside Compute's collection-wide durable store. */
function abortNoticeStore(sharedKV: AgentKV, agentId: string): AgentKV {
    return sharedKV.scoped(ABORT_NOTICES_SCOPE, agentId);
}

/** Whose tools this agent's model was trained on, which is what it should be handed. */
function vendorFor(scope: AgentModuleScope): ComputeToolVendor {
    return computeToolVendor({
        model: scope.agent.model,
        ...(scope.agent.providerKind === undefined
            ? {}
            : { providerKind: scope.agent.providerKind }),
    });
}

function runtimeCompute(compute: Compute): unknown {
    return {
        id: compute.id,
        kind: compute.kind,
        cwd: compute.cwd,
        fs: compute.fs,
        shell: compute.shell,
        dispose: compute.dispose,
    };
}
