import { computePermissions, type Compute } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

/** Setup commands are the project's own instructions, so they run with the product's authority. */
const PRODUCT = computePermissions("full_access");
const WORKSPACE_SETUP_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const WORKSPACE_SETUP_OUTPUT_LIMIT = 512 * 1_024;
const WORKSPACE_SETUP_ERROR_OUTPUT_LIMIT = 300;

/**
 * Runs a workspace's setup commands, one after another, in its own folder.
 *
 * The commands are the project's own instructions for making a fresh checkout usable, so they run
 * through the shell of the machine the folder is on exactly as written. They run sequentially
 * because a later one normally depends on an earlier one having finished, each is bounded in time
 * and output, and archiving the workspace stops the sequence where it stands.
 */
export async function runWorkspaceSetupCommands(
    ctx: Context,
    machine: Compute,
    cwd: string,
    commands: readonly string[],
    options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
    for (const [index, command] of commands.entries()) {
        options.signal?.throwIfAborted();
        ctx.lifetime?.throwIfAborted();
        const result = await machine.shell.run({
            command,
            cwd,
            maxOutputBytes: WORKSPACE_SETUP_OUTPUT_LIMIT,
            permissions: PRODUCT,
            timeoutMs: WORKSPACE_SETUP_COMMAND_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        options.signal?.throwIfAborted();
        if (result.exitCode === 0 && !result.timedOut) continue;
        const status = result.timedOut
            ? `timed out after ${String(WORKSPACE_SETUP_COMMAND_TIMEOUT_MS / 60_000)} minutes`
            : `failed with exit code ${String(result.exitCode)}`;
        const output = tail(
            `${result.stdout}\n${result.stderr}`,
            WORKSPACE_SETUP_ERROR_OUTPUT_LIMIT,
        );
        throw new Error(
            [
                `Workspace setup command ${String(index + 1)} ${status}.`,
                ...(output.length === 0 ? [] : [output]),
                `Command: ${command}`,
            ].join("\n"),
        );
    }
}

function tail(value: string, limit: number): string {
    const normalized = value.trim();
    return normalized.length <= limit ? normalized : `…${normalized.slice(-limit)}`;
}
