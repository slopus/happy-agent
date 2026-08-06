import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSandboxFilesystemConfig } from "./createSandboxFilesystemConfig.js";
import { createSandboxConfigDirectoryCache } from "./createSandboxConfigDirectoryCache.js";
import { createLinuxBubblewrapCommand } from "./createLinuxBubblewrapCommand.js";
import { createMacOsSeatbeltCommand } from "./createMacOsSeatbeltCommand.js";
import { materializeSandboxConfig } from "./materializeSandboxConfig.js";
import type { PermissionMode } from "../../permissions/index.js";
import { quoteShellArgument } from "./quoteShellArgument.js";
import type { ProjectConfigPlaceholder } from "./prepareProjectConfigPlaceholder.js";

const require = createRequire(import.meta.url);
const getConfigDirectory = createSandboxConfigDirectoryCache(() =>
    mkdtemp(join(tmpdir(), "rig-sandbox-")),
);

export interface SandboxedCommand {
    args?: readonly string[];
    command: string;
    projectConfigPlaceholder?: ProjectConfigPlaceholder;
    protectedCreatePaths?: readonly string[];
}

export async function createSandboxedCommand(options: {
    /**
     * Run this exact argument vector instead of a shell command. Background readers use it so they
     * never build a shell string and never source the user's login profile.
     */
    argv?: readonly string[];
    command: string;
    commandCwd?: string;
    cwd: string;
    mode: PermissionMode;
    networkAllowLocalBinding?: boolean;
    networkAllowedLoopbackPorts?: readonly number[];
    networkUnixProxySockets?: {
        authenticationToken: string;
        http: string;
        loopback?: readonly { path: string; port: number }[];
        socks: string;
    };
    path?: string;
    protectedPaths?: readonly string[];
    shell: string;
}): Promise<SandboxedCommand> {
    if (options.mode === "full_access") {
        return options.argv === undefined
            ? { command: options.command }
            : { args: options.argv.slice(1), command: options.argv[0]! };
    }
    if (process.platform === "darwin") return createMacOsSeatbeltCommand(options);
    if (process.platform === "linux") {
        return createLinuxBubblewrapCommand({
            ...options,
            commandCwd: options.commandCwd ?? options.cwd,
            mode: options.mode,
            mountProc: !(
                process.env.RIG_GYM_OUTER_ISOLATION === "docker" && existsSync("/.dockerenv")
            ),
        });
    }

    const configDirectory = await getConfigDirectory();
    const config = {
        // Gym's disposable Docker container is the outer isolation layer for nested sandbox tests.
        enableWeakerNestedSandbox:
            process.env.RIG_GYM_OUTER_ISOLATION === "docker" && existsSync("/.dockerenv"),
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: await createSandboxFilesystemConfig({
            ...options,
            sandboxConfigDirectory: configDirectory,
        }),
    };
    const configPath = await materializeSandboxConfig(configDirectory, config);

    const packageEntry = require.resolve("@anthropic-ai/sandbox-runtime");
    const cliPath = join(dirname(packageEntry), "cli.js");
    // The sandbox-runtime CLI only accepts a command string, so an argument vector is rebuilt into
    // one with each element quoted individually rather than concatenated by a caller.
    const requestedCommand =
        options.argv === undefined
            ? options.command
            : options.argv.map((argument) => quoteShellArgument(argument)).join(" ");
    const userCommand =
        options.path === undefined
            ? requestedCommand
            : `export PATH=${quoteShellArgument(options.path)}\n${requestedCommand}`;
    const command =
        process.platform === "win32"
            ? requestedCommand
            : `${quoteShellArgument(options.shell)} -lc ${quoteShellArgument(userCommand)}`;
    return {
        args: [cliPath, "--settings", configPath, "-c", command],
        command: process.execPath,
    };
}
