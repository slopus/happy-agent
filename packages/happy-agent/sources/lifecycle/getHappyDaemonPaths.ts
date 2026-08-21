import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Filesystem locations of the local Happy agent daemon. */
export interface HappyDaemonPaths {
    /** The daemon's private state directory, `<happyHome>/agent`. */
    readonly directory: string;
    /** Happy's private root, usually `~/.happy`. */
    readonly happyHome: string;
    /** Where the launcher captures the spawned daemon's stdout and stderr. */
    readonly logPath: string;
    readonly socketPath: string;
    readonly tokenPath: string;
}

export function getHappyDaemonPaths(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): HappyDaemonPaths {
    const happyHome = resolveHappyHome(environment, homeDirectory);
    const directory = join(happyHome, "agent");
    return {
        directory,
        happyHome,
        logPath: join(directory, "daemon.log"),
        socketPath: join(directory, "server.sock"),
        tokenPath: join(directory, "token"),
    };
}

function resolveHappyHome(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
    const configured = environment.HAPPY_HOME_DIR?.trim();
    if (configured === undefined || configured.length === 0) {
        return join(homeDirectory, ".happy");
    }
    const expanded = configured.startsWith("~")
        ? join(homeDirectory, configured.slice(1))
        : configured;
    return isAbsolute(expanded) ? expanded : join(homeDirectory, expanded);
}
