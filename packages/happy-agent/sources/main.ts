import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
    type StartHappyAgentRuntimeOptions,
} from "@slopus/happy-agent-modules";
import { withLogContext, type Context } from "@steve.kite/stdlib";

import { removeDaemonPid, writeDaemonPid } from "./lifecycle/daemonPid.js";
import {
    bindAgentHttpServer,
    bindAgentSocket,
    removeInactiveAgentSocket,
    type BoundAgentHttpServer,
    type BoundAgentSocket,
} from "./socket/AgentSocket.js";
import { startTailcatExposure, type TailcatExposure } from "./tailcat/startTailcatExposure.js";

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
    readonly tailcat?: { readonly address: string; readonly port: number };
    readonly tokenPath: string;
    close(reason?: HappyAgentShutdownReason): Promise<void>;
}

/** Start the modules-owned runtime and bind its standalone socket or team HTTP transport. */
export async function startHappyAgentDaemon(
    options: StartHappyAgentDaemonOptions = {},
): Promise<HappyAgentDaemon> {
    const { persistPid = false, ...runtimeOptions } = options;
    let bound: BoundAgentSocket | BoundAgentHttpServer | undefined;
    let tailcat: TailcatExposure | undefined;
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
        if (runtime.configuration.values.feature.tailcat.enabled) {
            if (bound === undefined) {
                throw new Error("The Happy Agent API transport was not ready for Tailcat.");
            }
            const paths = runtime.configuration.paths;
            tailcat = await startTailcatExposure(
                runtime.ctx.named("tailcat"),
                "url" in bound
                    ? { host: bound.host, port: bound.port }
                    : { socketPath: bound.socketPath },
                {
                    addressPath: paths.tailcatAddressPath,
                    home: paths.tailcatHome,
                    keyPath: paths.tailcatKeyPath,
                    portPath: paths.tailcatPortPath,
                },
            );
        }
    } catch (error) {
        unsubscribeShutdown?.();
        await tailcat?.close().catch(() => undefined);
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
            closing = closeHappyAgentDaemon(runtime, bound, tailcat, unsubscribeShutdown, reason);
            void closing.then(resolveClosed, rejectClosed);
        }
        return closing;
    };
    if (shutdownRequested) void closeDaemon("api");

    return {
        close: closeDaemon,
        closed,
        ...(runtime.configuration.values.feature.team.enabled && "url" in bound
            ? { httpUrl: bound.url }
            : {}),
        socketPath: runtime.configuration.paths.socketPath,
        ...(tailcat === undefined
            ? {}
            : { tailcat: { address: tailcat.address, port: tailcat.port } }),
        tokenPath: runtime.configuration.paths.tokenPath,
    };
}

async function closeHappyAgentDaemon(
    runtime: HappyAgentRuntime,
    bound: BoundAgentSocket | BoundAgentHttpServer | undefined,
    tailcat: TailcatExposure | undefined,
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
    await runShutdownStep(
        ctx,
        "graceful-runtime",
        async () => {
            await runtime.shutdown();
        },
        failures,
    );
    if (tailcat !== undefined) {
        await runShutdownStep(ctx, "tailcat", async () => await tailcat.close(), failures);
    }
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
