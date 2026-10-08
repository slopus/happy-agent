import type { Compute, ComputeShell } from "@slopus/happy-agent-compute";

/** What an agent is told when a command on a runner or in a container selects attached secrets. */
const SECRETS_UNAVAILABLE =
    "Secrets are not available on runners or in containers yet. Run the command without selecting secrets.";

/**
 * The same machine, refusing commands that select attached secrets.
 *
 * Attached secrets stay on the daemon, and only a command on the daemon's own machine can be given
 * them without the values leaving it. A machine elsewhere refuses the selection plainly instead of
 * running the command without what it asked for.
 */
export function refuseAttachedSecrets(compute: Compute): Compute {
    const shell = compute.shell;
    const guarded = boundCopy(shell);
    guarded.run = async (options) => {
        if ((options.secrets?.length ?? 0) > 0) throw new Error(SECRETS_UNAVAILABLE);
        return await shell.run(options);
    };
    guarded.startSession = async (options) => {
        if ((options.secrets?.length ?? 0) > 0) throw new Error(SECRETS_UNAVAILABLE);
        return await shell.startSession(options);
    };
    return { ...compute, shell: guarded };
}

/**
 * A plain object carrying the shell's own values and its methods bound to it, so replacing a
 * method here never reaches into the original and private state still resolves.
 */
function boundCopy(shell: ComputeShell): ComputeShell {
    const copy: Record<string, unknown> = {};
    for (
        let source: object | null = shell;
        source !== null && source !== Object.prototype;
        source = Object.getPrototypeOf(source) as object | null
    ) {
        for (const key of Object.getOwnPropertyNames(source)) {
            if (key === "constructor" || key in copy) continue;
            const value = (shell as unknown as Record<string, unknown>)[key];
            copy[key] =
                typeof value === "function"
                    ? (value as (...args: unknown[]) => unknown).bind(shell)
                    : value;
        }
    }
    return copy as unknown as ComputeShell;
}
