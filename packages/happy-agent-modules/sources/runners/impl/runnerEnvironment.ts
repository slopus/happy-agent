import { agentPlatformSchema, type AgentEnvironment } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

/** How people name the operating systems a runner reports, when it does not name its release. */
const PLATFORM_NAMES: Partial<Record<AgentEnvironment["platform"], string>> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
};

/**
 * The machine an agent working in a folder on a runner is told about: the runner's platform as
 * it last reported it, never the daemon's. A runner that reported no release is described by its
 * platform's name, and no shell is named, because only the runner knows which one it has; an
 * agent on Windows is told about Windows PowerShell by its platform alone.
 */
export function runnerEnvironment(
    reportedPlatform: string | undefined,
    workingDirectory: string,
): AgentEnvironment {
    const platform = Value.Check(agentPlatformSchema, reportedPlatform)
        ? reportedPlatform
        : "linux";
    return {
        osVersion: PLATFORM_NAMES[platform] ?? platform,
        platform,
        shell: "",
        workingDirectory,
    };
}
