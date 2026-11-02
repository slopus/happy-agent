import { randomUUID, timingSafeEqual } from "node:crypto";
import { homedir, userInfo } from "node:os";
import type { PlatformPath } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
    agentDatabase,
    currentAgentEnvironment,
    withAgentDatabase,
    type AgentDatabase,
    type AgentEnvironment,
    type AgentModule,
    type AgentModuleHooks,
} from "@slopus/happy-agent-base";
import type { Runner, RunnerListResponse } from "@slopus/happy-agent-client";
import {
    createHostCompute,
    createRunnerCompute,
    RunnerLink,
    RunnerUnavailableError,
    type Compute,
    type RunnerChannel,
    type RunnerLinkStatus,
    type RunnerProjectPolicy,
} from "@slopus/happy-agent-compute";
import {
    afterCommit,
    asyncLock,
    createRootContext,
    detach,
    withLifetime,
    type Context,
    type RootContext,
} from "@steve.kite/stdlib";

import type { BotSettingsModule } from "../botSettings/index.js";
import type { ConfigModule } from "../config/index.js";
import { machinePaths } from "../impl/machinePaths.js";
import type { BinaryWebSocket } from "../transport/index.js";
import { LocalExecutionDisabledError } from "./LocalExecutionDisabledError.js";
import { createRunnersVersion } from "./createRunnersVersion.js";
import { canonicalMachinePath, futureMachinePath } from "./impl/canonicalMachinePath.js";
import { LocalUserRunner } from "./impl/LocalUserRunner.js";
import { runnerEnvironment } from "./impl/runnerEnvironment.js";
import { runOnMachine } from "./impl/runOnMachine.js";
import { sudoRunnerCommand } from "./impl/sudoRunnerCommand.js";
import { webSocketRunnerChannel } from "./impl/webSocketRunnerChannel.js";
import {
    RUNNER_CLOSE_FLUSH_MS,
    RUNNER_IDLE_TIMEOUT_MS,
    RUNNER_PING_INTERVAL_MS,
} from "./liveness.js";
import { runnerProductFiles, type RunnerProductFiles } from "./productFiles.js";
import type { RunnerRunOptions, RunnerRunResult } from "./RunnerRun.js";
import {
    queryRunnerSnapshot,
    runnersMigrations,
    saveRunnerSnapshot,
} from "./persistence/runnerSnapshot.js";

/** Where a folder lives: on this machine, or on the named runner. */
export interface RunnerLocation {
    readonly runnerId?: string;
}

export type RunnersListener = (ctx: Context, snapshot: RunnerListResponse) => void;

/** The compute ID of the machine Happy's own work runs on, one per runner. */
const PRODUCT_COMPUTE_ID = "happy-product";

/** How long startup waits for the workload user's runner before carrying on without it. */
const LOCAL_RUNNER_STARTUP_MS = 20_000;

/** A machine's home directory and platform, where folders that have no project are placed. */
export interface MachineHome {
    readonly home: string;
    readonly platform: NodeJS.Platform;
}

/** A bot as this module needs to know it: which agent is the bot's own. */
export interface RunnerBotIdentity {
    readonly id: string;
    readonly agentId: string;
}

/**
 * The runners this installation works on.
 *
 * A runner is a separate machine that holds project folders and runs everything that touches them,
 * while this daemon keeps the database, credentials, and inference. Runners are machine
 * configuration with fixed tokens; each one dials in through `GET /v0/runners/connect` and keeps
 * one connection open. Once any runner is configured nothing runs on this machine, unless
 * `[runners] default = "local"` keeps it the default: every module that touches a folder asks this
 * one for the folder's machine instead of reaching the local disk.
 */
export class RunnersModule implements AgentModule {
    readonly name = "runners";
    readonly migrations = runnersMigrations;
    readonly #config: ConfigModule;
    readonly #botSettings: BotSettingsModule | undefined;
    readonly #instanceId = randomUUID();
    readonly #links = new Map<string, RunnerLink>();
    readonly #products = new Map<string, Promise<Compute>>();
    /** Every runner WebSocket still open, until its transport has really closed. */
    readonly #openChannels = new Set<Promise<void>>();
    #local: Compute | undefined;
    /** One runner per Linux user this machine's work runs as, started on first use. */
    readonly #localRunners = new Map<string, LocalUserRunner>();
    /** Each workload user's product machine, created once its runner proved who it runs as. */
    readonly #localProducts = new Map<string, Promise<Compute>>();
    /** The default workload user's home, as its runner reported it. */
    #localHome: string | undefined;
    /** The bots that run as a user of their own, by their agent ID, once the bots are known. */
    #bots: Map<string, string> | undefined;
    readonly #listeners = new Set<RunnersListener>();
    readonly #lock = asyncLock({ reentry: "block" });
    #snapshot: RunnerListResponse | undefined;
    #lifetime: RootContext | undefined;
    #database: AgentDatabase | undefined;
    #closed = false;

    /**
     * @param config The machine configuration naming the runners and the Linux users work runs as.
     * @param botSettings Which bot governs an agent, so a bot with a Linux user of its own gets it
     * for every agent under it. Without this module, every agent runs as the default user.
     */
    constructor(config: ConfigModule, botSettings?: BotSettingsModule) {
        this.#config = config;
        this.#botSettings = botSettings;
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const root = detach(ctx);
        this.#lifetime = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        this.#database = agentDatabase(ctx);
        await this.#startWorkloadUser(ctx);
        return { afterStart: this.afterStart };
    };

    readonly afterStart = async (ctx: Context): Promise<void> => {
        await this.getSnapshot(ctx);
    };

    /**
     * Whether work may run on this machine: no runner is configured, or `[runners] default =
     * "local"` keeps this machine the default beside them. Otherwise nothing runs here.
     */
    get localExecution(): boolean {
        return this.#config.runners.defaultId === undefined;
    }

    /**
     * Whether work on a folder runs inside this daemon process: a folder on this machine, while
     * no workload user is configured. Otherwise it runs in a runner — on another machine, or on
     * this one as the workload user — and only what a runner offers is available for it.
     */
    native(runnerId?: string): boolean {
        return runnerId === undefined && this.#config.execution === undefined;
    }

    /** The Linux user this machine's work runs as, when the daemon does not run it as itself. */
    get workloadUser(): string | undefined {
        return this.#config.execution?.user;
    }

    /** Whether any bot has a Linux user of its own, besides this machine's workload user. */
    get hasBotUsers(): boolean {
        return Object.keys(this.#config.execution?.bots ?? {}).length > 0;
    }

    /**
     * Tell this module every bot there is, so a bot configured with a Linux user of its own is
     * recognized by its agent. Until this is called, no agent work starts while any bot has one.
     */
    bindBots(bots: readonly RunnerBotIdentity[]): void {
        const configured = this.#config.execution?.bots ?? {};
        const bound = new Map<string, string>();
        for (const bot of bots) {
            if (configured[bot.id] !== undefined) bound.set(bot.agentId, bot.id);
        }
        const known = new Set(bots.map((bot) => bot.id));
        for (const botId of Object.keys(configured)) {
            if (!known.has(botId)) {
                this.#named("execution-bots").log.warn(
                    `execution.bots names ${botId}, which is not a bot here; nothing runs as its user.`,
                );
            }
        }
        this.#bots = bound;
    }

    /** Tell this module about one bot created after {@link bindBots}. */
    bindBot(bot: RunnerBotIdentity): void {
        if (this.#config.execution?.bots[bot.id] === undefined) return;
        (this.#bots ??= new Map()).set(bot.agentId, bot.id);
    }

    /**
     * The Linux user an agent's own work runs as: its bot's user when the bot that governs it has
     * one, otherwise this machine's workload user, or undefined when the daemon runs work itself.
     */
    async userFor(ctx: Context, agentId: string): Promise<string | undefined> {
        const execution = this.#config.execution;
        if (execution === undefined) return undefined;
        if (Object.keys(execution.bots).length === 0) return execution.user;
        const bots = this.#bots;
        if (bots === undefined || this.#botSettings === undefined) {
            throw new RunnerUnavailableError(
                "Some bots run as Linux users of their own, and which bots those are is not known yet, so no agent work starts until it is.",
            );
        }
        const botId = bots.get(await this.#botSettings.root(ctx, agentId));
        return (botId === undefined ? undefined : execution.bots[botId]) ?? execution.user;
    }

    /**
     * The runner new folders, the home project, bots, tasks, and Surface chats go to when nobody
     * chose one, or undefined when that is this machine.
     */
    get defaultRunnerId(): string | undefined {
        return this.#config.runners.defaultId;
    }

    /** Whether a runner of this ID is configured right now. */
    has(runnerId: string): boolean {
        return this.#config.runners.entries[runnerId] !== undefined;
    }

    /**
     * Refuse unless the runner is connected right now. A caller that answers from what it read a
     * moment ago, or that cannot tell a failed read from a missing runner, asks this first.
     */
    assertConnected(runnerId: string): void {
        if (this.#links.get(runnerId)?.status().state === "connected") return;
        throw new RunnerUnavailableError(
            `The runner ${this.displayName(runnerId)} is not connected.`,
        );
    }

    /** How people know a runner, or its ID when it is no longer configured. */
    displayName(runnerId: string): string {
        return this.#config.runners.entries[runnerId]?.name ?? runnerId;
    }

    /**
     * The runner a new folder is placed on: the one named, or the default runner, or this machine
     * when it is the default. Naming a runner that is not configured is refused.
     */
    place(runnerId: string | undefined): RunnerLocation {
        if (runnerId !== undefined) {
            if (!this.has(runnerId)) {
                throw Object.assign(new Error(`No runner called "${runnerId}" is configured.`), {
                    code: "ERUNNERUNKNOWN",
                });
            }
            return { runnerId };
        }
        const fallback = this.defaultRunnerId;
        return fallback === undefined ? {} : { runnerId: fallback };
    }

    /** Refuse work on this machine once runners are configured and none of them is this one. */
    assertLocalExecution(): void {
        if (!this.localExecution) throw new LocalExecutionDisabledError();
    }

    /** The runner whose bearer token this is, compared in constant time. */
    authenticate(authorization: string | readonly string[] | undefined): string | undefined {
        if (typeof authorization !== "string") return undefined;
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
        if (match === null) return undefined;
        const presented = Buffer.from(match[1] as string);
        let found: string | undefined;
        for (const [id, entry] of Object.entries(this.#config.runners.entries)) {
            const expected = Buffer.from(entry.token);
            if (expected.length === presented.length && timingSafeEqual(expected, presented))
                found = id;
        }
        return found;
    }

    /**
     * Speak the runner protocol over a connection the runner opened and authenticated. Resolves once
     * the connection ends; a newer connection from the same runner replaces this one.
     */
    async accept(runnerId: string, channel: RunnerChannel): Promise<void> {
        const link = this.#link(runnerId);
        await link.accept(channel);
    }

    /**
     * Serve a runner over the WebSocket it opened with its token. One binary message is one frame;
     * a text message ends the connection.
     */
    acceptWebSocket(runnerId: string, webSocket: BinaryWebSocket): void {
        const ctx = this.#named("runner-connection");
        const channel = webSocketRunnerChannel(webSocket);
        this.#openChannels.add(channel.ended);
        void channel.ended.then(() => this.#openChannels.delete(channel.ended));
        void this.accept(runnerId, channel).catch((error: unknown) => {
            webSocket.close();
            ctx.log.warn("A runner connection ended with an error.", { runnerId }, error);
        });
    }

    /** The public list, reconciled with configuration inside the caller's transaction. */
    async getSnapshot(ctx: Context): Promise<RunnerListResponse> {
        return await this.#lock.runInLock(ctx, async (lockCtx) => await this.#reconcile(lockCtx));
    }

    onUpdated(listener: RunnersListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * A runner's home directory, as it last reported it. It places the home project and bot folders,
     * and survives restarts so a runner that is away still has a known home.
     */
    home(runnerId: string): string | undefined {
        return this.#snapshot?.runners.find((runner) => runner.id === runnerId)?.machine?.home;
    }

    /**
     * The platform a folder's machine runs: this machine's, or the one a runner last reported.
     * It decides how folders are named there and which programs the product can run.
     */
    platform(runnerId?: string): NodeJS.Platform | undefined {
        if (runnerId === undefined) return process.platform;
        const reported =
            this.#snapshot?.runners.find((runner) => runner.id === runnerId)?.machine?.platform ??
            this.#links.get(runnerId)?.status().runner?.platform;
        return reported as NodeJS.Platform | undefined;
    }

    /**
     * The path rules of a folder's machine: this machine's, or the platform a runner last
     * reported. A Windows runner's paths are Windows paths even under a Linux daemon, so every
     * path on a runner is joined, split, and compared with these rather than `node:path`.
     */
    paths(runnerId?: string): PlatformPath {
        return machinePaths(this.platform(runnerId) ?? "linux");
    }

    /**
     * The machine an agent working in a folder is told about: this machine when no runner is
     * named, or the runner holding the folder, as it last reported itself.
     */
    environment(runnerId: string | undefined, workingDirectory: string): AgentEnvironment {
        if (runnerId === undefined) return { ...currentAgentEnvironment(), workingDirectory };
        return runnerEnvironment(this.platform(runnerId), workingDirectory);
    }

    /**
     * The machine Happy's own work on a folder runs on: this machine when no runner is named, or
     * the runner's. Folder management, setup commands, terminals, file watching, connections, and
     * Git all run here, written once against the compute whichever machine it is. Agent commands
     * never run here; they get machines of their own.
     *
     * This machine is refused once runners are configured, unless it is still the default.
     */
    async machine(runnerId?: string): Promise<Compute> {
        if (runnerId === undefined) {
            this.assertLocalExecution();
            if (this.#closed) throw new Error("The runners module is closed.");
            const user = this.workloadUser;
            if (user !== undefined) return await this.#localProduct(user);
            this.#local ??= createHostCompute({
                ctx: this.#named("local-product-machine"),
                cwd: homedir(),
            });
            return this.#local;
        }
        const existing = this.#products.get(runnerId);
        if (existing !== undefined) return await existing;
        const link = this.#link(runnerId);
        const home = this.home(runnerId) ?? link.status().runner?.home;
        if (home === undefined) {
            throw new RunnerUnavailableError(
                `The runner ${this.displayName(runnerId)} has never connected.`,
            );
        }
        const created = createRunnerCompute(this.#named("runner-product-machine"), {
            link,
            computeId: PRODUCT_COMPUTE_ID,
            cwd: home,
        });
        this.#products.set(runnerId, created);
        created.catch(() => {
            if (this.#products.get(runnerId) === created) this.#products.delete(runnerId);
        });
        return await created;
    }

    /**
     * Where a machine served by a runner keeps the product files its agents read: this daemon's
     * documentation and native skills, and the installation's own skills, all copied there.
     */
    productFilesOn(home: string, paths: PlatformPath): RunnerProductFiles {
        return runnerProductFiles(home, paths);
    }

    /** A path on a folder's machine as that machine names it, or as written when it is absent. */
    async canonicalPath(runnerId: string | undefined, path: string): Promise<string> {
        return await canonicalMachinePath(await this.machine(runnerId), this.paths(runnerId), path);
    }

    /** Where a folder that does not exist yet will be, named the way its machine will name it. */
    async futurePath(runnerId: string | undefined, path: string): Promise<string> {
        return await futureMachinePath(await this.machine(runnerId), this.paths(runnerId), path);
    }

    /**
     * The folder projects cloned onto a machine live under: this installation's configured folder
     * here, or the same layout under a runner's home directory there.
     */
    async projectsHome(runnerId: string | undefined): Promise<string> {
        const machine = this.machineHome(runnerId);
        const home =
            machine === undefined
                ? this.#config.projectsHome
                : this.#config.projectsHomeOn(machine.home, machine.platform);
        return await this.futurePath(runnerId, home);
    }

    /** The folder managed workspaces live under on a machine, laid out the same way. */
    async workspacesHome(runnerId: string | undefined): Promise<string> {
        const machine = this.machineHome(runnerId);
        const home =
            machine === undefined
                ? this.#config.workspacesHome
                : this.#config.workspacesHomeOn(machine.home, machine.platform);
        return await this.futurePath(runnerId, home);
    }

    /**
     * The home a folder's machine places folders that have no project under — the home project,
     * bot and task folders, clones, and workspaces: a runner's home, or this machine's workload
     * user's home. Undefined for this machine while the daemon runs its work itself, which uses
     * this installation's own layout. Throws when that home is not known yet.
     */
    machineHome(runnerId: string | undefined): MachineHome | undefined {
        if (runnerId !== undefined) {
            return {
                home: this.#knownHome(runnerId),
                platform: this.platform(runnerId) ?? "linux",
            };
        }
        const user = this.workloadUser;
        if (user === undefined) return undefined;
        const home = this.#localHome;
        if (home === undefined) {
            const failure = this.#localRunners.get(user)?.lastFailure;
            throw new RunnerUnavailableError(
                failure ??
                    `The runner for the Linux user ${user} has not started yet, so it has nowhere to put folders.`,
            );
        }
        return { home, platform: process.platform };
    }

    /** A runner's home directory, which must be known before anything is placed under it. */
    #knownHome(runnerId: string): string {
        const home = this.home(runnerId) ?? this.#links.get(runnerId)?.status().runner?.home;
        if (home === undefined) {
            throw new RunnerUnavailableError(
                `The runner ${this.displayName(runnerId)} has never connected, so it has nowhere to put folders yet.`,
            );
        }
        return home;
    }

    /**
     * Run one of the product's own programs on a folder's machine, such as Git, and wait
     * for it. Output past the bound, the deadline, and the caller's signal all stop the program;
     * the result says which instead of throwing, so a caller can read the program's diagnostics.
     */
    async run(
        ctx: Context,
        runnerId: string | undefined,
        options: RunnerRunOptions,
    ): Promise<RunnerRunResult> {
        return await runOnMachine(ctx, await this.machine(runnerId), options);
    }

    /**
     * A machine for one agent on a runner, in its workspace folder. With `docker`, the agent's
     * files and commands run in a container of that image on the runner.
     */
    async agentMachine(
        ctx: Context,
        input: {
            readonly runnerId: string;
            readonly agentId: string;
            readonly cwd: string;
            readonly policy: RunnerProjectPolicy;
            readonly docker?: { readonly image: string };
        },
    ): Promise<Compute> {
        return await createRunnerCompute(ctx, {
            link: this.#link(input.runnerId),
            computeId: `agent-${input.agentId}`,
            cwd: input.cwd,
            policy: input.policy,
            ...(input.docker === undefined ? {} : { docker: { image: input.docker.image } }),
        });
    }

    /**
     * A machine for one agent on this machine, run as a workload user: its files, commands, and
     * processes all live in that user's runner, in the agent's folder. With `docker`, its files
     * and commands run in a container of that image, which that user's runner starts.
     */
    async localAgentMachine(
        ctx: Context,
        input: {
            readonly user: string;
            readonly agentId: string;
            readonly cwd: string;
            readonly policy: RunnerProjectPolicy;
            readonly docker?: { readonly image: string };
            /** Overrides the agent-derived compute ID, for a machine that is not an agent's. */
            readonly computeId?: string;
        },
    ): Promise<Compute> {
        await this.#localProduct(input.user);
        return await createRunnerCompute(ctx, {
            link: this.#localRunner(input.user).link,
            computeId: input.computeId ?? `agent-${input.agentId}`,
            cwd: input.cwd,
            policy: input.policy,
            ...(input.docker === undefined ? {} : { docker: { image: input.docker.image } }),
        });
    }

    /**
     * Tell every runner to release what this daemon holds, and stop accepting connections.
     *
     * The goodbye goes first and is given a moment to leave: the runner then releases everything
     * at once and reconnects to the next daemon promptly, instead of noticing the silence only
     * after its idle timeout. Disposing each machine afterwards only tidies this side, since the
     * runner has already let go of them.
     */
    async close(): Promise<void> {
        this.#closed = true;
        for (const link of this.#links.values()) link.close("The daemon is shutting down.");
        this.#links.clear();
        await flushed([...this.#openChannels]);
        const products: Promise<Compute>[] = [
            ...this.#products.values(),
            ...this.#localProducts.values(),
        ];
        if (this.#local !== undefined) products.push(Promise.resolve(this.#local));
        this.#local = undefined;
        this.#products.clear();
        this.#localProducts.clear();
        if (products.length > 0) {
            const ctx = this.#named("runners-close");
            await Promise.allSettled(
                products.map(async (product) => await (await product).dispose(ctx)),
            );
        }
        const locals = [...this.#localRunners.values()];
        this.#localRunners.clear();
        await Promise.allSettled(
            locals.map(async (runner) => await runner.close("The daemon is shutting down.")),
        );
    }

    /**
     * Start this machine's workload user's runner while the daemon starts, so its home is known
     * before the first folder is placed. A runner that will not start is logged and left: the
     * daemon still starts, and every piece of work that needs the runner fails with the reason.
     */
    async #startWorkloadUser(ctx: Context): Promise<void> {
        const user = this.workloadUser;
        if (user === undefined || !this.localExecution) return;
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                this.#localProduct(user),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `The runner for the Linux user ${user} did not start within ${String(LOCAL_RUNNER_STARTUP_MS / 1_000)} seconds.`,
                                ),
                            ),
                        LOCAL_RUNNER_STARTUP_MS,
                    );
                }),
            ]);
        } catch (error) {
            ctx.log.error(
                `Agent work on this machine is unavailable until it can run as ${user}.`,
                error,
            );
        } finally {
            clearTimeout(timer);
        }
    }

    /** The runner a workload user's work runs in, created on first use. */
    #localRunner(user: string): LocalUserRunner {
        const execution = this.#config.execution;
        if (execution === undefined || this.#closed) {
            throw new RunnerUnavailableError(
                `Agent work cannot run as the Linux user ${user} because the daemon is shutting down.`,
            );
        }
        const existing = this.#localRunners.get(user);
        if (existing !== undefined) return existing;
        const runner = new LocalUserRunner(this.#named(`runner-user-${user}`), {
            user,
            command: sudoRunnerCommand(user, execution.executable),
            instanceId: this.#instanceId,
        });
        this.#localRunners.set(user, runner);
        return runner;
    }

    /**
     * A workload user's product machine, once its runner is connected and has proved that it runs
     * as that user. A runner that turns out to run as anyone else — above all as this daemon's own
     * user — is stopped, and nothing of this machine's work runs until that is fixed.
     */
    async #localProduct(user: string): Promise<Compute> {
        const existing = this.#localProducts.get(user);
        if (existing !== undefined) return await existing;
        const created = this.#createLocalProduct(user);
        this.#localProducts.set(user, created);
        created.catch(() => {
            if (this.#localProducts.get(user) === created) this.#localProducts.delete(user);
        });
        return await created;
    }

    async #createLocalProduct(user: string): Promise<Compute> {
        const daemonUser = userInfo().username;
        if (user === daemonUser) {
            throw new RunnerUnavailableError(
                `Agent work cannot run as the Linux user ${user}, because that is the user this daemon runs as. Name a separate workload user in execution.user.`,
            );
        }
        const runner = this.#localRunner(user);
        await runner.ready();
        const reported = runner.link.status().runner?.home;
        if (reported === undefined) {
            throw new RunnerUnavailableError(
                `The runner for the Linux user ${user} did not say where its home is.`,
            );
        }
        const ctx = this.#named(`runner-user-product-${user}`);
        const product = await createRunnerCompute(ctx, {
            link: runner.link,
            computeId: PRODUCT_COMPUTE_ID,
            cwd: reported,
        });
        const whoami = await runOnMachine(ctx, product, {
            command: "id",
            args: ["-un"],
            maximumBytes: 1_024,
            timeoutMs: 15_000,
        }).catch((error: unknown) => ({
            code: 1,
            stdout: Buffer.alloc(0),
            stderr: error instanceof Error ? error.message : String(error),
            truncated: false,
            timedOut: false,
        }));
        const actual = whoami.stdout.toString("utf8").trim();
        if (whoami.code !== 0 || actual !== user) {
            await product.dispose(ctx).catch(() => undefined);
            this.#localRunners.delete(user);
            await runner.close("The runner does not run as the user it was started for.");
            throw new RunnerUnavailableError(
                whoami.code !== 0
                    ? `Agent work cannot run as the Linux user ${user}: its runner could not confirm which user it runs as (${whoami.stderr.trim().slice(0, 300)}).`
                    : `Agent work cannot run as the Linux user ${user}: its runner runs as ${actual.slice(0, 64)} instead, so it was stopped.`,
            );
        }
        if (user === this.workloadUser) this.#localHome = reported;
        return product;
    }

    #link(runnerId: string): RunnerLink {
        const entry = this.#config.runners.entries[runnerId];
        if (entry === undefined || this.#closed) {
            throw new RunnerUnavailableError(`The runner "${runnerId}" is not configured.`);
        }
        const existing = this.#links.get(runnerId);
        if (existing !== undefined) return existing;
        const link = new RunnerLink(this.#named(`runner-${runnerId}`), {
            name: entry.name,
            instanceId: this.#instanceId,
            pingIntervalMs: RUNNER_PING_INTERVAL_MS,
            idleTimeoutMs: RUNNER_IDLE_TIMEOUT_MS,
        });
        link.onStatus((status) => this.#statusChanged(runnerId, status));
        this.#links.set(runnerId, link);
        return link;
    }

    #statusChanged(runnerId: string, status: RunnerLinkStatus): void {
        const ctx = this.#named("runner-status");
        void this.#lock
            .runInLock(ctx, async (lockCtx) => {
                await this.#reconcile(lockCtx, { runnerId, status });
            })
            .catch((error: unknown) => {
                ctx.log.warn("Could not record a runner's connection status.", { runnerId }, error);
            });
    }

    async #reconcile(
        ctx: Context,
        change?: { readonly runnerId: string; readonly status: RunnerLinkStatus },
    ): Promise<RunnerListResponse> {
        return await ctx.inTx(async (txCtx) => {
            const previous = this.#snapshot ?? (await queryRunnerSnapshot(txCtx));
            const runners = this.#runners(previous?.runners ?? [], change);
            if (previous !== undefined && isDeepStrictEqual(previous.runners, runners)) {
                this.#snapshot = previous;
                return previous;
            }
            const snapshot: RunnerListResponse = {
                runners,
                version: createRunnersVersion(previous?.version),
            };
            await saveRunnerSnapshot(txCtx, snapshot);
            afterCommit(txCtx, () => {
                this.#snapshot = snapshot;
                for (const listener of this.#listeners) {
                    try {
                        listener(ctx, snapshot);
                    } catch (error: unknown) {
                        ctx.log.warn("A runner list listener failed.", {}, error);
                    }
                }
            });
            return snapshot;
        });
    }

    /** The configured runners in ID order, carrying what each last reported about its machine. */
    #runners(
        previous: readonly Runner[],
        change: { readonly runnerId: string; readonly status: RunnerLinkStatus } | undefined,
    ): Runner[] {
        const { defaultId, entries } = this.#config.runners;
        return Object.keys(entries)
            .sort()
            .map((id): Runner => {
                const known = previous.find((runner) => runner.id === id);
                const status =
                    change?.runnerId === id ? change.status : this.#links.get(id)?.status();
                const connected = status?.state === "connected";
                return {
                    id,
                    name: entries[id]?.name ?? id,
                    default: id === defaultId,
                    status: connected ? "connected" : "disconnected",
                    machine:
                        status?.runner === undefined
                            ? (known?.machine ?? null)
                            : {
                                  version: status.runner.version,
                                  platform: status.runner.platform,
                                  arch: status.runner.arch,
                                  hostname: status.runner.hostname,
                                  home: status.runner.home,
                              },
                    protocol: connected ? (status?.protocol ?? null) : null,
                    since:
                        status === undefined
                            ? (known?.since ?? Date.now())
                            : known !== undefined &&
                                known.status === (connected ? "connected" : "disconnected")
                              ? known.since
                              : status.since,
                    reason: connected ? null : (status?.reason ?? known?.reason ?? null),
                };
            });
    }

    /** A new lifetime owned by this module, carrying the database its background work records in. */
    #named(name: string): Context {
        // A caller that uses folders without an agent collection, as a small embedding or a test
        // does, gets a lifetime of its own.
        this.#lifetime ??= createRootContext();
        const ctx = this.#lifetime.named(name);
        return this.#database === undefined ? ctx : withAgentDatabase(ctx, this.#database);
    }
}

/** Wait for closing transports to finish, but never longer than a goodbye needs to leave. */
async function flushed(channels: readonly Promise<void>[]): Promise<void> {
    if (channels.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        Promise.allSettled(channels),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, RUNNER_CLOSE_FLUSH_MS);
            timer.unref?.();
        }),
    ]);
    clearTimeout(timer);
}
