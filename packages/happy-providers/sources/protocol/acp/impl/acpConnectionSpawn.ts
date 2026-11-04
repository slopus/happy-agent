import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import type { AcpConnection } from "@/protocol/acp/AcpConnection.js";
import { processTreeGroups, terminateProcessTree } from "@/protocol/acp/impl/processTree.js";

const INITIALIZE_TIMEOUT_MS = 60_000;

/**
 * Start the agent and complete the ACP handshake. Happy advertises no filesystem or terminal
 * capability: the foreign agent works on the real machine with its own tools.
 */
export async function acpConnectionSpawn(
    launch: AcpAgentLaunch,
    cwd: string,
    client: acp.Client,
): Promise<AcpConnection> {
    // The agent leads its own process group so it does not die with the daemon's terminal.
    const child = spawn(launch.command, [...(launch.args ?? [])], {
        cwd,
        detached: process.platform !== "win32",
        env: { ...process.env, ...launch.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    // Agents leave a running command alive when their turn is cancelled, and some start each
    // command in a process group of its own, so stopping ends every group in the agent's tree.
    const processGroups = (): number[] => processTreeGroups(child.pid);
    const terminate = (groups: readonly number[] = []): void => terminateProcessTree(child, groups);
    // A detached agent no longer dies with the daemon, so the daemon ends it itself.
    const terminateOnExit = (): void => terminate();
    process.once("exit", terminateOnExit);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const failed = new Promise<never>((_, reject) => {
        child.once("error", reject);
    });
    const exited = new Promise<Error>((resolve) => {
        child.once("exit", (code, signalName) => {
            process.removeListener("exit", terminateOnExit);
            resolve(
                new Error(
                    `The agent process exited (${signalName ?? `code ${code ?? "unknown"}`}).`,
                ),
            );
        });
    });
    const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const conn = new acp.ClientSideConnection(() => client, stream);
    try {
        const init = await Promise.race([
            conn.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false,
                },
            }),
            failed,
            new Promise<never>((_, reject) => {
                setTimeout(
                    () => reject(new Error("The agent did not answer initialize.")),
                    INITIALIZE_TIMEOUT_MS,
                ).unref();
            }),
        ]);
        return { conn, init, exited, stderr: () => stderr, processGroups, terminate };
    } catch (error) {
        terminate();
        const tail = stderr.trim();
        throw tail.length === 0 || !(error instanceof Error)
            ? error
            : new Error(`${error.message}\n${tail.split("\n").slice(-5).join("\n")}`);
    }
}
