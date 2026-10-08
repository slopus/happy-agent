import { randomUUID, timingSafeEqual } from "node:crypto";
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
    detach,
    withLifetime,
    type Context,
    type RootContext,
} from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { BinaryWebSocket } from "../transport/index.js";
import { LocalExecutionDisabledError } from "./LocalExecutionDisabledError.js";
import { createRunnersVersion } from "./createRunnersVersion.js";
import { webSocketRunnerChannel } from "./impl/webSocketRunnerChannel.js";
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

    /** The platform a runner last reported, which decides how its folders are named. */
    platform(runnerId: string): string | undefined {
        return this.#snapshot?.runners.find((runner) => runner.id === runnerId)?.machine?.platform;
    }

    /**
     * The machine Happy's own work runs on for one runner: Git, folder management, terminals, file
     * watching, and connections. Agent commands never run here; they get machines of their own.
     */
    async machine(runnerId: string): Promise<Compute> {
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
        const products = [...this.#products.values()];
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
        if (this.#lifetime === undefined) {
            throw new Error("The runners module is used before the agent system started.");
        }
        const ctx = this.#lifetime.named(name);
        return this.#database === undefined ? ctx : withAgentDatabase(ctx, this.#database);
    }
}
