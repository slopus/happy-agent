import { shellCommandArgs } from "../processes/impl/shellCommandArgs.js";
import type { SupervisorPolicy } from "@slopus/happy-agent-supervisor";

/** A direct supervisor invocation with the policy carried as an ordinary argument. */
export interface SupervisorCommand {
    args: readonly string[];
    command: string;
}

export function createSupervisorCommand(options: {
    command: string;
    environment?: NodeJS.ProcessEnv;
    /** Platform where the supervisor executes; containers may differ from this host. */
    platform?: NodeJS.Platform;
    cwd?: string;
    tty?: boolean;
    policy: SupervisorPolicy;
    shell: string;
    supervisorPath: string;
}): SupervisorCommand {
    return {
        args: [
            "--policy",
            JSON.stringify(options.policy),
            ...((options.platform ?? process.platform) === "win32"
                ? [
                      ...windowsStateArgs(options.environment),
                      "--cwd",
                      options.cwd ?? process.cwd(),
                      ...(options.tty === true ? ["--tty"] : []),
                  ]
                : []),
            "--",
            options.shell,
            ...shellCommandArgs(options.shell, options.command),
        ],
        command: options.supervisorPath,
    };
}

/**
 * A native Windows worker that runs many read-only commands for one workspace over its stdio.
 *
 * The worker logs on to the sandbox account and prepares its desktop and scratch directory once,
 * instead of once per command.
 */
export function createSupervisorWorkerCommand(options: {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    policy: SupervisorPolicy;
    supervisorPath: string;
}): SupervisorCommand {
    if (options.policy.mode !== "read_only") {
        throw new Error("A sandbox worker runs only read-only commands.");
    }
    return {
        args: [
            "--policy",
            JSON.stringify(options.policy),
            ...windowsStateArgs(options.environment),
            "--cwd",
            options.cwd,
            "--worker",
        ],
        command: options.supervisorPath,
    };
}

/**
 * A native Windows runner that runs one workspace's shell commands, concurrently, under one policy.
 *
 * Each command arrives on stdin with its own argv and complete environment; the runner holds none
 * of its own to pass on.
 */
export function createSupervisorShellRunnerCommand(options: {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    policy: SupervisorPolicy;
    supervisorPath: string;
}): SupervisorCommand {
    return {
        args: [
            "--policy",
            JSON.stringify(options.policy),
            ...windowsStateArgs(options.environment),
            "--cwd",
            options.cwd,
            "--shell-runner",
        ],
        command: options.supervisorPath,
    };
}

function windowsStateArgs(environment: NodeJS.ProcessEnv = process.env): string[] {
    // Native Windows resolves its installation state from the actual Windows user profile.
    // App homes, project folders, and emulated HOME/USERPROFILE values must not select accounts.
    const sandboxState = environment.HAPPY_WINDOWS_SANDBOX_HOME?.trim() || undefined;
    return [
        ...(environment.HAPPY_WINDOWS_SANDBOX_NO_PROVISION === "1" ||
        process.env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION === "1"
            ? ["--no-provision"]
            : []),
        // A background launch, such as a Git scan, must never open the administrator prompt.
        // Only the command's own environment says so, never the daemon's. It is also part of the
        // arguments, so a shared shell runner is never reused between a scan and an agent command.
        ...(environment.HAPPY_WINDOWS_SANDBOX_BACKGROUND === "1" ? ["--background"] : []),
        ...(sandboxState === undefined ? [] : ["--state-dir", sandboxState]),
    ];
}
