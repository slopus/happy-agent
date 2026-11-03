import type { RunnerHost } from "@slopus/happy-agent-compute";
import { RUNNER_CLOSE_FLUSH_MS } from "@slopus/happy-agent-modules/runners/liveness";
import type { Context } from "@steve.kite/stdlib";

import { RunnerConnectError, type RunnerWebSocketChannel } from "./connectRunnerWebSocket.js";
import { disposeHost } from "./disposeHost.js";

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 30_000;
/**
 * The longest wait between attempts soon after a connection ended. A daemon that said goodbye is
 * usually restarting, and the runner should be back within seconds of it, not half a minute.
 */
const RECOVERY_RETRY_MS = 5_000;
/** How long after a connection ended the runner keeps retrying at the recovery pace. */
const RECOVERY_WINDOW_MS = 60_000;
/** A refused token is a configuration change away from working, so it is retried slowly. */
const REFUSED_RETRY_MS = 60_000;
/** A connection that lasted this long was healthy, so the next drop retries quickly again. */
const HEALTHY_CONNECTION_MS = 60_000;

export interface ServeDaemonOptions {
    readonly ctx: Context;
    readonly host: RunnerHost;
    /** Open one connection to the daemon. */
    readonly connect: () => Promise<RunnerWebSocketChannel>;
    /** Aborted when the runner should stop. */
    readonly stop: AbortSignal;
    /** Where shutdown work is logged. */
    readonly shutdownCtx: Context;
}

/**
 * Keep one connection to the daemon open until `stop` is aborted, reconnecting with backoff, then
 * stop everything the runner holds.
 *
 * Stopping says goodbye on the open connection before anything else, so the daemon learns of it
 * at once rather than after its idle timeout, and resolves only once that connection has closed
 * or a short bound has passed. The caller may then close the carrier underneath.
 */
export async function serveDaemon(options: ServeDaemonOptions): Promise<void> {
    const { ctx, host, stop } = options;
    let wake: (() => void) | undefined;
    let current: RunnerWebSocketChannel | undefined;
    let disposing: Promise<void> | undefined;
    const onStop = () => {
        // Disposal releases the daemon's machines with a goodbye on the open connection first.
        disposing ??= disposeHost(options.shutdownCtx, host);
        wake?.();
    };
    if (stop.aborted) onStop();
    else stop.addEventListener("abort", onStop, { once: true });

    let delay = FIRST_RETRY_MS;
    let lastEndedAt: number | undefined;
    while (!stop.aborted) {
        const startedAt = Date.now();
        try {
            const channel = await options.connect();
            if (stop.aborted) {
                channel.close("The runner is shutting down.");
                break;
            }
            current = channel;
            ctx.log.info("Connected to the daemon.");
            const reason = await host.serve(channel);
            if (stop.aborted) break;
            current = undefined;
            lastEndedAt = Date.now();
            ctx.log.info(`The connection to the daemon ended: ${reason}`);
            delay = lastEndedAt - startedAt >= HEALTHY_CONNECTION_MS ? FIRST_RETRY_MS : delay;
        } catch (error: unknown) {
            current = undefined;
            const refused = error instanceof RunnerConnectError && error.refused;
            ctx.log.warn(error instanceof Error ? error.message : String(error));
            if (refused) delay = REFUSED_RETRY_MS;
        }
        if (stop.aborted) break;
        await sleep(jitter(delay), (resolve) => {
            wake = resolve;
        });
        wake = undefined;
        const recovering =
            lastEndedAt !== undefined && Date.now() - lastEndedAt < RECOVERY_WINDOW_MS;
        delay = Math.min(
            delay * 2,
            recovering && delay < REFUSED_RETRY_MS ? RECOVERY_RETRY_MS : LAST_RETRY_MS,
        );
    }
    stop.removeEventListener("abort", onStop);
    await (disposing ?? disposeHost(options.shutdownCtx, host));
    if (current !== undefined) await bounded(current.ended, RUNNER_CLOSE_FLUSH_MS);
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

async function bounded(work: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
        work,
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]);
    clearTimeout(timer);
}
