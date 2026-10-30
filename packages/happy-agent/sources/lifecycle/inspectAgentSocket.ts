import {
    HappyAgentApiError,
    HappyAgentClient,
    type HealthResponse,
} from "@slopus/happy-agent-client";
import { isAgentSocketListening } from "../socket/agentSocketPaths.js";
import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { AgentDaemonError } from "./AgentDaemonError.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { readDaemonTokenIfPresent } from "./daemonToken.js";
import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { describeLocalProcess, isHappyAgentProcess, readSocketPeer } from "./readSocketPeer.js";

export type AgentSocketDecision =
    | { kind: "start" }
    | { kind: "connect"; client: HappyAgentClient; health: HealthResponse; token: string }
    | { kind: "replace"; pid: number; supervisorPid?: number };

/** Look before writing a token: an unreachable listener must first be identified. */
export async function inspectAgentSocket(
    paths: Pick<HappyDaemonPaths, "socketPath" | "tokenPath">,
): Promise<AgentSocketDecision> {
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token) {
        const client = new HappyAgentClient({
            endpoint: "http://happy",
            fetch: createUnixSocketFetch(paths.socketPath),
            token,
        });
        try {
            return { kind: "connect", client, health: await client.getHealth(), token };
        } catch (error) {
            if (!(error instanceof HappyAgentApiError && [401, 403].includes(error.status)))
                return { kind: "start" };
        }
    } else if (!(await isAgentSocketListening(paths.socketPath).catch(() => false)))
        return { kind: "start" };
    const peer = await readSocketPeer(paths.socketPath);
    const listener = peer && (await describeLocalProcess(peer.pid));
    const candidate = { ...peer, executable: listener?.executable };
    judgeAgentSocketListener(candidate, paths.socketPath);
    const parent =
        listener && listener.parentPid > 1
            ? await describeLocalProcess(listener.parentPid)
            : undefined;
    const supervisorPid =
        parent && parent.uid === peer?.uid && parent.executable === listener?.executable
            ? listener?.parentPid
            : undefined;
    return {
        kind: "replace",
        pid: peer!.pid,
        ...(supervisorPid === undefined ? {} : { supervisorPid }),
    };
}

/** Only the same user's standalone Happy Agent can be replaced. */
export function judgeAgentSocketListener(
    listener: {
        pid?: number | undefined;
        uid?: number | undefined;
        executable?: string | undefined;
    },
    socketPath: string,
    self = { pid: process.pid, uid: process.getuid?.() },
): void {
    let message: string | undefined;
    if (listener.pid === undefined || listener.pid === self.pid)
        message = `Another process is serving ${socketPath}, and this installation cannot authenticate with it.`;
    else if (listener.uid === undefined || listener.uid !== self.uid)
        message = `Process ${String(listener.pid)}, owned by another user, is serving ${socketPath}.`;
    else if (!listener.executable || !isHappyAgentProcess({ executable: listener.executable }))
        message = `Process ${String(listener.pid)} (${listener.executable ?? "unknown executable"}) is serving ${socketPath}, and it is not Happy Agent.`;
    if (message)
        throw new AgentDaemonError(message, {
            hint: "It was left running. Stop it, then try again.",
            exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE,
        });
}
