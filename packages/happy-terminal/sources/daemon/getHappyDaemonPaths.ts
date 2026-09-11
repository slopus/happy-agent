import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

/** Filesystem locations shared by Happy Terminal and the Happy Agent daemon. */
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
    readonly updateCachePath: string;
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
        socketPath: localAgentSocketPath(agentDirectory),
        tokenPath: join(agentDirectory, "token"),
        updateCachePath: join(distDirectory, "latest.json"),
        versionsDirectory: join(distDirectory, "version"),
    };
}

export function happyAgentBinaryPath(paths: HappyDaemonPaths, version: string): string {
    return join(
        paths.versionsDirectory,
        version,
        process.platform === "win32" ? "happy-agent.exe" : "happy-agent",
    );
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

/** Matches the daemon endpoint without coupling the terminal client to its runtime. */
function localAgentSocketPath(agentDirectory: string): string {
    if (process.platform !== "win32") return join(agentDirectory, "server.sock");
    const identity = createHash("sha256")
        .update(win32.resolve(agentDirectory).toLowerCase())
        .digest("hex");
    return `\\\\.\\pipe\\happy-agent-${identity}`;
}
