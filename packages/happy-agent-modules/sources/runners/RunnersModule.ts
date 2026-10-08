import { randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import {
    agentDatabase,
    withAgentDatabase,
    type AgentDatabase,
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

import type { ConfigModule } from "../config/index.js";
import type { BinaryWebSocket } from "../transport/index.js";
import { LocalExecutionDisabledError } from "./LocalExecutionDisabledError.js";
import { createRunnersVersion } from "./createRunnersVersion.js";
import { canonicalMachinePath, futureMachinePath } from "./impl/canonicalMachinePath.js";
import { runOnMachine } from "./impl/runOnMachine.js";
import { webSocketRunnerChannel } from "./impl/webSocketRunnerChannel.js";
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

/**
 * The runners this installation works on.
 *
 * A runner is a separate machine that holds project folders and runs everything that touches them,
 * while this daemon keeps the database, credentials, and inference. Runners are machine
 * configuration with fixed tokens; each one dials in through `GET /v0/runners/connect` and keeps
 * one connection open. Once any runner is configured nothing runs on this machine: every module
 * that touches a folder asks this one for the runner's machine instead of reaching the local disk.
 */
export class RunnersModule implements AgentModule {
    readonly name = "runners";
    readonly migrations = runnersMigrations;
    readonly #config: ConfigModule;
    readonly #instanceId = randomUUID();
    readonly #links = new Map<string, RunnerLink>();
    readonly #products = new Map<string, Promise<Compute>>();
    #local: Compute | undefined;
    readonly #listeners = new Set<RunnersListener>();
    readonly #lock = asyncLock({ reentry: "block" });
    #snapshot: RunnerListResponse | undefined;
    #lifetime: RootContext | undefined;
    #database: AgentDatabase | undefined;
    #closed = false;

    constructor(config: ConfigModule) {
        this.#config = config;
    }

    readonly beforeStart = (ctx: Context): AgentModuleHooks => {
        const root = detach(ctx);
        this.#lifetime = ctx.lifetime === undefined ? root : withLifetime(root, ctx.lifetime);
        this.#database = agentDatabase(ctx);
        return { afterStart: this.afterStart };
    };

    readonly afterStart = async (ctx: Context): Promise<void> => {
        await this.getSnapshot(ctx);
    };

    /** Whether any runner is configured, which is when nothing runs on this machine. */
    get enabled(): boolean {
        return Object.keys(this.#config.runners.entries).length > 0;
    }

    /** The runner new folders go to when nobody chose one. */
    get defaultRunnerId(): string | undefined {
        return this.#config.runners.defaultId;
    }

    /** Whether a runner of this ID is configured right now. */
    has(runnerId: string): boolean {
        return this.#config.runners.entries[runnerId] !== undefined;
    }

    /** How people know a runner, or its ID when it is no longer configured. */
    displayName(runnerId: string): string {
        return this.#config.runners.entries[runnerId]?.name ?? runnerId;
    }

    /**
     * The runner a new folder is placed on: the one named, or the default while runners are
     * configured, or this machine when none are. Naming a runner that is not configured is refused.
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

    /** Refuse work on this machine once runners are configured. */
    assertLocalExecution(): void {
        if (this.enabled) throw new LocalExecutionDisabledError();
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
        void this.accept(runnerId, webSocketRunnerChannel(webSocket)).catch((error: unknown) => {
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
     * The machine Happy's own work on a folder runs on: this machine when no runner is named, or
     * the runner's. Folder management, setup commands, terminals, file watching, connections, and
     * Git all run here, written once against the compute whichever machine it is. Agent commands
     * never run here; they get machines of their own.
     *
     * This machine is refused once runners are configured, because then nothing runs here.
     */
    async machine(runnerId?: string): Promise<Compute> {
        if (runnerId === undefined) {
            this.assertLocalExecution();
            if (this.#closed) throw new Error("The runners module is closed.");
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

    /** A path on a folder's machine as that machine names it, or as written when it is absent. */
    async canonicalPath(runnerId: string | undefined, path: string): Promise<string> {
        return await canonicalMachinePath(await this.machine(runnerId), path);
    }

    /** Where a folder that does not exist yet will be, named the way its machine will name it. */
    async futurePath(runnerId: string | undefined, path: string): Promise<string> {
        return await futureMachinePath(await this.machine(runnerId), path);
    }

    /**
     * The folder projects cloned onto a machine live under: this installation's configured folder
     * here, or the same layout under a runner's home directory there.
     */
    async projectsHome(runnerId: string | undefined): Promise<string> {
        const home =
            runnerId === undefined
                ? this.#config.projectsHome
                : this.#config.projectsHomeOn(this.#knownHome(runnerId));
        return await this.futurePath(runnerId, home);
    }

    /** The folder managed workspaces live under on a machine, laid out the same way. */
    async workspacesHome(runnerId: string | undefined): Promise<string> {
        const home =
            runnerId === undefined
                ? this.#config.workspacesHome
                : this.#config.workspacesHomeOn(
                      this.#knownHome(runnerId),
                      this.platform(runnerId) ?? "linux",
                  );
        return await this.futurePath(runnerId, home);
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

    /** Tell every runner to release what this daemon holds, and stop accepting connections. */
    async close(): Promise<void> {
        this.#closed = true;
        const products: Promise<Compute>[] = [...this.#products.values()];
        if (this.#local !== undefined) products.push(Promise.resolve(this.#local));
        this.#local = undefined;
        this.#products.clear();
        if (products.length > 0) {
            const ctx = this.#named("runners-close");
            await Promise.allSettled(
                products.map(async (product) => await (await product).dispose(ctx)),
            );
        }
        for (const link of this.#links.values()) link.close("The daemon is shutting down.");
        this.#links.clear();
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
