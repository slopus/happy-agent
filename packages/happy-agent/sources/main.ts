import {
    startHappyAgentRuntime,
    withMobileTransport,
    withPublicTransport,
    type HappyAgentRuntime,
    type PreparedHappyAgentRuntime,
    type StartHappyAgentRuntimeOptions,
} from "@slopus/happy-agent-modules";
import { asyncLock, withLogContext, type Context } from "@steve.kite/stdlib";
import type { DaemonDrain, DrainRequest, DrainWaitingFor } from "@slopus/happy-agent-client";
import { dirname } from "node:path";

import { removeDaemonPid, writeDaemonPid } from "./lifecycle/daemonPid.js";
import { recordDaemonStopIntent } from "./lifecycle/daemonStopIntent.js";
import {
    bindAgentHttpServer,
    bindAgentSocket,
    removeInactiveAgentSocket,
    type BoundAgentHttpServer,
    type BoundAgentSocket,
} from "./socket/AgentSocket.js";
const SLOW_SHUTDOWN_STEP_MS = 1_000;

export interface StartHappyAgentDaemonOptions extends Omit<
    StartHappyAgentRuntimeOptions,
    "onPrepared"
> {
    /** Persist this dedicated daemon process's PID before the API reports ready. */
    readonly persistPid?: boolean;
}

export type HappyAgentShutdownReason = "api" | "requested" | "sigint" | "sigterm";

export interface HappyAgentDaemon {
    /** Settles after the graceful sequence and transport finalizers finish. */
    readonly closed: Promise<void>;
    /** Present only for a team deployment's TCP HTTP transport. */
    readonly httpUrl?: string;
    readonly socketPath: string;
    /** Present while the configured Tailcat transport is open. */
    readonly tailcat?: { readonly address: string; readonly port: number } | undefined;
    readonly tokenPath: string;
    /**
     * Begin draining without closing transports or stopping background processes. The request
     * says whether a replacement is coming; the first drain or shutdown decides it.
     */
    drain(request?: DrainRequest): DaemonDrain;
    drainProgress(): readonly DrainWaitingFor[];
    close(reason?: HappyAgentShutdownReason): Promise<void>;
}

/** Start the modules-owned runtime and bind its standalone socket or team HTTP transport. */
export async function startHappyAgentDaemon(
    options: StartHappyAgentDaemonOptions = {},
): Promise<HappyAgentDaemon> {
    const { persistPid = false, ...runtimeOptions } = options;
    const startedAt = performance.now();
    let bound: BoundAgentSocket | BoundAgentHttpServer | undefined;
    let externalBound: { close(): Promise<void> } | undefined;
    let preparedRuntime: Parameters<typeof bindAgentSocket>[0] | undefined;
    let unsubscribeShutdown: (() => void) | undefined;
    let closeDaemon: ((reason?: HappyAgentShutdownReason) => Promise<void>) | undefined;
    let pidPath: string | undefined;
    let pidWritten = false;
    let shutdownRequested = false;
    let runtime: HappyAgentRuntime | undefined;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    void closed.catch(() => undefined);

    try {
        runtime = await startHappyAgentRuntime({
            ...runtimeOptions,
            onPrepared: async (prepared) => {
                preparedRuntime = prepared;
                if (prepared.configuration.values.feature.team.enabled) {
                    // This removes an inactive socket left by an interrupted standalone daemon
                    // without ever opening a local connection surface for the team deployment.
                    await removeInactiveAgentSocket(prepared.configuration.paths.socketPath);
                } else {
                    bound = await bindAgentSocket(prepared);
                }
                if (persistPid) {
                    pidPath = prepared.configuration.paths.pidPath;
                    await writeDaemonPid(pidPath);
                    pidWritten = true;
                    withLogContext(prepared.context("daemon-pid"), {
                        module: "daemon",
                        pid: process.pid,
                    }).log.info(`daemon:pid:write pid=${String(process.pid)} path=${pidPath}`);
                }
                unsubscribeShutdown = prepared.api.onShutdown(async () => {
                    if (closeDaemon === undefined) {
                        shutdownRequested = true;
                        return;
                    }
                    await closeDaemon("api");
                });
            },
        });
        if (runtime.configuration.values.feature.team.enabled) {
            if (preparedRuntime === undefined) {
                throw new Error("The Happy Agent runtime did not prepare its team HTTP API.");
            }
            const { host, port } = runtime.configuration.values.feature.team;
            bound = await bindAgentHttpServer(preparedRuntime, host, port);
        }
        if (bound === undefined) {
            throw new Error("The Happy Agent API transport was not ready.");
        }
        await runtime.modules.tailcat.attachTransport(
            runtime.ctx.named("tailcat-transport"),
            "url" in bound
                ? { host: bound.host, port: bound.port }
                : { socketPath: bound.socketPath },
        );
        // External connectivity is optional; the primary transport remains available for repair.
        externalBound = await bindExternalTransport(runtime, preparedRuntime).catch(
            (error: unknown) => {
                runtime?.ctx.log.warn("The external API transport could not start.", {}, error);
                return undefined;
            },
        );
    } catch (error) {
        unsubscribeShutdown?.();
        await externalBound?.close().catch(() => undefined);
        await bound?.close().catch(() => undefined);
        await runtime?.close().catch(() => undefined);
        if (pidWritten && pidPath !== undefined) {
            await removeDaemonPid(pidPath, process.pid).catch(() => undefined);
        }
        throw error;
    }

    if (bound === undefined || runtime === undefined) {
        await runtime?.close().catch(() => undefined);
        throw new Error("The Happy agent runtime started without binding its API transport.");
    }

    let closing: Promise<void> | undefined;
    closeDaemon = (reason = "requested") => {
        if (closing === undefined) {
            const stopIntentDirectory =
                pidWritten && pidPath !== undefined ? dirname(pidPath) : undefined;
            // Every shutdown is intentional. Recording it first means a crash supervisor never
            // restarts this daemon, even when a caller kills it mid-shutdown.
            if (stopIntentDirectory !== undefined) {
                try {
                    recordDaemonStopIntent(stopIntentDirectory, process.pid);
                } catch {
                    // Without the record a forced kill reads as a crash; a clean exit still does not.
                }
            }
            // Clients still polling health learn this process is going away for good, unless a
            // drain already said why.
            runtime.api.recordShutdown(
                reason === "sigint" || reason === "sigterm" ? "signal" : "api",
            );
            closing = closeHappyAgentDaemon(
                runtime,
                bound,
                externalBound,
                unsubscribeShutdown,
                reason,
            );
            void closing.then(resolveClosed, rejectClosed);
        }
        return closing;
    };
    if (shutdownRequested) void closeDaemon("api");

    const startedRuntime = runtime;
    const drainContext = runtime.ctx.named("daemon-local-drain");
    withLogContext(runtime.ctx.named("daemon-start"), {
        module: "daemon",
        pid: process.pid,
    }).log.info(
        `daemon:ready pid=${String(process.pid)} durationMs=${String(Math.round(performance.now() - startedAt))}`,
    );
    return {
        close: closeDaemon,
        closed,
        drain: (request) => startedRuntime.api.beginDrain(drainContext, request),
        drainProgress: () => startedRuntime.api.drainProgress(drainContext),
        ...(runtime.configuration.values.feature.team.enabled && "url" in bound
            ? { httpUrl: bound.url }
            : {}),
        socketPath: runtime.configuration.paths.socketPath,
        get tailcat() {
            const status = startedRuntime.modules.tailcat.currentStatus();
            return status.state === "open" &&
                status.address !== undefined &&
                status.port !== undefined
                ? { address: status.address, port: status.port }
                : undefined;
        },
        tokenPath: runtime.configuration.paths.tokenPath,
    };
}

async function closeHappyAgentDaemon(
    runtime: HappyAgentRuntime,
    bound: BoundAgentSocket | BoundAgentHttpServer | undefined,
    externalBound: { close(): Promise<void> } | undefined,
    unsubscribeShutdown: (() => void) | undefined,
    reason: HappyAgentShutdownReason,
): Promise<void> {
    unsubscribeShutdown?.();
    const ctx = withLogContext(runtime.ctx.named("daemon-shutdown"), {
        module: "daemon",
        pid: process.pid,
    });
    const startedAt = performance.now();
    ctx.log.info(`daemon:shutdown:start pid=${String(process.pid)} reason=${reason}`);
    const failures: unknown[] = [];
    if (externalBound !== undefined) {
        await runShutdownStep(
            ctx,
            "external-transport",
            async () => await externalBound.close(),
            failures,
        );
    }
    await runShutdownStep(
        ctx,
        "graceful-runtime",
        async () => {
            await runtime.shutdown();
        },
        failures,
    );
    if (bound !== undefined) {
        await runShutdownStep(ctx, "transport", async () => await bound.close(), failures);
    }
    await runShutdownStep(ctx, "runtime-finalizers", async () => await runtime.close(), failures);
    if (failures.length > 0) {
        throw new AggregateError(failures, "The Happy agent daemon did not close cleanly.");
    }
    ctx.log.info(
        `daemon:shutdown:finish pid=${String(process.pid)} durationMs=${String(Math.round(performance.now() - startedAt))}`,
    );
}

/**
 * Own exactly one external-facing loopback transport. Public mode serves the main API and phones;
 * private mode is a phone-only target for the connector's on-demand Tailcat exposure.
 */
async function bindExternalTransport(
    runtime: HappyAgentRuntime,
    prepared: PreparedHappyAgentRuntime | undefined,
): Promise<{ close(): Promise<void> }> {
    if (prepared === undefined) {
        throw new Error("The Happy Agent runtime did not prepare its external transport.");
    }
    const ctx = runtime.ctx.named("daemon-external-transport");
    const config = runtime.modules.config;
    const mobile = runtime.modules.mobileConnector;
    const lock = asyncLock({ reentry: "block" });
    let state: { public: boolean; bound: BoundAgentHttpServer } | undefined;
    let closed = false;
    const reconcile = async (initial = false) =>
        await lock.runInLock(ctx, async () => {
            if (closed) return;
            const publicMode = config.publicApiUrl !== null;
            if (state !== undefined && state.public === publicMode) {
                await mobile.replaceTransport(ctx, state.bound);
                return;
            }
            if (!initial) await mobile.replaceTransport(ctx, undefined);
            const previous = state;
            state = undefined;
            await previous?.bound.close({ gracePeriodMs: 2_000 });
            if (closed) return;
            try {
                const transport: PreparedHappyAgentRuntime = {
                    api: prepared.api,
                    configuration: prepared.configuration,
                    context: (name) =>
                        publicMode
                            ? withPublicTransport(prepared.context(`public-${name}`))
                            : withMobileTransport(prepared.context(`mobile-${name}`)),
                };
                const bound = await bindAgentHttpServer(
                    transport,
                    "127.0.0.1",
                    publicMode ? config.publicApiPort : 0,
                );
                if (closed) {
                    await bound.close();
                    return;
                }
                state = { public: publicMode, bound };
                // Reopening an existing phone's Tailcat exposure must not hold up daemon startup.
                if (initial && !publicMode) mobile.attachTransport(ctx, bound);
                else await mobile.replaceTransport(ctx, bound);
            } catch (error: unknown) {
                const message = publicMode
                    ? `The public API listener could not open on 127.0.0.1:${String(config.publicApiPort)}. Check that the port is available, then restart Happy Agent.`
                    : "The phone connection listener could not start.";
                ctx.log.warn(message, {}, error);
                await mobile.replaceTransport(ctx, undefined, message);
            }
        });
    const unsubscribe = runtime.api.onPublicEndpointChanged(reconcile);
    await reconcile(true);
    return {
        close: async () => {
            unsubscribe();
            closed = true;
            await lock.runInLock(ctx, async () => {
                const previous = state;
                state = undefined;
                await previous?.bound.close();
            });
        },
    };
}

async function runShutdownStep(
    ctx: Context,
    step: string,
    work: () => Promise<void>,
    failures: unknown[],
): Promise<void> {
    const startedAt = performance.now();
    ctx.log.info(`daemon:shutdown:step:start pid=${String(process.pid)} step=${step}`);
    const slow = setTimeout(() => {
        ctx.log.warn(
            `daemon:shutdown:step:slow pid=${String(process.pid)} step=${step} durationMs=${String(SLOW_SHUTDOWN_STEP_MS)}`,
        );
    }, SLOW_SHUTDOWN_STEP_MS);
    slow.unref();
    try {
        await work();
        ctx.log.info(
            `daemon:shutdown:step:finish pid=${String(process.pid)} step=${step} durationMs=${String(Math.round(performance.now() - startedAt))}`,
        );
    } catch (error) {
        failures.push(error);
        ctx.log.error(
            `daemon:shutdown:step:fail pid=${String(process.pid)} step=${step} durationMs=${String(Math.round(performance.now() - startedAt))} error=${errorMessage(error)}`,
            {},
            error,
        );
    } finally {
        clearTimeout(slow);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.replaceAll(/\s+/g, " ") : String(error);
}
