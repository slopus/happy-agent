import { runDaemonCommand, type DaemonCommand } from "./runDaemonCommand.js";
import { runApp, type RunAppOptions } from "./runApp.js";
import { runMonit } from "./runMonit.js";
import { runExec } from "./runExec.js";
import { parsePermissionMode } from "./parsePermissionMode.js";
import { parseExecCommand } from "./parseExecCommand.js";
import { parseDesktopCommand } from "./parseDesktopCommand.js";
import { parseSessionCommand } from "./parseSessionCommand.js";
import { parseSessionEnvironmentOptions } from "./parseSessionEnvironmentOptions.js";
import { formatCliHelp, formatDesktopCliHelp } from "./formatCliHelp.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { RigUserError } from "../RigUserError.js";
import { rigInspectionExitCode, runRigInspection } from "./runRigInspection.js";
import { runUpgradeCommand } from "./runUpgradeCommand.js";
import type { Context, Logger } from "@steve.kite/stdlib";
import { initializeDaemonContext, withProcessContext } from "../observability/index.js";

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
        console.log(`Rig ${readPackageVersion()}`);
        return;
    }
    if (command === "inspect") {
        if (commandArgs.length > 1 || (commandArgs.length === 1 && commandArgs[0] !== "--json")) {
            throw new RigUserError("Rig does not recognize that inspection option.", {
                hint: "Usage: rig inspect [--json]",
            });
        }
        const inspection = await runRigInspection(appCtx, {
            json: commandArgs[0] === "--json",
        });
        return rigInspectionExitCode(inspection);
    }
    if (command === "upgrade") {
        if (commandArgs.length !== 0) {
            throw new RigUserError("Rig upgrade does not take arguments.", {
                hint: "Usage: rig upgrade",
            });
        }
        await runUpgradeCommand();
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
            throw new RigUserError("Rig needs to know what to do with the daemon.", {
                hint: "Usage: rig daemon <start|stop|kill|status|reload>",
            });
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
        throw new RigUserError(`Rig does not have ${kind} called '${command}'.`, {
            hint: "Run rig --help to see everything Rig can do.",
        });
    }
    if (process.env.RIG_EFFORT !== undefined) {
        options.effort = process.env.RIG_EFFORT;
    }
    if (process.env.RIG_MODEL !== undefined) {
        options.modelId = process.env.RIG_MODEL;
    }
    if (process.env.RIG_PROVIDER !== undefined) {
        options.providerId = process.env.RIG_PROVIDER;
    }
    if (process.env.RIG_PERMISSION_MODE !== undefined) {
        options.permissionMode = parsePermissionMode(process.env.RIG_PERMISSION_MODE);
    }

    let runOptions = options;
    for (;;) {
        const result = await runApp(appCtx, runOptions);
        if (result.action === "exit") return;
        // A reload reopens the session that was already chosen, so the picker must not run again.
        const { sessionSelection: _, ...reloadOptions } = runOptions;
        runOptions = { ...reloadOptions, resumeSessionId: result.sessionId };
    }
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
