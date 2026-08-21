import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function getHappyTerminalHome(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configuredHome = environment.HAPPY_TERMINAL_HOME?.trim();
    if (!configuredHome) {
        return join(homeDirectory, ".happy", "happy-terminal");
    }
    if (!isAbsolute(configuredHome)) {
        throw new Error("HAPPY_TERMINAL_HOME must be an absolute path.");
    }
    return configuredHome;
}
