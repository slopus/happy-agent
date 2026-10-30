#!/usr/bin/env node

import { AgentDaemonError } from "./lifecycle/AgentDaemonError.js";
import { getDaemonIdentity } from "./lifecycle/getDaemonIdentity.js";

/**
 * The `happy-agent` command line: the Happy agent is its own daemon and owns its whole boot
 * sequence. Products such as Happy only invoke these commands instead of managing the process.
 */

const USAGE = `Usage: happy-agent <command>

Options:
  -v, --version  Show the installed Happy Agent version.

Commands:
  start    Start the daemon when none is running, replacing one that does not match
           or a Happy Agent of this user that it can no longer reach.
  drain    Drain the local daemon and wait until it is idle, without shutdown.
  stop     Ask the running daemon to shut down.
  kill     Immediately kill the daemon process recorded in its PID file.
  status   Report whether the daemon is running.
  reload   Stop the running daemon, then start a fresh one.
           --detach  Return at once and reload after this command exits, logging to
                     reload.log. An agent reloads its own daemon only this way.
  run      Run the daemon in the foreground of this process.
  runner   Run this machine as a runner for a daemon on another machine.
           --endpoint <address>  The daemon: https://host, http://host:port, unix:/socket, or
                                 tailcat:<address>[:<port>] for a standalone daemon.
           --token-file <path>   The runner's token (default ~/.happy-runner/token), or set
                                 HAPPY_RUNNER_TOKEN.
           --home <directory>    Where the home project and bot folders live (default: home).
           --stdio               Serve the daemon that started this process over standard
                                 input and output, as the user it runs as. A daemon with
                                 [execution] user starts this itself through sudo.
  sandbox setup [--retry]  Set up the Windows sandbox, or explicitly retry setup.
  sandbox status          Report Windows sandbox configuration without changing it.
  bun <arguments>         Run the Bun runtime built into the standalone binary, as bun would,
                          such as happy-agent bun run script.ts.
  artifact dev <folder>   Serve an HTML artifact's folder with a local artifact data API,
                          made-up people, and network faults, for building artifact apps.
  artifact snapshot <id>  Print a dump of an artifact's data, for artifact dev --seed.
                          Run happy-agent artifact --help for their options.`;

installFailureReporting();

void main().catch(reportFailure);

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "--help" || command === "-h" || command === undefined) {
        console.log(USAGE);
        return;
    }
    if (command === "--version" || command === "-v") {
        console.log(`Happy Agent ${getDaemonIdentity().version}`);
        return;
    }
    if (command === "runner") {
        if (rest[0] === "--help" || rest[0] === "-h") {
            console.log(USAGE);
            return;
        }
        // Only the runner's own pieces load; a runner never opens the daemon runtime.
        const { runRunner } = await import("./runner/runRunner.js");
        await runRunner(rest);
        return;
    }
    if (command === "bun") {
        // Everything after "bun" belongs to Bun, including --help and --version.
        const { runBunCommand } = await import("./binary/runBunCommand.js");
        process.exit(await runBunCommand(rest));
    }
    if (command === "artifact") {
        // Only the artifact tools load; they never start or need the daemon runtime.
        const { runArtifactCommand } = await import("./artifact/runArtifactCommand.js");
        await runArtifactCommand(rest);
        return;
    }
    if (command === "sandbox") {
        const { runSandboxCommand } = await import("./lifecycle/runSandboxCommand.js");
        await runSandboxCommand(rest);
        return;
    }
    if (command === "reload" && rest.length === 1) {
        const lifecycle = await import("./lifecycle/detachAgentDaemonReload.js");
        if (rest[0] === "--detach") {
            const logPath = await lifecycle.detachAgentDaemonReload();
            console.log("Happy Agent will reload once this command exits.");
            console.log(`Reload log: ${logPath}`);
            return;
        }
        const callerPid = lifecycle.readDetachedReloadCaller(rest[0]);
        if (callerPid !== undefined) {
            await lifecycle.runDetachedAgentDaemonReload(callerPid);
            return;
        }
    }
    if (rest.length > 0) {
        throw new AgentDaemonError(`The ${command} command does not take arguments.`, {
            hint: "Run happy-agent --help to see every command.",
        });
    }
    if (command === "run") {
        if (process.env.HAPPY_AGENT_SUPERVISE === "1") {
            // `start` asked this process to supervise the daemon instead of being it. Only the
            // supervisor loads, never the agent runtime it restarts after a crash.
            const { runAgentDaemonSupervisor } =
                await import("./lifecycle/runAgentDaemonSupervisor.js");
            process.exit(await runAgentDaemonSupervisor());
        }
        // The runtime import is deferred so lifecycle commands never load the whole agent.
        const { runAgentDaemon } = await import("./lifecycle/runAgentDaemon.js");
        // The daemon keeps this process alive through its socket server until it closes.
        try {
            await runAgentDaemon();
        } catch (error) {
            // Work a failed start left behind must not hold the process open or change the
            // exit status a supervisor reads, such as the newer-data refusal's.
            reportFailure(error);
            process.exit(process.exitCode);
        }
        return;
    }
    // Deferred like the runtime, so a crash supervisor never loads daemon lifecycle management.
    const lifecycle = await import("./lifecycle/runAgentDaemonCommand.js");
    if (lifecycle.isAgentDaemonCommand(command)) {
        await lifecycle.runAgentDaemonCommand(command);
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
    process.exitCode = error instanceof AgentDaemonError ? error.exitCode : 1;
}
