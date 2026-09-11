import type { SupervisorPolicy } from "@slopus/happy-agent-supervisor";

import {
    createSupervisorCommand,
    type SupervisorCommand,
} from "../../supervisor/createSupervisorCommand.js";

/** The fixed read-only mount used by managed and explicitly prepared containers. */
export const DOCKER_SUPERVISOR_PATH = "/tools/happy-agent-sandbox";

/**
 * Creates the in-container command that gives one command-scoped policy to the mounted native
 * supervisor as an ordinary argument, matching Codex's direct macOS Seatbelt invocation.
 */
export function createDockerSupervisorCommand(options: {
    command: string;
    policy: SupervisorPolicy;
    shell: string;
    supervisorPath?: string;
}): SupervisorCommand {
    return createSupervisorCommand({
        command: options.command,
        policy: options.policy,
        platform: "linux",
        shell: options.shell,
        supervisorPath: options.supervisorPath ?? DOCKER_SUPERVISOR_PATH,
    });
}
