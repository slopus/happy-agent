import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { machinePaths } from "./machinePaths.js";

/**
 * The folder managed workspaces live in. Once a workspace has reserved its path that path is
 * authoritative, so moving this root only affects workspaces created afterwards. The home and
 * platform may be another machine's, a runner's, whose own path rules then lay the folder out.
 */
export function getManagedWorkspacesDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configuredDirectory = environment.HAPPY_AGENT_WORKSPACES_DIRECTORY?.trim();
    if (configuredDirectory !== undefined && configuredDirectory.length > 0) {
        if (!isAbsolute(configuredDirectory)) {
            throw new Error("HAPPY_AGENT_WORKSPACES_DIRECTORY must be an absolute path.");
        }
        return resolve(configuredDirectory);
    }
    const { join } = machinePaths(platform);
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Workspaces")
        : join(homeDirectory, "happy", "workspaces");
}
