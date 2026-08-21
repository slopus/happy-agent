import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The folder managed workspaces live in. Once a workspace has reserved its path that path is
 * authoritative, so moving this root only affects workspaces created afterwards.
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
    return platform === "darwin"
        ? join(homeDirectory, "Happy", "Workspaces")
        : join(homeDirectory, "happy", "workspaces");
}
