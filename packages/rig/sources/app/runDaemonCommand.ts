import { runAgentDaemonCommand, type AgentDaemonCommand } from "@slopus/happy-agent";

import { resolveAgentDaemonEntrypoint, toRigError } from "../client/index.js";

export type DaemonCommand = AgentDaemonCommand;

/** Runs one `rig daemon <command>` by invoking the Happy agent's own lifecycle command. */
export async function runDaemonCommand(command: DaemonCommand): Promise<void> {
    const entrypoint = resolveAgentDaemonEntrypoint();
    try {
        await runAgentDaemonCommand(command, {
            ...(entrypoint === undefined ? {} : { entrypoint }),
        });
    } catch (error) {
        throw toRigError(error);
    }
}
