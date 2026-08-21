#!/usr/bin/env node

import { AgentDaemonError } from "./lifecycle/AgentDaemonError.js";
import {
    isAgentDaemonCommand,
    runAgentDaemonCommand,
} from "./lifecycle/runAgentDaemonCommand.js";

/**
 * The `happy-agent` command line: the Happy agent is its own daemon and owns its whole boot
 * sequence. Products such as Rig only invoke these commands instead of managing the process.
 */

const USAGE = `Usage: happy-agent <command>

Commands:
  start    Start the daemon when none is running, replacing one that does not match.
  stop     Ask the running daemon to shut down.
  status   Report whether the daemon is running.
  reload   Stop the running daemon, then start a fresh one.
  run      Run the daemon in the foreground of this process.`;

installFailureReporting();

void main().catch(reportFailure);

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "--help" || command === "-h" || command === undefined) {
        console.log(USAGE);
        return;
    }
    if (rest.length > 0) {
        throw new AgentDaemonError(`The ${command} command does not take arguments.`, {
            hint: "Run happy-agent --help to see every command.",
        });
    }
    if (command === "run") {
        // The runtime import is deferred so lifecycle commands never load the whole agent.
        const { runAgentDaemon } = await import("./lifecycle/runAgentDaemon.js");
        // The daemon keeps this process alive through its socket server until it closes.
        await runAgentDaemon();
        return;
    }
    if (isAgentDaemonCommand(command)) {
        await runAgentDaemonCommand(command);
        return;
    }
    throw new AgentDaemonError(`The Happy agent does not have a command called '${command}'.`, {
        hint: "Run happy-agent --help to see every command.",
    });
}

function installFailureReporting(): void {
    let reporting = false;
    const report = (error: unknown): never => {
        // A failure raised while reporting the first one must not loop.
        if (!reporting) {
            reporting = true;
            try {
                reportFailure(error);
            } catch {
                // Exiting with a failure code still tells the shell what happened.
            }
        }
        return process.exit(1);
    };
    process.on("uncaughtException", report);
    process.on("unhandledRejection", report);
}

function reportFailure(error: unknown): void {
    if (error instanceof AgentDaemonError) {
        process.stderr.write(`${error.message}\n`);
        if (error.hint !== undefined) process.stderr.write(`${error.hint}\n`);
    } else if (error instanceof Error) {
        process.stderr.write(`${error.stack ?? error.message}\n`);
    } else {
        process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
}
