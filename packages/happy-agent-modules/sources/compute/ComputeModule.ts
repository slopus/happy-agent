import {
    agentDatabase,
    agentMetadata,
    agentModuleConfig,
    cuid2Schema,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentModuleSystemScope,
    type AgentSystemRef,
    type AgentConfig,
    type AnyAgentTool,
    withAgentDatabase,
} from "@slopus/happy-agent-base";
import {
    createDockerCompute,
    createHostCompute,
    createHostNetwork,
    HOST_SESSION_STOP_GRACE_MS,
    hostComputeProvider,
    killProcessGroup,
    NativeProcessManager,
    type Compute,
    type ComputeConnectOptions,
    type ComputeHostPolicy,
    type ComputeNetwork,
    type HostComputeConfig,
} from "@slopus/happy-agent-compute";
import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { detach, mapAsyncLock, type Context, type MapAsyncLock } from "@steve.kite/stdlib";
import type { PlatformPath } from "node:path";
import type { Duplex } from "node:stream";

import type { BotSettingsModule } from "../botSettings/index.js";
import type { ChatMediaModule } from "../chatMedia/index.js";
import type { ChatUiModule } from "../chatUi/index.js";
import type { ConfigModule } from "../config/index.js";
import type { RunnerProductFiles, RunnersModule } from "../runners/index.js";
import { FileReadLog } from "../impl/FileReadLog.js";
import { machinePaths } from "../impl/machinePaths.js";
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
import { agentNetworkId, HOST_NETWORK_ID, RUNNER_NETWORK_PREFIX } from "./impl/agentNetworkId.js";
import { computeInstructionsForVendor } from "./impl/computeInstructionsForVendor.js";
import { computePermissionsForContext } from "./impl/computePermissionsForContext.js";
import { createAttachedSecretsHostShell } from "./impl/createAttachedSecretsHostShell.js";
import { describeComputePathAction } from "./impl/describeComputePathAction.js";
import { forwardAttachedSecrets } from "./impl/forwardAttachedSecrets.js";
import { refuseAttachedSecrets } from "./impl/refuseAttachedSecrets.js";
import {
    basenameComputePath,
    parentComputePath,
    resolveComputePath,
} from "./impl/resolveComputePath.js";
import { shouldReviewComputePath } from "./impl/shouldReviewComputePath.js";
import { withConfiguredNetwork } from "./impl/withConfiguredNetwork.js";
import { assembleComputeTools } from "./tools/assembleComputeTools.js";
import { presentFilesTool } from "./tools/present_files.js";
import { contributeMediaComponent } from "./impl/mediaComponent.js";
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

/**
 * The machine resolved for one agent: this computer, a runner, or a container on either. Every
 * module and tool serving the agent is written against the same interface whichever it is.
 */
export type HostCompute = Compute;

export const hostComputeSchema = Type.Unsafe<HostCompute>(
    Type.Object(
        {
            id: Type.Literal("host"),
            kind: Type.Literal("host"),
            cwd: Type.String({ minLength: 1 }),
            fs: computeFileSystemSchema,
            shell: computeShellSchema,
            services: Type.Optional(
                Type.Object(
                    { start: callableSchema, reconcile: callableSchema, dispose: callableSchema },
                    exact,
                ),
            ),
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
        /** The runner the agent's folder is on; absent when it is on this machine. */
        runnerId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" })),
        /** Run the agent's files and commands in a container of this image, the folder mounted. */
        docker: Type.Optional(
            Type.Object(
                {
                    image: Type.String({
                        minLength: 1,
                        maxLength: 512,
                        pattern: "^[^\\u0000-\\u0020]+$",
                    }),
                },
                exact,
            ),
        ),
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
    closing: boolean;
    readonly cwd: string;
    readonly compute: HostCompute;
    /** The network this machine was built to leave from; see {@link agentNetworkId}. */
    readonly networkId: string;
    /** Connections opened from this machine on the product's behalf, ended with the machine. */
    readonly connections: Set<Duplex>;
    readonly processContext: Context;
    readonly processManager: NativeProcessManager | undefined;
}

/** Opens connections from one network; refuses once that network is no longer served. */
export type ComputeConnector = (ctx: Context, options: ComputeConnectOptions) => Promise<Duplex>;

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
    readonly #runners: RunnersModule | undefined;
    readonly #botSettings: BotSettingsModule | undefined;
    readonly #chatMedia: ChatMediaModule | undefined;
    /** Present only for the named alternate construction used by scripted machines. */
    #provider: HostComputeProvider | undefined;
    readonly #computes = new Map<string, CachedCompute>();
    /** Only filesystems constructed here may share a native discovery identity. */
    readonly #nativeFileSystemIdentities = new WeakMap<object, string>();
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
    /** Raised once, when the daemon starts draining; see {@link releaseOutputWaits}. */
    readonly #outputWaits = new AbortController();
    /**
     * Machines reached through a runner's transport. Their output reads are never released: a
     * runner request cancelled mid-wait is rejected here while the runner has already consumed
     * the output it would have answered with, so releasing it would lose that output. They keep
     * waiting as they always have. Every other machine is this process's own shell, which answers
     * a released wait with what it read.
     */
    readonly #runnerMachines = new WeakSet<Compute>();
    /** Compute's one durable store shared by every agent in this collection. */
    #sharedKV: AgentKV | undefined;
    /** Read when a machine is about to be built, to refuse one for an archived agent. */
    #agents: AgentSystemRef | undefined;
    #closed = false;
    #disposePromise: Promise<void> | undefined;

    /**
     * @param runners Where an agent's folder is when it is not on this machine. An agent whose
     * configuration names a runner gets a machine there; without this module, it gets none.
     * @param botSettings Where a bot runs the agents it governs. A bot that chooses Docker gets
     * each governed agent's machine built in a container of its image, on the machine that holds
     * the agent's folder. Without this module, no agent's machine is chosen by a bot.
     * @param chatMedia Where files the agent shows the user are kept. With it, every agent gets
     * `present_files`, and an image the agent reads is shown to the user as well. Without it,
     * nothing on the machine is shown in the chat.
     * @param chatUi Where the `media` component is served. With it and chat media, `show_ui` can
     * show files from the agent's machine together.
     */
    constructor(
        config: ConfigModule,
        secrets: SecretsModule,
        runners?: RunnersModule,
        botSettings?: BotSettingsModule,
        chatMedia?: ChatMediaModule,
        chatUi?: ChatUiModule,
    ) {
        if (chatUi !== undefined && chatMedia !== undefined) {
            contributeMediaComponent(chatUi, this, chatMedia);
        }
        this.#config = config;
        this.#secrets = secrets;
        this.#runners = runners;
        this.#botSettings = botSettings;
        this.#chatMedia = chatMedia;
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
        runners?: RunnersModule,
        botSettings?: BotSettingsModule,
        chatMedia?: ChatMediaModule,
        chatUi?: ChatUiModule,
    ): ComputeModule {
        const candidate = { id: provider.id, create: provider.create };
        if (!Value.Check(hostComputeProviderSchema, candidate)) {
            throw new Error("The host compute provider is invalid.");
        }
        const module = new ComputeModule(config, secrets, runners, botSettings, chatMedia, chatUi);
        module.#provider = provider;
        return module;
    }

    /**
     * The runner an agent's folder is on, read from its configuration; undefined for a folder on
     * this machine or an agent with no compute. Work the product does for the agent's folder, such
     * as starting its MCP servers, runs on that runner.
     */
    runnerOf(config: AgentConfig): string | undefined {
        const raw = config.modules?.[this.name];
        return Value.Check(agentComputeConfigSchema, raw) ? raw.runnerId : undefined;
    }

    /**
     * The path rules of the machine the agent owning this context works on: a runner's when its
     * folder is on one, which may run another platform than this daemon, otherwise this machine's.
     */
    paths(ctx: Context): PlatformPath {
        const raw = agentModuleConfig(ctx, this.name);
        const runnerId = Value.Check(agentComputeConfigSchema, raw) ? raw.runnerId : undefined;
        return this.#runners?.paths(runnerId) ?? machinePaths(process.platform);
    }

    /**
     * Resolve the exact compute cached for this agent, or no compute when none was configured or
     * the agent is archived.
     */
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
                    if (existing.closing) throw new Error("This agent's compute is closing.");
                    if (existing.cwd !== config.cwd) {
                        throw new Error("An agent's cached compute configuration cannot change.");
                    }
                    return existing.compute;
                }
                // Archival ended this agent's machine. Reading the archived agent, such as its
                // slash commands, must not build another one and serve its network again. The
                // stored metadata decides, because a caller that waited here while archival held
                // the lock carries the configuration from before it.
                const metadata =
                    this.#agents === undefined
                        ? agentMetadata(lockCtx)
                        : (await this.#agents.config(lockCtx, agentId))?.metadata;
                if (typeof metadata?.["archivedAt"] === "number") return undefined;

                // A bot's compute setting is read only while the machine is built: a running
                // machine is never moved, so a change reaches it the next time it starts.
                const effective = await this.#withBotCompute(lockCtx, config, agentId);
                // Work on this machine runs as a workload user once one is configured, and never
                // inside this daemon; a bot with a Linux user of its own runs as that one.
                const user =
                    effective.runnerId === undefined
                        ? await this.#runners?.userFor(lockCtx, agentId)
                        : undefined;
                const here =
                    effective.runnerId === undefined &&
                    effective.docker === undefined &&
                    user === undefined;
                const created = here
                    ? await this.#createHere(lockCtx, effective, agentId)
                    : await this.#createElsewhere(lockCtx, effective, agentId, user);
                const { compute } = created;
                if (this.#closed) {
                    await compute.dispose(lockCtx);
                    throw new Error("Compute module is closed.");
                }
                const cached: CachedCompute = {
                    abortGeneration: 0,
                    closing: false,
                    cwd: config.cwd,
                    compute,
                    networkId: agentNetworkId(agentId, effective),
                    connections: new Set(),
                    processContext: created.processContext,
                    processManager: created.processManager,
                };
                // Only machines this daemon's own compute sandboxes get the policy. A runner may run
                // an older compute that would drop denied hosts and ports while keeping the grant,
                // and its project file is on the runner. The Windows supervisor has no host-list
                // proxy, so a policy there would refuse every restricted command.
                if (!this.#runnerMachines.has(compute) && !(here && process.platform === "win32")) {
                    this.#applyConfiguredNetwork(cached);
                }
                this.#guardSessionStarts(agentId, cached);
                this.#computes.set(agentId, cached);
                this.#processes.attach(agentId, compute);
                return compute;
            }),
        );
    }

    /**
     * Open connections from one agent's own machine: this computer, its runner, or its container.
     *
     * The context must carry the agent's configuration, as for {@link resolve}; the machine is
     * started now if it is not running yet. Every connection the returned function opens comes from
     * that exact machine and is ended when the agent is archived or this module is disposed. Once
     * the machine is gone, the function refuses instead of starting another one.
     */
    async network(ctx: Context, agentId: string): Promise<ComputeConnector> {
        const compute = await this.resolve(ctx, agentId);
        if (compute?.network === undefined) throw machineWithoutNetwork();
        return this.#connector(agentId, compute, compute.network);
    }

    /**
     * The network one agent's machine leaves from, so a browser can keep its state per network.
     *
     * The context must carry the agent's configuration, as for {@link resolve}; the machine is
     * resolved now. The name comes from the machine actually built, not the current settings: every
     * agent on this computer shares one, every agent on a runner shares the runner's, and an agent
     * in a container has one of its own that changes only when its container's environment does.
     */
    async networkId(ctx: Context, agentId: string): Promise<string> {
        const compute = await this.resolve(ctx, agentId);
        if (compute?.network === undefined) throw machineWithoutNetwork();
        const cached = this.#computes.get(agentId);
        if (cached === undefined || cached.compute !== compute || cached.closing) {
            throw machineStopped();
        }
        return cached.networkId;
    }

    /**
     * Open connections in the network a {@link networkId} names, or `undefined` when it is not
     * served now.
     *
     * This computer's and a runner's networks belong to the machine, not to any agent: they are
     * served while work runs there, whichever agents have come and gone. A container's network is
     * served only while the agent's machine that named it is running, and its connections end with
     * that machine. Nothing here starts a machine or falls back to another network.
     */
    async namedNetwork(networkId: string): Promise<ComputeConnector | undefined> {
        if (this.#closed) return undefined;
        if (networkId === HOST_NETWORK_ID) {
            if (this.#runners?.localExecution === false) return undefined;
            return await this.#machineNetwork(undefined);
        }
        if (networkId.startsWith(RUNNER_NETWORK_PREFIX)) {
            const runnerId = networkId.slice(RUNNER_NETWORK_PREFIX.length);
            if (this.#runners?.has(runnerId) !== true) return undefined;
            return await this.#machineNetwork(runnerId);
        }
        for (const [agentId, cached] of this.#computes) {
            if (cached.networkId !== networkId || cached.closing) continue;
            if (cached.compute.network === undefined) throw machineWithoutNetwork();
            return this.#connector(agentId, cached.compute, cached.compute.network);
        }
        return undefined;
    }

    /**
     * Connections from this computer or a runner, asked of its product machine on every connection
     * since a runner may have reconnected. The machine is checked now, so a runner that is away is
     * refused here instead of on every connection.
     */
    async #machineNetwork(runnerId: string | undefined): Promise<ComputeConnector> {
        const runners = this.#runners;
        if (runners === undefined) {
            const network = createHostNetwork();
            return async (connectCtx, options) => await network.connect(connectCtx, options);
        }
        const reachable = async (): Promise<ComputeNetwork> => {
            const network = (await runners.machine(runnerId)).network;
            if (network === undefined) throw machineWithoutNetwork();
            return network;
        };
        await reachable();
        return async (connectCtx, options) =>
            await (await reachable()).connect(connectCtx, options);
    }

    /** Connections from one agent's exact machine, ended with it and refused once it is gone. */
    #connector(agentId: string, compute: HostCompute, network: ComputeNetwork): ComputeConnector {
        const current = (): CachedCompute => {
            const cached = this.#computes.get(agentId);
            if (cached === undefined || cached.compute !== compute || cached.closing) {
                throw machineStopped();
            }
            return cached;
        };
        return async (connectCtx, options) => {
            current();
            const connection = await network.connect(connectCtx, options);
            let cached: CachedCompute;
            try {
                cached = current();
            } catch (error) {
                connection.destroy();
                throw error;
            }
            cached.connections.add(connection);
            connection.once("close", () => cached.connections.delete(connection));
            return connection;
        };
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
    async hardKillAgentProcesses(_ctx: Context, agentId: string): Promise<void> {
        const cached = this.#computes.get(agentId);
        if (cached === undefined) return;
        cached.abortGeneration += 1;
        await this.#hardKillCached(cached.processContext, agentId, cached);
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
        return await this.#processes.stop(ctx, agentId, processId);
    }

    /** Ends one archived agent's machine and every background process it still owns. */
    async archiveAgent(ctx: Context, agentId: string): Promise<void> {
        this.#promptedAbortNotices.delete(agentId);
        await this.#track(
            this.#computeLocks.runInLock(ctx, agentId, async (lockCtx) => {
                if (this.#closed) return;
                const cached = this.#computes.get(agentId);
                if (cached === undefined) return;
                cached.closing = true;
                cached.abortGeneration += 1;
                endConnections(cached);
                await this.#processes.drain();
                await cached.compute.dispose(lockCtx);
                this.#processes.exitAll(agentId, cached.compute);
                this.#processes.detach(cached.compute);
                this.#computes.delete(agentId);
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
     * Where the agent's machine keeps the product documentation and skills its agents read, when
     * a runner serves it — on another computer, or as a workload user on this one. Undefined for
     * a machine this daemon serves itself, whose agents read the daemon's own copies.
     */
    productFiles(ctx: Context, compute: Compute): RunnerProductFiles | undefined {
        const home = compute.fs.home;
        if (this.#runners === undefined || home === undefined) return undefined;
        if (!this.#runnerMachines.has(compute)) return undefined;
        return this.#runners.productFilesOn(home, this.paths(ctx));
    }

    /**
     * Identity for sharing concurrent read-only discovery. Native machines with the same working
     * directory, home, and host policy see the same filesystem. Alternate providers remain scoped
     * to the exact filesystem object: matching `id`, `kind`, or paths do not prove shared storage.
     * Callers must additionally key by the complete per-operation permissions.
     */
    fileSystemIdentity(compute: HostCompute): object | string {
        return this.#nativeFileSystemIdentities.get(compute.fs) ?? compute.fs;
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

    /**
     * Stop every read that is only waiting for a background command to say more.
     *
     * A drain lets each running tool finish, and an output read with a long wait would hold the
     * reload open until that wait ran out while the command itself kept running. Each such read
     * now answers at once with what the command has said so far, through its ordinary result, so
     * nothing it consumed is lost. The command keeps running. Reads that start later answer
     * without waiting. Commands, typed input, and every other tool are unaffected, and so are
     * reads on a runner's machine; see {@link #runnerMachines}.
     */
    releaseOutputWaits(): void {
        this.#outputWaits.abort(
            new Error("Happy Agent is restarting, so this read stopped waiting for more output."),
        );
    }

    /** The release signal for one machine's output reads, or none for a runner's machine. */
    #outputWaitsFor(compute: Compute): AbortSignal | undefined {
        return this.#runnerMachines.has(compute) ? undefined : this.#outputWaits.signal;
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
            for (const entry of cached) endConnections(entry);
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
        return assembleReviewerTools(
            vendorFor(scope),
            compute,
            reads,
            this.#outputWaitsFor(compute),
        );
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
                const compute = await this.#createReviewer(lockCtx);
                if (this.#closed) {
                    await compute.dispose(lockCtx);
                    throw new Error("Compute module is closed.");
                }
                this.#reviewer = compute;
                return compute;
            }),
        );
    }

    /**
     * The reviewer investigates where agents work. While the daemon runs work itself, that is this
     * installation's public folder; once a workload user is configured, the reviewer's reads and
     * read-only commands run in that user's runner, from its home, like every agent's.
     */
    async #createReviewer(ctx: Context): Promise<HostCompute> {
        const runners = this.#runners;
        const user = runners?.workloadUser;
        if (runners === undefined || user === undefined) {
            const { compute } = await this.#create(
                ctx,
                { cwd: this.#config.configuration.paths.publicHome },
                "compute.permission-reviewer",
            );
            return compute;
        }
        await runners.machine(undefined);
        const home = runners.machineHome(undefined)?.home as string;
        const compute = await runners.localAgentMachine(
            detach(ctx).named("compute.permission-reviewer"),
            {
                user,
                agentId: "",
                computeId: "permission-reviewer",
                cwd: home,
                policy: {
                    protectedProjectFiles: [...(this.hostPolicy.protectedProjectFiles ?? [])],
                },
            },
        );
        const reviewer = refuseAttachedSecrets(compute);
        this.#runnerMachines.add(reviewer);
        return reviewer;
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
            return [notice, computeInstructionsForVendor(vendorFor(scope), compute)]
                .filter((part) => part.length > 0)
                .join("\n\n");
        },

        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            this.#sharedKV = scope.sharedKV;
            const compute = await this.resolve(ctx, scope.agent.id);
            if (compute === undefined) return [];
            const reads = new FileReadLog(scope.kv, this.#readLocks, scope.agent.id);
            const vendorTools = assembleComputeTools(
                vendorFor(scope),
                compute,
                reads,
                this.#outputWaitsFor(compute),
                this.#chatMedia,
            );
            // Showing a file is the same for every model, so it joins whichever array was chosen.
            return this.#chatMedia === undefined
                ? vendorTools
                : [...vendorTools, presentFilesTool(compute, this.#chatMedia)];
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

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

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
                    ...(process.platform === "win32"
                        ? [".agents", ".codex", ".gitconfig", ".gitmodules"]
                        : []),
                    ...values.permissions.protectedPaths,
                    ...values.workspace.protectedSync,
                ]),
            ],
        };
    }

    /**
     * The agent's own configuration with its bot's compute choice applied. A workspace that
     * already runs in Docker keeps its own image; otherwise a bot that chooses Docker puts the
     * agent's folder in a container of the bot's image, on whichever machine holds that folder.
     */
    async #withBotCompute(
        ctx: Context,
        config: AgentComputeConfig,
        agentId: string,
    ): Promise<AgentComputeConfig> {
        if (this.#botSettings === undefined || config.docker !== undefined) return config;
        if (agentDatabase(ctx) === undefined) {
            throw new Error("Compute cannot read the governing bot's settings without a database.");
        }
        const setting = await this.#botSettings.compute(ctx, agentId);
        return setting.type === "docker" ? { ...config, docker: { image: setting.image } } : config;
    }

    /** An agent's machine on this computer, refused once runners are configured. */
    async #createHere(
        ctx: Context,
        config: AgentComputeConfig,
        agentId: string,
    ): Promise<{
        readonly compute: HostCompute;
        readonly processContext: Context;
        readonly processManager: NativeProcessManager | undefined;
    }> {
        this.#runners?.assertLocalExecution();
        return await this.#create(ctx, config, `compute.agent.${agentId}`, agentId);
    }

    /**
     * An agent's machine somewhere else: on the runner its folder is on, in the runner of the
     * Linux user its work runs as on this computer, or in a container of the workspace's image on
     * either. The machine is built before this resolves, so a runner that is away, a workload user
     * whose runner cannot start, or a missing Docker fails here, naming what is missing.
     */
    async #createElsewhere(
        ctx: Context,
        config: AgentComputeConfig,
        agentId: string,
        user: string | undefined,
    ): Promise<{
        readonly compute: HostCompute;
        readonly processContext: Context;
        readonly processManager: NativeProcessManager | undefined;
    }> {
        const detachedProcessContext = detach(ctx).named(`compute.agent.${agentId}`);
        const database = agentDatabase(ctx);
        const processContext =
            database === undefined
                ? detachedProcessContext
                : withAgentDatabase(detachedProcessContext, database);
        let compute: Compute;
        let onRunner = true;
        const policy = {
            protectedProjectFiles: [...(this.hostPolicy.protectedProjectFiles ?? [])],
        };
        if (config.runnerId === undefined && user !== undefined) {
            compute = await this.#runners!.localAgentMachine(processContext, {
                user,
                agentId,
                cwd: config.cwd,
                policy,
                ...(config.docker === undefined ? {} : { docker: config.docker }),
            });
        } else if (config.runnerId !== undefined) {
            if (this.#runners === undefined) {
                throw new Error(
                    "This agent works on a runner, but runners are not available here.",
                );
            }
            compute = await this.#runners.agentMachine(processContext, {
                runnerId: config.runnerId,
                agentId,
                cwd: config.cwd,
                policy,
                ...(config.docker === undefined ? {} : { docker: config.docker }),
            });
        } else {
            this.#runners?.assertLocalExecution();
            onRunner = false;
            compute = createDockerCompute({
                docker: {
                    image: config.docker!.image,
                    workingDirectory: config.cwd,
                    mounts: [{ source: config.cwd, target: config.cwd }],
                },
                sessionId: `agent-${agentId}`,
                hostPolicy: this.hostPolicy,
            });
        }
        if (compute.cwd !== config.cwd) {
            await compute.dispose(ctx);
            throw new Error("The agent's machine opened in another folder.");
        }
        // A runner takes a command's secrets with that command; a container cannot.
        const machine =
            config.docker !== undefined || database === undefined
                ? refuseAttachedSecrets(compute)
                : forwardAttachedSecrets(compute, {
                      agentId,
                      ctx: processContext,
                      secrets: this.#secrets,
                      ...(config.secretScope === undefined
                          ? {}
                          : { targetScope: config.secretScope }),
                  });
        if (onRunner) this.#runnerMachines.add(machine);
        return {
            compute: machine,
            processContext,
            processManager: undefined,
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
        this.#nativeFileSystemIdentities.set(
            validatedCompute.fs,
            JSON.stringify({
                cwd: validatedCompute.cwd,
                home: validatedCompute.fs.home,
                hostPolicy: providerConfig.hostPolicy,
            }),
        );
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
                const failures: unknown[] = [];
                try {
                    await shell.killAllSessions?.();
                } catch (error: unknown) {
                    failures.push(error);
                }
                try {
                    await originalDispose(disposeCtx);
                } catch (error: unknown) {
                    failures.push(error);
                }
                try {
                    await processManager.killAll(processContext, {
                        forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
                        includeDetached: true,
                    });
                } catch (error: unknown) {
                    failures.push(error);
                }
                if (failures.length > 0)
                    throw new AggregateError(failures, "Compute cleanup is not confirmed.");
            },
        };
        return { compute: hostCompute, processContext, processManager };
    }

    /**
     * Gives every restricted command on this machine the person's configured network policy,
     * reread before each command so a change reaches the next one without a restart.
     */
    #applyConfiguredNetwork(cached: CachedCompute): void {
        const shell = cached.compute.shell;
        const originalRun = shell.run;
        const originalStart = shell.startSession;
        const configured = async (permissions: ComputePermissions) =>
            permissions.mode === "auto" || permissions.mode === "workspace_write"
                ? withConfiguredNetwork(permissions, await this.#config.networkPolicy(cached.cwd))
                : permissions;
        shell.run = async (options) =>
            await originalRun.call(shell, {
                ...options,
                permissions: await configured(options.permissions),
            });
        shell.startSession = async (options) =>
            await originalStart.call(shell, {
                ...options,
                permissions: await configured(options.permissions),
            });
    }

    /** A process whose spawn crosses an abort boundary is part of that abort, not the next turn. */
    #guardSessionStarts(agentId: string, cached: CachedCompute): void {
        const shell = cached.compute.shell;
        const originalStart = shell.startSession;
        shell.startSession = async (options) => {
            if (cached.closing || this.#closed) throw new Error("This agent's compute is closing.");
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

    /** Immediately publish stopped shell rows and hard-kill every owned process group. */
    async #hardKillCached(ctx: Context, agentId: string, cached: CachedCompute): Promise<void> {
        this.#processes.exitAll(agentId, cached.compute);
        const processManager = cached.processManager;
        const kills =
            processManager === undefined
                ? [cached.compute.shell.killAllSessions?.()]
                : [...processManager.pendingProcessGroups()].map(
                      async (processGroupId) =>
                          await killProcessGroup(ctx, processGroupId, "SIGKILL"),
                  );
        const results = await Promise.allSettled(kills);
        const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
            throw new AggregateError(failures, "Process cleanup is not confirmed.");
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

function endConnections(cached: CachedCompute): void {
    for (const connection of cached.connections) connection.destroy();
    cached.connections.clear();
}

function machineWithoutNetwork(): Error {
    return Object.assign(new Error("This agent's machine cannot open network connections."), {
        code: "ENOTSUP",
    });
}

function machineStopped(): Error {
    return Object.assign(new Error("This agent's machine has stopped."), {
        code: "ECONNREFUSED",
    });
}

function runtimeCompute(compute: Compute): unknown {
    return {
        id: compute.id,
        kind: compute.kind,
        cwd: compute.cwd,
        fs: compute.fs,
        shell: compute.shell,
        ...(compute.services === undefined ? {} : { services: compute.services }),
        dispose: compute.dispose,
    };
}
