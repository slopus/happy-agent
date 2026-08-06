import { runDaemonCommand, type DaemonCommand } from "./runDaemonCommand.js";
import { runApp, type RunAppOptions } from "./runApp.js";
import { runMonit } from "./runMonit.js";
import { runExec } from "./runExec.js";
import { parsePermissionMode } from "../permissions/index.js";
import { runLocalProtocolServer } from "../server/index.js";
import { parseExecCommand } from "./parseExecCommand.js";
import { parseDesktopCommand } from "./parseDesktopCommand.js";
import { parseSessionCommand } from "./parseSessionCommand.js";
import { parseSessionEnvironmentOptions } from "./parseSessionEnvironmentOptions.js";
import { formatCliHelp, formatDesktopCliHelp } from "./formatCliHelp.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { RigUserError } from "../RigUserError.js";
import { rigInspectionExitCode, runRigInspection } from "./runRigInspection.js";
import { runP2pBridgeCommand } from "./runP2pBridgeCommand.js";
import { runP2pPairingCommand } from "./runP2pPairingCommand.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<0 | 2 | void> {
    if (argv.length === 1 && argv[0] === "--server") {
        await runLocalProtocolServer({
            happyIntegration: "enabled",
            ...(process.env.RIG_SERVER_SOCKET_PATH !== undefined
                ? { socketPath: process.env.RIG_SERVER_SOCKET_PATH }
                : {}),
            ...(process.env.RIG_SERVER_TOKEN_PATH !== undefined
                ? { tokenPath: process.env.RIG_SERVER_TOKEN_PATH }
                : {}),
        });
        return;
    }
    if (argv.length === 3 && argv[0] === "p2p" && argv[1] === "bridge" && argv[2] === "--stdio") {
        await runP2pBridgeCommand();
        return;
    }

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
        const inspection = runRigInspection({ json: commandArgs[0] === "--json" });
        return rigInspectionExitCode(inspection);
    }
    const options: RunAppOptions = {
        cwd: process.cwd(),
        ...(parsedEnvironment.debug === true ? { debug: true } : {}),
        ...(parsedEnvironment.docker === undefined ? {} : { docker: parsedEnvironment.docker }),
    };
    if (command === "exec") {
        await runExec({
            ...parseExecCommand(commandArgs),
            ...(parsedEnvironment.debug === true ? { debug: true } : {}),
            ...(parsedEnvironment.docker === undefined ? {} : { docker: parsedEnvironment.docker }),
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
        if (parsedEnvironment.docker !== undefined) {
            throw new RigUserError(
                "A resumed or forked session keeps its existing execution environment.",
                { hint: "Drop the environment flags, or start a new session with rig." },
            );
        }
        options.sessionSelection = { command, selection: parseSessionCommand(commandArgs) };
    }
    if (command === "daemon") {
        const daemonCommand = commandArgs[0];
        if (!isDaemonCommand(daemonCommand)) {
            throw new RigUserError("Rig needs to know what to do with the daemon.", {
                hint: "Usage: rig daemon <start|stop|status|reload>",
            });
        }
        await runDaemonCommand(daemonCommand);
        return;
    }
    if (command === "invite") {
        if (commandArgs.length !== 0) {
            throw new RigUserError("Rig invite does not take arguments.", {
                hint: "Usage: rig invite",
            });
        }
        await runP2pPairingCommand("invite");
        return;
    }
    if (command === "join") {
        if (commandArgs.length !== 1) {
            throw new RigUserError("Rig needs one invitation link.", {
                hint: "Usage: rig join <rig://join/...>",
            });
        }
        await runP2pPairingCommand("join", commandArgs[0]);
        return;
    }
    if (command === "happy") {
        if (commandArgs.length !== 1 || commandArgs[0] !== "auth") {
            throw new RigUserError("Rig only supports one Happy command.", {
                hint: "Usage: rig happy auth",
            });
        }
        const { runHappyAuthCommand } = await import("../happy/index.js");
        await runHappyAuthCommand();
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
    if (process.env.OPENAI_API_KEY !== undefined) {
        options.apiKey = process.env.OPENAI_API_KEY;
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
        const result = await runApp(runOptions);
        if (result.action === "exit") return;
        // A reload reopens the session that was already chosen, so the picker must not run again.
        const { sessionSelection: _, ...reloadOptions } = runOptions;
        runOptions = { ...reloadOptions, resumeSessionId: result.sessionId };
    }
}

function isDaemonCommand(value: string | undefined): value is DaemonCommand {
    return value === "start" || value === "stop" || value === "status" || value === "reload";
}
