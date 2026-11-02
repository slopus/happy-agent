import { hostname } from "node:os";

import { createRunnerMachine, RunnerHost, type RunnerIdentity } from "@slopus/happy-agent-compute";
import {
    RUNNER_IDLE_TIMEOUT_MS,
    RUNNER_PING_INTERVAL_MS,
} from "@slopus/happy-agent-modules/runners/liveness";
import type { Context } from "@steve.kite/stdlib";

import { getDaemonIdentity } from "../lifecycle/getDaemonIdentity.js";

/**
 * The runner's half of the protocol on this machine: the host compute behind the native
 * supervisor, protecting the runner's own private directories, or a Docker compute when the daemon
 * asks for one. The same host serves a runner that dials its daemon and one a daemon started.
 */
export function createRunnerHostFor(
    ctx: Context,
    options: { readonly home: string; readonly privateDirectories: readonly string[] },
): { readonly host: RunnerHost; readonly identity: RunnerIdentity } {
    const identity: RunnerIdentity = {
        version: getDaemonIdentity().version,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname().slice(0, 255),
        home: options.home,
    };
    const host = new RunnerHost({
        ctx,
        identity,
        pingIntervalMs: RUNNER_PING_INTERVAL_MS,
        idleTimeoutMs: RUNNER_IDLE_TIMEOUT_MS,
        createCompute: async (computeCtx, request) =>
            createRunnerMachine(computeCtx, request, {
                home: options.home,
                hostPolicy: { privateDirectories: [...options.privateDirectories] },
            }),
    });
    return { host, identity };
}
