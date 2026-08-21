import { spawn } from "node:child_process";
import { basename } from "node:path";

import type { Context } from "@steve.kite/stdlib";

const WORKSPACE_SETUP_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const WORKSPACE_SETUP_OUTPUT_LIMIT = 512 * 1_024;
const WORKSPACE_SETUP_ERROR_OUTPUT_LIMIT = 300;

export interface RunWorkspaceSetupCommandsOptions {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}

/**
 * Runs a workspace's setup commands, one after another, in its own folder.
 *
 * The commands are the project's own instructions for making a fresh checkout usable, so they run
 * through the person's shell exactly as written. They run sequentially because a later one
 * normally depends on an earlier one having finished, each is bounded in time and output, and
 * archiving the workspace stops the sequence where it stands.
 */
export async function runWorkspaceSetupCommands(
    ctx: Context,
    cwd: string,
    commands: readonly string[],
    options: RunWorkspaceSetupCommandsOptions = {},
): Promise<void> {
    if (commands.length === 0) return;
    const environment = options.environment ?? process.env;
    const shell = resolveSystemShell(environment);

    for (const [index, command] of commands.entries()) {
        options.signal?.throwIfAborted();
        ctx.lifetime?.throwIfAborted();
        const result = await runOne(shell, shellArgs(shell, command), cwd, environment, options);
        if (result.aborted) {
            throw options.signal?.reason ?? new Error("Workspace setup was stopped.");
        }
        if (result.exitCode === 0 && !result.timedOut) continue;

        const number = index + 1;
        const status = result.timedOut
            ? `timed out after ${String(WORKSPACE_SETUP_COMMAND_TIMEOUT_MS / 60_000)} minutes`
            : `failed with exit code ${String(result.exitCode)}`;
        const output = tail(result.output, WORKSPACE_SETUP_ERROR_OUTPUT_LIMIT);
        throw new Error(
            [
                `Workspace setup command ${String(number)} ${status}.`,
                ...(output.length === 0 ? [] : [output]),
                `Command: ${command}`,
            ].join("\n"),
        );
    }
}

interface SetupCommandResult {
    aborted: boolean;
    exitCode: number;
    output: string;
    timedOut: boolean;
}

async function runOne(
    shell: string,
    args: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    options: RunWorkspaceSetupCommandsOptions,
): Promise<SetupCommandResult> {
    return await new Promise<SetupCommandResult>((settle) => {
        const child = spawn(shell, [...args], {
            cwd,
            env: shellEnvironment(environment),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let bytes = 0;
        let aborted = false;
        let timedOut = false;
        let finished = false;

        const collect = (chunk: Buffer) => {
            if (bytes >= WORKSPACE_SETUP_OUTPUT_LIMIT) return;
            const room = WORKSPACE_SETUP_OUTPUT_LIMIT - bytes;
            const slice = chunk.subarray(0, room);
            bytes += slice.byteLength;
            output += slice.toString("utf8");
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, WORKSPACE_SETUP_COMMAND_TIMEOUT_MS);
        timer.unref?.();

        const stop = () => {
            aborted = true;
            child.kill("SIGKILL");
        };
        options.signal?.addEventListener("abort", stop, { once: true });

        const finish = (exitCode: number) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", stop);
            settle({ aborted, exitCode, output, timedOut });
        };
        child.on("error", () => {
            finish(127);
        });
        child.on("close", (code, signal) => {
            finish(code ?? (signal === null ? 1 : 128));
        });
    });
}

function resolveSystemShell(environment: NodeJS.ProcessEnv): string {
    if (process.platform === "win32") return environment.ComSpec ?? "cmd.exe";
    return environment.SHELL ?? "/bin/sh";
}

function shellArgs(shell: string, command: string): string[] {
    if (process.platform !== "win32") return ["-lc", command];
    const name = basename(shell).toLowerCase();
    return name === "cmd.exe" || name === "cmd" ? ["/d", "/s", "/c", command] : ["-c", command];
}

/** Happy Agent's own configuration variables are not part of the person's project environment. */
function shellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(environment).filter(
            ([name, value]) =>
                value !== undefined && !name.toUpperCase().startsWith("HAPPY_AGENT_"),
        ),
    );
}

function tail(value: string, limit: number): string {
    const normalized = value.trim();
    return normalized.length <= limit ? normalized : `…${normalized.slice(-limit)}`;
}
