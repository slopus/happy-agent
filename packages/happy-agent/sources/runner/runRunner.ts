import { openTailcatRemote } from "@slopus/happy-agent-modules/tailcat";
import { createRootContext, withLogger } from "@steve.kite/stdlib";

import { connectRunnerWebSocket } from "./connectRunnerWebSocket.js";
import { createRunnerHostFor } from "./createRunnerHostFor.js";
import { createRunnerLogger } from "./createRunnerLogger.js";
import { readRunnerOptions } from "./readRunnerOptions.js";
import { runStdioRunner } from "./runStdioRunner.js";
import { serveDaemon } from "./serveDaemon.js";

/**
 * Run this machine as a runner until it is stopped.
 *
 * The runner dials its daemon and keeps one connection open, reconnecting with backoff when it
 * drops; it needs no inbound port. Everything the daemon starts here belongs to the daemon process
 * that started it and ends with that process's lease, so stopping the runner — or the daemon —
 * leaves nothing running.
 */
export async function runRunner(args: readonly string[]): Promise<void> {
    // A daemon on this machine starts its workload users' runners itself, over their own pipes.
    if (args.includes("--stdio")) {
        await runStdioRunner(args);
        return;
    }
    const options = readRunnerOptions(args);
    const logger = createRunnerLogger(process.env["HAPPY_RUNNER_DEBUG"] === "1");
    const root = withLogger(createRootContext(), logger);
    const ctx = root.named("runner");
    const { host, identity } = createRunnerHostFor(ctx, options);

    // A standalone daemon is reached through one Tailcat carrier, reused across reconnects.
    const tailcat = options.tailcat;
    const remote = tailcat === undefined ? undefined : openTailcatRemote(tailcat.address);
    const dial =
        remote === undefined || tailcat === undefined
            ? undefined
            : async () => await remote.connect(tailcat.port);

    const stopping = new AbortController();
    const stop = (signal: string) => {
        if (stopping.signal.aborted) return;
        ctx.log.info(`The runner is stopping after ${signal}.`);
        stopping.abort();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));

    ctx.log.info(`Happy Agent runner ${identity.version} on ${identity.hostname} is starting.`);
    await serveDaemon({
        ctx,
        host,
        connect: async () => await connectRunnerWebSocket(options.url, options.token, dial),
        stop: stopping.signal,
        shutdownCtx: root.named("runner-shutdown"),
    });
    // Only now, with the goodbye delivered, may the carrier that carried it go.
    await remote?.close();
}
