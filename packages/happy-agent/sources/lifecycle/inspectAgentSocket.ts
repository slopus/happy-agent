import {
    HappyAgentApiError,
    HappyAgentClient,
    type HealthResponse,
} from "@slopus/happy-agent-client";

import { isAgentSocketListening } from "../socket/agentSocketPaths.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import { readDaemonTokenIfPresent } from "./daemonToken.js";
import {
    describeLocalProcess,
    isHappyAgentProcess,
    readHappyAgentVersion,
    type LocalProcess,
} from "./describeLocalProcess.js";
import type { HappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { readSocketPeer } from "./readSocketPeer.js";

/** Who listens on the daemon socket, as far as the operating system can tell. */
export interface AgentSocketListenerIdentity {
    readonly pid?: number;
    readonly uid?: number;
    readonly process?: LocalProcess;
    readonly happyAgent: boolean;
    /** The version a standalone Happy Agent executable reports. */
    readonly version?: string;
    /** The Happy Agent crash supervisor that would restart this listener after it exits. */
    readonly supervisorPid?: number;
}

/** What answers on the daemon socket, judged with this installation's token. */
export type AgentSocketListener =
    | { readonly kind: "none" }
    | {
          readonly kind: "authenticated";
          readonly client: HappyAgentClient;
          readonly health: HealthResponse;
          readonly token: string;
      }
    /** Something accepts connections but does not answer health for another reason. */
    | { readonly kind: "unresponsive" }
    /** A listener this installation cannot use: there is no token, or it rejects the token. */
    | {
          readonly kind: "unauthenticated";
          readonly reason: "missing-token" | "rejected-token";
          readonly identity: AgentSocketListenerIdentity;
      };

/** Probes the daemon socket with this installation's token, identifying a listener that rejects it. */
export async function inspectAgentSocket(
    paths: Pick<HappyDaemonPaths, "socketPath" | "tokenPath">,
): Promise<AgentSocketListener> {
    const token = await readDaemonTokenIfPresent(paths.tokenPath);
    if (token === undefined || token.length === 0) {
        if (!(await isAgentSocketListening(paths.socketPath).catch(() => false))) {
            return { kind: "none" };
        }
        return {
            kind: "unauthenticated",
            reason: "missing-token",
            identity: await identifyAgentSocketListener(paths.socketPath),
        };
    }
    const client = createDaemonClient(paths.socketPath, token);
    try {
        return { kind: "authenticated", client, health: await client.getHealth(), token };
    } catch (error) {
        if (error instanceof HappyAgentApiError && (error.status === 401 || error.status === 403)) {
            return {
                kind: "unauthenticated",
                reason: "rejected-token",
                identity: await identifyAgentSocketListener(paths.socketPath),
            };
        }
        return (await isAgentSocketListening(paths.socketPath).catch(() => false))
            ? { kind: "unresponsive" }
            : { kind: "none" };
    }
}

/** Identifies the process listening on the socket from the kernel's peer credentials. */
export async function identifyAgentSocketListener(
    socketPath: string,
): Promise<AgentSocketListenerIdentity> {
    const peer = await readSocketPeer(socketPath);
    if (peer === undefined) return { happyAgent: false };
    const listener = await describeLocalProcess(peer.pid);
    if (listener === undefined) return { pid: peer.pid, uid: peer.uid, happyAgent: false };
    const happyAgent = isHappyAgentProcess(listener);
    if (!happyAgent) return { pid: peer.pid, uid: peer.uid, process: listener, happyAgent };
    const [version, supervisorPid] = await Promise.all([
        readHappyAgentVersion(listener.executable),
        findHappyAgentSupervisor(listener),
    ]);
    return {
        pid: peer.pid,
        uid: peer.uid,
        process: listener,
        happyAgent,
        ...(version === undefined ? {} : { version }),
        ...(supervisorPid === undefined ? {} : { supervisorPid }),
    };
}

/** Names a listener for a person, such as "Happy Agent 0.4.86 (PID 4242)". */
export function describeAgentSocketListener(identity: AgentSocketListenerIdentity): string {
    if (identity.pid === undefined) return "a process that could not be identified";
    if (identity.happyAgent) {
        const version = identity.version === undefined ? "" : ` ${identity.version}`;
        return `Happy Agent${version} (PID ${String(identity.pid)})`;
    }
    const executable = identity.process === undefined ? "" : `, ${identity.process.executable}`;
    return `process ${String(identity.pid)}${executable}`;
}

/** A crash supervisor runs the same executable as its daemon, and is the daemon's parent. */
async function findHappyAgentSupervisor(daemon: LocalProcess): Promise<number | undefined> {
    if (daemon.parentPid <= 1) return undefined;
    const parent = await describeLocalProcess(daemon.parentPid);
    if (
        parent === undefined ||
        parent.uid !== daemon.uid ||
        parent.executable !== daemon.executable ||
        !isHappyAgentProcess(parent)
    ) {
        return undefined;
    }
    return parent.pid;
}

function createDaemonClient(socketPath: string, token: string): HappyAgentClient {
    return new HappyAgentClient({
        endpoint: "http://happy",
        fetch: createUnixSocketFetch(socketPath),
        token,
    });
}
