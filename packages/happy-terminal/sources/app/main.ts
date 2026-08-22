import { runDaemonCommand, type DaemonCommand } from "./runDaemonCommand.js";
import type { RunAppOptions } from "./runApp.js";
import { runMonit } from "./runMonit.js";
import { runExec } from "./runExec.js";
import { parsePermissionMode } from "./parsePermissionMode.js";
import { parseExecCommand } from "./parseExecCommand.js";
import { parseDesktopCommand } from "./parseDesktopCommand.js";
import { parseSessionCommand } from "./parseSessionCommand.js";
import { parseSessionEnvironmentOptions } from "./parseSessionEnvironmentOptions.js";
import { formatCliHelp, formatDesktopCliHelp } from "./formatCliHelp.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import {
    happyTerminalInspectionExitCode,
    runHappyTerminalInspection,
} from "./runHappyTerminalInspection.js";
import { runUpgradeCommand } from "./runUpgradeCommand.js";
import type { Context, Logger } from "@steve.kite/stdlib";
import { initializeDaemonContext, withProcessContext } from "../observability/index.js";
import { runHappyTerminalWithContext } from "../runHappyTerminal.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<0 | 2 | void> {
    initializeDaemonContext(cliLogger());
    return await withProcessContext("cli", (ctx) => runMain(ctx, argv));
}

async function runMain(appCtx: Context, argv: readonly string[]): Promise<0 | 2 | void> {
    const parsedEnvironment = parseSessionEnvironmentOptions(argv);
    argv = parsedEnvironment.remaining;
    const [command, ...commandArgs] = argv;
    if (command === "--help" || command === "-h") {
        console.log(formatCliHelp());
        return;
    }
    if (command === "--version" || command === "-v") {
        console.log(`Happy Terminal ${readPackageVersion()}`);
        return;
    }
    if (command === "inspect") {
        if (commandArgs.length > 1 || (commandArgs.length === 1 && commandArgs[0] !== "--json")) {
            throw new HappyTerminalUserError(
                "Happy Terminal does not recognize that inspection option.",
                {
                    hint: "Usage: happy-terminal inspect [--json]",
                },
            );
        }
        const inspection = await runHappyTerminalInspection(appCtx, {
            json: commandArgs[0] === "--json",
        });
        return happyTerminalInspectionExitCode(inspection);
    }
    if (command === "upgrade") {
        if (commandArgs.length !== 0) {
            throw new HappyTerminalUserError("Happy Agent upgrade does not take arguments.", {
                hint: "Usage: happy-terminal upgrade",
            });
        }
        await runUpgradeCommand({ ctx: appCtx, log: console.log });
        return;
    }
    const options: RunAppOptions = {
        cwd: process.cwd(),
        ...(parsedEnvironment.debug === true ? { debug: true } : {}),
    };
    if (command === "exec") {
        await runExec({
            ...parseExecCommand(commandArgs),
            ...(parsedEnvironment.debug === true ? { debug: true } : {}),
        });
        return;
    }
    if (command === "desktop") {
        if (commandArgs.length === 1 && (commandArgs[0] === "--help" || commandArgs[0] === "-h")) {
            console.log(formatDesktopCliHelp());
            return;
        }
        const { runDesktop } = await import("./runDesktop.js");
        await runDesktop(parseDesktopCommand(commandArgs));
        return;
    }
    if (command === "resume" || command === "fork") {
        options.sessionSelection = { command, selection: parseSessionCommand(commandArgs) };
    }
    if (command === "daemon") {
        const daemonCommand = commandArgs[0];
        if (!isDaemonCommand(daemonCommand)) {
            throw new HappyTerminalUserError(
                "Happy Terminal needs to know what to do with the daemon.",
                {
                    hint: "Usage: happy-terminal daemon <start|stop|kill|status|reload>",
                },
            );
        }
        await runDaemonCommand(daemonCommand, console.log, appCtx);
        return;
    }
    if (command === "monit") {
        await runMonit();
        return;
    }
    if (command !== undefined && command !== "resume" && command !== "fork") {
        const kind = command.startsWith("-") ? "an option" : "a command";
        throw new HappyTerminalUserError(
            `Happy Terminal does not have ${kind} called '${command}'.`,
            {
                hint: "Run happy-terminal --help to see everything Happy Terminal can do.",
            },
        );
    }
    if (process.env.HAPPY_TERMINAL_EFFORT !== undefined) {
        options.effort = process.env.HAPPY_TERMINAL_EFFORT;
    }
    if (process.env.HAPPY_TERMINAL_MODEL !== undefined) {
        options.modelId = process.env.HAPPY_TERMINAL_MODEL;
    }
    if (process.env.HAPPY_TERMINAL_PROVIDER !== undefined) {
        options.providerId = process.env.HAPPY_TERMINAL_PROVIDER;
    }
    if (process.env.HAPPY_TERMINAL_PERMISSION_MODE !== undefined) {
        options.permissionMode = parsePermissionMode(process.env.HAPPY_TERMINAL_PERMISSION_MODE);
    }

    await runHappyTerminalWithContext(appCtx, { ...options, commandName: "happy-terminal" });
}

function cliLogger(): Logger {
    const write = () => undefined;
    return { debug: write, error: write, fatal: write, info: write, trace: write, warn: write };
}

function isDaemonCommand(value: string | undefined): value is DaemonCommand {
    return (
        value === "start" ||
        value === "stop" ||
        value === "kill" ||
        value === "status" ||
        value === "reload"
    );
}
