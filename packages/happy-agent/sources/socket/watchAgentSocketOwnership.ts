import { lstat, readFile } from "node:fs/promises";

import { isWindowsNamedPipe } from "./agentSocketPaths.js";

const DEFAULT_INTERVAL_MS = 30_000;

/** Why this daemon can no longer be reached by the installation it serves. */
export type AgentSocketOwnershipLoss = "socket-replaced" | "token-changed";

export interface AgentSocketOwnershipWatch {
    stop(): void;
}

/**
 * Notices once this daemon can no longer be reached: its socket path names a different file, or
 * the token file is gone or holds a different token. Clients find the daemon only through those
 * two files, so a daemon that lost either keeps the socket busy while nobody can talk to it or
 * replace it through the API. Reading the files fails only when they are gone or replaced; any
 * other read failure is treated as transient and checked again next time.
 */
export async function watchAgentSocketOwnership(options: {
    readonly socketPath: string;
    readonly tokenPath: string;
    readonly onLost: (loss: AgentSocketOwnershipLoss) => void;
    readonly intervalMs?: number;
}): Promise<AgentSocketOwnershipWatch> {
    if (isWindowsNamedPipe(options.socketPath)) return { stop: () => undefined };
    const [socket, token] = await Promise.all([
        lstat(options.socketPath).catch(() => undefined),
        readToken(options.tokenPath),
    ]);
    if (socket === undefined || token === undefined) return { stop: () => undefined };

    let checking = false;
    let stopped = false;
    const check = async (): Promise<AgentSocketOwnershipLoss | undefined> => {
        const current = await lstat(options.socketPath).catch((error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" ? null : undefined,
        );
        if (current === null || (current !== undefined && current.ino !== socket.ino)) {
            return "socket-replaced";
        }
        const currentToken = await readFile(options.tokenPath, "utf8").then(
            (text) => text.trim(),
            (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : undefined),
        );
        if (currentToken === null || (currentToken !== undefined && currentToken !== token)) {
            return "token-changed";
        }
        return undefined;
    };
    const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void check()
            .then((loss) => {
                if (loss === undefined || stopped) return;
                stopped = true;
                clearInterval(timer);
                options.onLost(loss);
            })
            .finally(() => {
                checking = false;
            });
    }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    timer.unref();
    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
}

async function readToken(path: string): Promise<string | undefined> {
    const token = await readFile(path, "utf8").then(
        (text) => text.trim(),
        () => undefined,
    );
    return token === undefined || token.length === 0 ? undefined : token;
}
