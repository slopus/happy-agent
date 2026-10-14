import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { detach, type Context } from "@steve.kite/stdlib";

import type { SupervisorCommand } from "../../supervisor/index.js";
import { SandboxShellRunner } from "./SandboxShellRunner.js";

const runners = new Map<string, SandboxShellRunner>();

/**
 * The shared runner for one exact sandbox: the same supervisor, policy, state, and workspace.
 *
 * The key hashes the runner's whole command line, so two callers share a runner only when every
 * permission it was prepared with is identical. Agents working in the same workspace with the same
 * permissions therefore share one sandbox logon and one private desktop. A runner lives in its own
 * named context derived from the root, never in the context of the call that first needed it, and
 * is forgotten once it stops for lack of work.
 */
export function sandboxShellRunnerFor(
    ctx: Context,
    command: SupervisorCommand,
    environment: NodeJS.ProcessEnv,
): SandboxShellRunner {
    const key = createHash("sha256")
        .update(JSON.stringify([command.command, command.args]))
        .digest("hex");
    const existing = runners.get(key);
    if (existing !== undefined) return existing;
    const runner: SandboxShellRunner = new SandboxShellRunner({
        args: command.args,
        command: command.command,
        ctx: detach(ctx).named(`compute.shell-runner.${key.slice(0, 12)}`),
        environment,
        onIdleStop: () => {
            if (runners.get(key) === runner) runners.delete(key);
        },
        // The runner names the workspace with `--cwd`; its own working directory stays elsewhere,
        // because Windows refuses to delete a folder a live process works in.
        processCwd: dirname(command.command),
    });
    runners.set(key, runner);
    return runner;
}

/** Stops every shared runner and every command they run, for a daemon that is shutting down. */
export async function disposeSandboxShellRunners(): Promise<void> {
    const all = [...runners.values()];
    runners.clear();
    await Promise.all(all.map((runner) => runner.dispose()));
}
