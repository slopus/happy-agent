import { randomUUID } from "node:crypto";

import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import { createDockerCompute } from "../docker/createDockerCompute.js";
import { createHostCompute } from "../host/createHostCompute.js";
import { runCleanupSteps } from "../sandbox/impl/runCleanupSteps.js";
import type { RunnerComputeRequest } from "./RunnerHost.js";

/** The runner machine's own layout, which every machine it builds protects. */
export interface RunnerMachineOptions {
    /**
     * The runner's private directories and readable material. The daemon's project policy adds
     * the protected project files on top; it can never remove anything named here.
     */
    readonly hostPolicy?: ComputeHostPolicy;
    /** The runner's home directory. Defaults to the home of the user running it. */
    readonly home?: string;
}

/**
 * Build the machine a daemon asked a runner for: the `createCompute` a real runner gives
 * `RunnerHost`.
 *
 * An ordinary request is the host compute, behind the native supervisor. A request naming a Docker
 * image runs the agent's files and commands in a container of that image with the folder mounted
 * at the same path, while the product's own programs, watches, and connections — Git, terminals,
 * previews — stay on the runner, over the same folder.
 */
export function createRunnerMachine(
    ctx: Context,
    request: RunnerComputeRequest,
    options: RunnerMachineOptions = {},
): Compute {
    const hostPolicy: ComputeHostPolicy = {
        ...options.hostPolicy,
        protectedProjectFiles: [
            ...new Set([
                ...(options.hostPolicy?.protectedProjectFiles ?? []),
                ...(request.policy.protectedProjectFiles ?? []),
            ]),
        ],
        networkPolicyFiles: [
            ...new Set([
                ...(options.hostPolicy?.networkPolicyFiles ?? []),
                ...(request.policy.networkPolicyFiles ?? []),
            ]),
        ],
    };
    const host = createHostCompute({
        ctx,
        cwd: request.cwd,
        hostPolicy,
        ...(options.home === undefined ? {} : { home: options.home }),
    });
    if (request.docker === undefined) return host;
    const container = createDockerCompute({
        docker: {
            image: request.docker.image,
            workingDirectory: request.cwd,
            mounts: [{ source: request.cwd, target: request.cwd }],
        },
        sessionId: randomUUID(),
        hostPolicy,
    });
    return {
        ...container,
        ...(host.processes === undefined ? {} : { processes: host.processes }),
        ...(host.watcher === undefined ? {} : { watcher: host.watcher }),
        ...(host.network === undefined ? {} : { network: host.network }),
        async dispose(disposeCtx: Context) {
            await runCleanupSteps("Runner container machine", [
                () => container.dispose(disposeCtx),
                () => host.dispose(disposeCtx),
            ]);
        },
    };
}
