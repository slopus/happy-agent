import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { AgentDaemonError } from "../lifecycle/AgentDaemonError.js";

/** How this runner reaches its daemon, and what it may never let an agent read. */
export interface RunnerOptions {
    /** The WebSocket address of the daemon's `GET /v0/runners/connect`. */
    readonly url: string;
    /** The runner's token. Never logged, never handed to anything the runner starts. */
    readonly token: string;
    /** Where the daemon places the home project and bot folders on this machine. */
    readonly home: string;
    /** Directories holding the runner's own credentials, which agent commands may not read. */
    readonly privateDirectories: readonly string[];
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Read the runner's endpoint and token from its arguments and environment.
 *
 * The token comes from `HAPPY_RUNNER_TOKEN` or a token file, never from an argument, because
 * arguments are visible to every user of the machine. Both variables are removed from this
 * process's environment once read, so no command the runner starts inherits them.
 */
export function readRunnerOptions(
    args: readonly string[],
    environment: NodeJS.ProcessEnv = process.env,
): RunnerOptions {
    let endpoint = environment["HAPPY_RUNNER_ENDPOINT"];
    let tokenFile: string | undefined;
    let home = homedir();
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        const value = args[index + 1];
        if (argument === "--endpoint" || argument === "--token-file" || argument === "--home") {
            if (value === undefined || value.startsWith("--")) {
                throw new AgentDaemonError(`${argument} needs a value.`, {
                    hint: "Run happy-agent runner --help to see the runner's options.",
                });
            }
            if (argument === "--endpoint") endpoint = value;
            else if (argument === "--token-file") tokenFile = resolve(value);
            else home = resolve(value);
            index += 1;
            continue;
        }
        throw new AgentDaemonError(`The runner does not take ${argument ?? "that argument"}.`, {
            hint: "Run happy-agent runner --help to see the runner's options.",
        });
    }
    const stateDirectory = join(homedir(), ".happy-runner");
    tokenFile ??= join(stateDirectory, "token");
    let token = environment["HAPPY_RUNNER_TOKEN"]?.trim();
    delete environment["HAPPY_RUNNER_TOKEN"];
    delete environment["HAPPY_RUNNER_ENDPOINT"];
    if (token === undefined || token.length === 0) {
        try {
            token = readFileSync(tokenFile, "utf8").trim();
        } catch {
            throw new AgentDaemonError(`The runner has no token: ${tokenFile} could not be read.`, {
                hint: "Write the runner's token from the daemon's happy.toml to that file, or set HAPPY_RUNNER_TOKEN.",
            });
        }
    }
    if (!TOKEN_PATTERN.test(token)) {
        throw new AgentDaemonError("The runner's token is not a 43-character token.", {
            hint: "Copy the token exactly as it appears under [runners.<id>] in the daemon's happy.toml.",
        });
    }
    if (endpoint === undefined || endpoint.length === 0) {
        throw new AgentDaemonError("The runner does not know where its daemon is.", {
            hint: "Pass --endpoint with the daemon's address, such as https://node.example.ts.net.",
        });
    }
    if (!isAbsolute(home))
        throw new AgentDaemonError("The runner's home must be an absolute path.");
    return {
        url: runnerConnectUrl(endpoint),
        token,
        home,
        privateDirectories: [...new Set([stateDirectory, dirname(tokenFile)])],
    };
}

/** The runner route under an `http(s)://` endpoint, or under a daemon's local socket. */
function runnerConnectUrl(endpoint: string): string {
    if (endpoint.startsWith("unix:")) {
        const socketPath = endpoint.slice("unix:".length);
        if (!isAbsolute(socketPath)) {
            throw new AgentDaemonError("A unix: endpoint must name an absolute socket path.");
        }
        return `ws+unix://${socketPath}:/v0/runners/connect`;
    }
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new AgentDaemonError(`The endpoint ${endpoint} is not an address.`, {
            hint: "Use https://host, http://host:port, or unix:/path/to/socket.",
        });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new AgentDaemonError(`The endpoint ${endpoint} must use https, http, or unix.`);
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        throw new AgentDaemonError(
            "The endpoint must not carry credentials, a query, or a fragment.",
        );
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v0/runners/connect`;
    return url.toString();
}
