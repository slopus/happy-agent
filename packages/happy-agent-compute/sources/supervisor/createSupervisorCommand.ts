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
    const environment = options.environment ?? process.env;
    // Native Windows resolves its installation state from the actual Windows user profile.
    // App homes, project folders, and emulated HOME/USERPROFILE values must not select accounts.
    const sandboxState = environment.HAPPY_WINDOWS_SANDBOX_HOME?.trim() || undefined;
    return {
        args: [
            "--policy",
            JSON.stringify(options.policy),
            ...((options.platform ?? process.platform) === "win32"
                ? [
                      ...(environment.HAPPY_WINDOWS_SANDBOX_NO_PROVISION === "1" ||
                      process.env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION === "1"
                          ? ["--no-provision"]
                          : []),
                      ...(sandboxState === undefined ? [] : ["--state-dir", sandboxState]),
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
