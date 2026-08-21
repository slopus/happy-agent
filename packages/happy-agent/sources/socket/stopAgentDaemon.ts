import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";

import type { AgentDaemonPaths } from "./AgentSocket.js";
import { waitForDaemonProcessExit } from "../lifecycle/daemonPid.js";

export interface StopAgentDaemonResult {
    readonly stopped: boolean;
    readonly pid?: number;
}

export async function stopAgentDaemon(
    paths: AgentDaemonPaths,
    options: { readonly timeoutMs?: number } = {},
): Promise<StopAgentDaemonResult> {
    const token = await readToken(paths.tokenPath);
    if (token === undefined) return { stopped: false };
    const pid = await requestShutdown(paths.socketPath, token);
    if (pid === undefined) return { stopped: false };
    const timeoutMs = options.timeoutMs ?? 15_000;
    const [socketClosed, processExited] = await Promise.all([
        waitForClose(paths.socketPath, timeoutMs),
        waitForDaemonProcessExit(pid, timeoutMs),
    ]);
    void socketClosed;
    if (!processExited) {
        throw new Error(`The Happy agent process ${String(pid)} did not exit in time.`);
    }
    return { pid, stopped: true };
}

async function readToken(path: string): Promise<string | undefined> {
    try {
        const token = (await readFile(path, "utf8")).trim();
        return token.length === 0 ? undefined : token;
    } catch {
        return undefined;
    }
}

async function requestShutdown(socketPath: string, token: string): Promise<number | undefined> {
    return await new Promise<number | undefined>((resolve, reject) => {
        const call = request(
            {
                headers: { authorization: `Bearer ${token}` },
                method: "POST",
                path: "/v0/shutdown",
                socketPath,
            },
            (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;
                });
                response.on("end", () => {
                    if (response.statusCode !== 202) {
                        reject(
                            new Error(
                                `The Happy agent refused to stop (${String(response.statusCode)}).`,
                            ),
                        );
                        return;
                    }
                    resolve(readPid(body));
                });
            },
        );
        call.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
                resolve(undefined);
                return;
            }
            reject(error);
        });
        call.end();
    });
}

function readPid(body: string): number | undefined {
    try {
        const value: unknown = JSON.parse(body);
        if (typeof value !== "object" || value === null || !("pid" in value)) return undefined;
        const pid = value.pid;
        return typeof pid === "number" && Number.isInteger(pid) ? pid : undefined;
    } catch {
        return undefined;
    }
}

async function waitForClose(socketPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (!(await socketIsActive(socketPath))) return;
        if (Date.now() >= deadline) {
            throw new Error(`The Happy agent did not release ${socketPath} in time.`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
}

async function socketIsActive(socketPath: string): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = connect(socketPath);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
    });
}
