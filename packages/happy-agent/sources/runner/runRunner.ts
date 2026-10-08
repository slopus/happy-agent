import { hostname } from "node:os";

import { createRunnerMachine, RunnerHost } from "@slopus/happy-agent-compute";
import { createRootContext, withLogger, type Context } from "@steve.kite/stdlib";

import { getDaemonIdentity } from "../lifecycle/getDaemonIdentity.js";
import { connectRunnerWebSocket, RunnerConnectError } from "./connectRunnerWebSocket.js";
import { createRunnerLogger } from "./createRunnerLogger.js";
import { readRunnerOptions } from "./readRunnerOptions.js";

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 30_000;
/** A refused token is a configuration change away from working, so it is retried slowly. */
const REFUSED_RETRY_MS = 60_000;
/** A connection that lasted this long was healthy, so the next drop retries quickly again. */
const HEALTHY_CONNECTION_MS = 60_000;

/**
 * Run this machine as a runner until it is stopped.
 *
 * The runner dials its daemon and keeps one connection open, reconnecting with backoff when it
 * drops; it needs no inbound port. Everything the daemon starts here belongs to the daemon process
 * that started it and ends with that process's lease, so stopping the runner — or the daemon —
 * leaves nothing running.
 */
export async function runRunner(args: readonly string[]): Promise<void> {
    const options = readRunnerOptions(args);
    const logger = createRunnerLogger(process.env["HAPPY_RUNNER_DEBUG"] === "1");
    const root = withLogger(createRootContext(), logger);
    const ctx = root.named("runner");
    const identity = {
        version: getDaemonIdentity().version,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname().slice(0, 255),
        home: options.home,
    };
    const host = new RunnerHost({
        ctx,
        identity,
        createCompute: async (computeCtx, request) =>
            createRunnerMachine(computeCtx, request, {
                home: options.home,
                hostPolicy: { privateDirectories: [...options.privateDirectories] },
            }),
    });

    let stopping = false;
    let wake: (() => void) | undefined;
    let current: { close(reason: string): void } | undefined;
    const stop = (signal: string) => {
        if (stopping) return;
        stopping = true;
        ctx.log.info(`The runner is stopping after ${signal}.`);
        current?.close("The runner is shutting down.");
        wake?.();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));

    ctx.log.info(`Happy Agent runner ${identity.version} on ${identity.hostname} is starting.`);
    let delay = FIRST_RETRY_MS;
    while (!stopping) {
        const startedAt = Date.now();
        try {
            const channel = await connectRunnerWebSocket(options.url, options.token);
            if (stopping) {
                channel.close("The runner is shutting down.");
                break;
            }
            current = channel;
            ctx.log.info("Connected to the daemon.");
            const reason = await host.serve(channel);
            current = undefined;
            ctx.log.info(`The connection to the daemon ended: ${reason}`);
            delay = Date.now() - startedAt >= HEALTHY_CONNECTION_MS ? FIRST_RETRY_MS : delay;
        } catch (error: unknown) {
            current = undefined;
            const refused = error instanceof RunnerConnectError && error.refused;
            ctx.log.warn(error instanceof Error ? error.message : String(error));
            if (refused) delay = REFUSED_RETRY_MS;
        }
        if (stopping) break;
        await sleep(jitter(delay), (resolve) => {
            wake = resolve;
        });
        wake = undefined;
        delay = Math.min(delay * 2, LAST_RETRY_MS);
    }
    await disposeHost(root.named("runner-shutdown"), host);
}

async function disposeHost(ctx: Context, host: RunnerHost): Promise<void> {
    try {
        await host.dispose(ctx);
    } catch (error: unknown) {
        ctx.log.error("The runner could not stop everything it held.", error);
        process.exitCode = 1;
    }
}

function jitter(ms: number): number {
    return Math.round(ms * (0.8 + Math.random() * 0.4));
}

async function sleep(ms: number, onWake: (resolve: () => void) => void): Promise<void> {
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        onWake(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}
