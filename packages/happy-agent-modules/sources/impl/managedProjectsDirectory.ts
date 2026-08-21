import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The folder managed projects are cloned into. `HAPPY_AGENT_PROJECTS_DIRECTORY` moves it, and must be
 * absolute so a relative value cannot make the location depend on the process working directory.
 */
export function getManagedProjectsDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configuredDirectory = environment.HAPPY_AGENT_PROJECTS_DIRECTORY?.trim();
    if (configuredDirectory !== undefined && configuredDirectory.length > 0) {
        if (!isAbsolute(configuredDirectory)) {
            throw new Error("HAPPY_AGENT_PROJECTS_DIRECTORY must be an absolute path.");
        }
        return resolve(configuredDirectory);
    }
    return join(homeDirectory, "Happy", "Projects");
}
