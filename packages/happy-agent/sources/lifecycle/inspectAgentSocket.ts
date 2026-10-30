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
import {
    describeLocalProcess,
    happyAgentVersionFromPath,
    isHappyAgentProcess,
} from "./describeLocalProcess.js";
import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { readSocketPeer } from "./readSocketPeer.js";

/** What `start` does about whatever listens on the daemon socket. */
export type AgentSocketDecision =
    /** Nothing usable answers: start a daemon, which binds the socket or reports who holds it. */
    | { readonly kind: "start" }
    /** A daemon accepts this installation's token: match its version as before. */
    | {
          readonly kind: "connect";
          readonly client: HappyAgentClient;
          readonly health: HealthResponse;
          readonly token: string;
      }
    /** This user's Happy Agent that this installation can no longer reach: stop it, then start. */
    | {
          readonly kind: "replace";
          readonly pid: number;
          readonly supervisorPid?: number;
          readonly version?: string;
      }
    /** A listener that cannot be proven to be ours is left running, and start fails at once. */
    | { readonly kind: "refuse"; readonly error: AgentDaemonError };

/** Who listens on the daemon socket, as far as the operating system can tell. */
export interface AgentSocketListener {
    readonly pid?: number;
    readonly uid?: number;
    readonly executable?: string;
    readonly happyAgent: boolean;
    /** The version of an installed release, read from its path. */
    readonly version?: string;
    /** The Happy Agent crash supervisor that would restart this listener after it exits. */
    readonly supervisorPid?: number;
}

export interface AgentSocketInspector {
    readonly pid: number;
    readonly uid: number | undefined;
    readonly platform: NodeJS.Platform;
}

/**
 * Probes the daemon socket with this installation's token. A listener that rejects the token, or
 * answers while there is no token, can never be reached or replaced through the API, so it is
 * identified and judged by {@link judgeAgentSocketListener}.
 */
export async function inspectAgentSocket(
    paths: Pick<HappyDaemonPaths, "socketPath" | "tokenPath">,
    self: AgentSocketInspector = {
        pid: process.pid,
        uid: process.getuid?.(),
        platform: process.platform,
    },
): Promise<AgentSocketDecision> {
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token !== undefined && token.length > 0) {
        const client = new HappyAgentClient({
            endpoint: "http://happy",
            fetch: createUnixSocketFetch(paths.socketPath),
            token,
        });
        try {
            return { kind: "connect", client, health: await client.getHealth(), token };
        } catch (error) {
            const rejected =
                error instanceof HappyAgentApiError &&
                (error.status === 401 || error.status === 403);
            if (!rejected) return { kind: "start" };
        }
    } else if (!(await isAgentSocketListening(paths.socketPath).catch(() => false))) {
        return { kind: "start" };
    }
    const listener = await identifyAgentSocketListener(paths.socketPath);
    return judgeAgentSocketListener(listener, paths.socketPath, self);
}

/**
 * A listener is stopped only when the kernel names its process, that process belongs to this
 * user, and it is a Happy Agent. Anything else is left running and reported, with its PID when
 * known.
 */
export function judgeAgentSocketListener(
    listener: AgentSocketListener,
    socketPath: string,
    self: AgentSocketInspector,
): AgentSocketDecision {
    const { pid } = listener;
    if (pid === undefined || pid === self.pid) {
        return refuse(
            `Another process is serving ${socketPath}, and this installation cannot authenticate with it.`,
            self.platform === "win32"
                ? "Quit every other Happy Agent and Happy app, then try again."
                : "Its process could not be identified, so it was left running. Stop it, then try again.",
        );
    }
    if (listener.uid === undefined || listener.uid !== self.uid) {
        return refuse(`Process ${String(pid)}, owned by another user, is serving ${socketPath}.`);
    }
    if (!listener.happyAgent) {
        const executable = listener.executable === undefined ? "" : ` (${listener.executable})`;
        return refuse(
            `Process ${String(pid)}${executable} is serving ${socketPath}, and it is not Happy Agent.`,
        );
    }
    return {
        kind: "replace",
        pid,
        ...(listener.supervisorPid === undefined ? {} : { supervisorPid: listener.supervisorPid }),
        ...(listener.version === undefined ? {} : { version: listener.version }),
    };
}

function refuse(
    message: string,
    hint = "It was left running. Stop it, then try again.",
): AgentSocketDecision {
    return {
        kind: "refuse",
        error: new AgentDaemonError(message, { hint, exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE }),
    };
}

/** Identifies the listener from the kernel's peer credentials and its process details. */
async function identifyAgentSocketListener(socketPath: string): Promise<AgentSocketListener> {
    const peer = await readSocketPeer(socketPath);
    const listener = peer === undefined ? undefined : await describeLocalProcess(peer.pid);
    if (peer === undefined || listener === undefined) return { ...peer, happyAgent: false };
    const happyAgent = isHappyAgentProcess(listener);
    // A crash supervisor is the daemon's parent, running the same executable as the same user.
    const parent =
        happyAgent && listener.parentPid > 1
            ? await describeLocalProcess(listener.parentPid)
            : undefined;
    const supervised =
        parent !== undefined &&
        parent.uid === listener.uid &&
        parent.executable === listener.executable &&
        isHappyAgentProcess(parent);
    const version = happyAgent ? happyAgentVersionFromPath(listener.executable) : undefined;
    return {
        ...peer,
        executable: listener.executable,
        happyAgent,
        ...(supervised ? { supervisorPid: listener.parentPid } : {}),
        ...(version === undefined ? {} : { version }),
    };
}
