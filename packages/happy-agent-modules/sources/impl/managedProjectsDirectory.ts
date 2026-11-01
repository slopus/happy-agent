import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { machinePaths } from "./machinePaths.js";

/**
 * The folder managed projects are cloned into. `HAPPY_AGENT_PROJECTS_DIRECTORY` moves it, and must be
 * absolute so a relative value cannot make the location depend on the process working directory.
 * The home and platform may be a runner's, whose own path rules then lay the folder out.
 */
export function getManagedProjectsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configuredDirectory = environment.HAPPY_AGENT_PROJECTS_DIRECTORY?.trim();
    if (configuredDirectory !== undefined && configuredDirectory.length > 0) {
        if (!isAbsolute(configuredDirectory)) {
            throw new Error("HAPPY_AGENT_PROJECTS_DIRECTORY must be an absolute path.");
        }
        return resolve(configuredDirectory);
    }
    return machinePaths(platform).join(homeDirectory, "Happy", "Projects");
}
