import type { Compute, ComputeRunOptions } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { SecretsModule } from "../../secrets/index.js";
import { boundShellCopy } from "./boundShellCopy.js";
import { secretCommandTargets } from "./secretCommandTargets.js";

export interface ForwardAttachedSecretsOptions {
    readonly agentId: string;
    readonly ctx: Context;
    readonly secrets: SecretsModule;
    readonly targetScope?: {
        readonly projectId?: string;
        readonly workspaceId?: string;
    };
}

/**
 * The same machine, giving commands that select attached secrets their values.
 *
 * The machine is a runner, on another computer or serving a workload user on this one. Its shell
 * takes a per-command environment instead of bundle IDs, so a selection is resolved here and sent
 * with that one command, along with removals for every other attached secret's variable so the
 * runner's own environment cannot stand in for one that was not selected. The runner forgets the
 * values once the process has spawned. A command that selects nothing is sent unchanged, which
 * keeps older runners working for everything but secrets.
 */
export function forwardAttachedSecrets(
    compute: Compute,
    options: ForwardAttachedSecretsOptions,
): Compute {
    const shell = compute.shell;
    const forwarding = boundShellCopy(shell);
    /** The options to send, with the selection resolved, and how to forget its values after. */
    const resolve = async (
        runOptions: ComputeRunOptions,
    ): Promise<{ readonly sent: ComputeRunOptions; readonly forget: () => void }> => {
        const { secrets: selected, ...rest } = runOptions;
        if (selected === undefined || selected.length === 0) {
            return { sent: rest, forget: () => undefined };
        }
        const resolved = await options.secrets.resolveForCommandTargets(
            options.ctx,
            secretCommandTargets(options.agentId, options.targetScope),
            selected,
        );
        const environment: Record<string, string | null> = { ...resolved.environment };
        for (const name of resolved.hiddenEnvironmentVariables) {
            if (!(name in environment)) environment[name] = null;
        }
        return {
            sent: { ...rest, environment },
            forget: () => {
                for (const name of Object.keys(environment)) delete environment[name];
            },
        };
    };
    forwarding.run = async (runOptions) => {
        const { sent, forget } = await resolve(runOptions);
        try {
            return await shell.run(sent);
        } finally {
            forget();
        }
    };
    forwarding.startSession = async (runOptions) => {
        const { sent, forget } = await resolve(runOptions);
        try {
            return await shell.startSession(sent);
        } finally {
            forget();
        }
    };
    return { ...compute, shell: forwarding };
}
