import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function getDefaultAgentDatabasePath(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configuredHome = environment.RIG_AGENT_HOME?.trim();
    const agentHome =
        configuredHome === undefined || configuredHome.length === 0
            ? join(homeDirectory, ".happy", "agent")
            : configuredHome;
    if (!isAbsolute(agentHome)) {
        throw new Error("RIG_AGENT_HOME must be an absolute path.");
    }
    return join(agentHome, "sessions.sqlite");
}
