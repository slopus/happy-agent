import { isAbsolute } from "node:path";
import { homedir } from "node:os";

import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeHostPolicy } from "../ComputeHostPolicy.js";
import { NativeProcessManager } from "../processes/index.js";
import { createHostFileSystem } from "./createHostFileSystem.js";
import { createHostShell } from "./createHostShell.js";
import { createHostServices } from "../services/createHostServices.js";
import { runCleanupSteps } from "../sandbox/impl/runCleanupSteps.js";
import { HOST_SESSION_STOP_GRACE_MS } from "./impl/hostSessionLimits.js";

export interface HostComputeOptions {
    /**
     * The context that owns this compute's lifetime. Background processes and the delayed force of
     * a stopped one are derived from it, never from the tool call that happened to start them, so a
     * completed call is never retained by work it left running.
     */
    ctx: Context;
    /** The directory the agent works in, fixed at construction. */
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    hostPolicy?: ComputeHostPolicy;
    /** The home directory used to expand `~` and to bound sensitive host reads. */
    home?: string;
    /**
     * Process lifetime manager shared with the caller. A supplied manager remains caller-owned
     * when this compute is disposed.
     */
    processManager?: NativeProcessManager;
    platform?: NodeJS.Platform;
    /** Existing administrator delegation for strict services; never creates or changes it. */
    serviceCgroupParent?: string;
}

/**
 * Creates a compute over the real machine this process runs on: its own filesystem and a real
 * shell, with the working directory fixed at construction.
 *
 * By default the compute owns what it starts. A command left running in the background belongs to
 * it, and {@link Compute.dispose} ends both the processes still under the manager's watch and the
 * process groups that outlived the shell that launched them. An injected manager instead belongs
 * to the caller, which uses it for broader session lifecycle control.
 */
export function createHostCompute(options: HostComputeOptions): Compute {
    const cwd = isAbsolute(options.cwd)
        ? options.cwd
        : (() => {
              throw new Error("The host compute working directory must be an absolute path.");
          })();
    const processManager = options.processManager ?? new NativeProcessManager(options.ctx);
    const ownsProcessManager = options.processManager === undefined;
    const home = options.home ?? homedir();
    const fs = createHostFileSystem({
        cwd,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
        home,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
    const shell = createHostShell({
        ctx: options.ctx,
        cwd,
        processManager,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
        homeDirectory: home,
    });

    const services = createHostServices({
        ctx: options.ctx,
        cwd,
        processManager,
        homeDirectory: home,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.hostPolicy === undefined ? {} : { hostPolicy: options.hostPolicy }),
        ...(options.serviceCgroupParent === undefined
            ? {}
            : { cgroupParent: options.serviceCgroupParent }),
    });

    return {
        id: "host",
        kind: "host",
        cwd,
        fs,
        shell,
        services,
        async dispose(ctx: Context) {
            shell.setSessionExitListener?.(undefined);
            shell.setActiveSessionCountListener?.(undefined);
            await runCleanupSteps("host compute", [
                () => services.dispose(ctx),
                async () => {
                    await shell.killAllSessions?.();
                },
                async () => {
                    if (ownsProcessManager)
                        await processManager.killAll(ctx, {
                            includeDetached: true,
                            forceAfterMs: HOST_SESSION_STOP_GRACE_MS,
                        });
                },
            ]);
        },
    };
}
