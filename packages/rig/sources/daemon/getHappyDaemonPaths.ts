import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Filesystem locations shared by Rig and the Happy Agent daemon. */
export interface HappyDaemonPaths {
    readonly agentDirectory: string;
    readonly binaryConfigPath: string;
    readonly distDirectory: string;
    readonly happyHome: string;
    readonly installLockPath: string;
    readonly logPath: string;
    readonly observationLogPath: string;
    readonly pidPath: string;
    readonly socketPath: string;
    readonly tokenPath: string;
    readonly versionsDirectory: string;
}

export function getHappyDaemonPaths(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): HappyDaemonPaths {
    const happyHome = resolveHappyHome(environment, homeDirectory);
    const agentDirectory = join(happyHome, "agent");
    const distDirectory = join(happyHome, "dist");
    return {
        agentDirectory,
        binaryConfigPath: join(distDirectory, "config.json"),
        distDirectory,
        happyHome,
        installLockPath: join(distDirectory, "install.lock"),
        logPath: join(agentDirectory, "daemon.log"),
        observationLogPath: join(agentDirectory, "observation", "agent.log"),
        pidPath: join(agentDirectory, "daemon.pid"),
        socketPath: join(agentDirectory, "server.sock"),
        tokenPath: join(agentDirectory, "token"),
        versionsDirectory: join(distDirectory, "version"),
    };
}

export function happyAgentBinaryPath(paths: HappyDaemonPaths, version: string): string {
    return join(paths.versionsDirectory, version, "happy-agent");
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
