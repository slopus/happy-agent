import type { Compute } from "@slopus/happy-agent-compute";

import { boundShellCopy } from "./boundShellCopy.js";

/** What an agent is told when a command in a container selects attached secrets. */
const SECRETS_UNAVAILABLE =
    "Secrets are not available in containers yet. Run the command without selecting secrets.";

/**
 * The same machine, refusing commands that select attached secrets.
 *
 * A container cannot give one command an environment of its own, so it refuses the selection
 * plainly instead of running the command without what it asked for.
 */
export function refuseAttachedSecrets(compute: Compute): Compute {
    const shell = compute.shell;
    const guarded = boundShellCopy(shell);
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
