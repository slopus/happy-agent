import { AGENT_SOCKET_IN_USE_EXIT_CODE } from "../socket/AgentSocketInUseError.js";
import { AgentDaemonError } from "./AgentDaemonError.js";
import type { AgentSocketListener, AgentSocketListenerIdentity } from "./inspectAgentSocket.js";

/** What `start` does about whatever listens on the daemon socket. */
export type AgentSocketAction =
    /** Nothing usable answers: start a daemon, which binds the socket or reports who holds it. */
    | { readonly kind: "start" }
    /** A daemon accepts this installation's token: match its version as before. */
    | { readonly kind: "connect" }
    | ListenerReplacement;

/** Whether a listener may be stopped to free the daemon socket. */
export type ListenerReplacement =
    /** A Happy Agent of this user: stop it. */
    | {
          readonly kind: "replace";
          readonly pid: number;
          readonly supervisorPid?: number;
          readonly version?: string;
      }
    /** A listener that cannot be proven to be ours is left alone, and start fails at once. */
    | { readonly kind: "refuse"; readonly error: AgentDaemonError };

export interface AgentSocketActionSelf {
    readonly pid: number;
    readonly uid: number | undefined;
    readonly platform: NodeJS.Platform;
}

/**
 * Decides what `start` does about the listener on the daemon socket.
 *
 * A listener that rejects this installation's token, or answers while the token file is gone,
 * can never be reached or replaced through the API, so every start would fail on the busy socket.
 * It is replaced when {@link decideListenerReplacement} allows it.
 */
export function decideAgentSocketAction(
    listener: AgentSocketListener,
    socketPath: string,
    self: AgentSocketActionSelf,
): AgentSocketAction {
    if (listener.kind === "none" || listener.kind === "unresponsive") return { kind: "start" };
    if (listener.kind === "authenticated") return { kind: "connect" };
    return decideListenerReplacement(listener.identity, socketPath, self);
}

/**
 * A listener is stopped only when the kernel names its process, that process belongs to this
 * user, and it is a Happy Agent. Anything else is left running and reported, with its PID when
 * known.
 */
export function decideListenerReplacement(
    identity: AgentSocketListenerIdentity,
    socketPath: string,
    self: AgentSocketActionSelf,
): ListenerReplacement {
    if (identity.pid === undefined || identity.pid === self.pid) {
        return refuse(
            `Another process is serving ${socketPath}, and this installation cannot authenticate with it.`,
            self.platform === "win32"
                ? "Quit every other Happy Agent and Happy app, then try again."
                : "Its process could not be identified, so it was left running. Stop it, then try again.",
        );
    }
    if (identity.uid === undefined || self.uid === undefined || identity.uid !== self.uid) {
        return refuse(
            `Process ${String(identity.pid)}, owned by another user, is serving ${socketPath}.`,
            "It was left running. Stop it, then try again.",
        );
    }
    if (!identity.happyAgent) {
        const executable =
            identity.process === undefined ? "" : ` (${identity.process.executable})`;
        return refuse(
            `Process ${String(identity.pid)}${executable} is serving ${socketPath}, and it is not Happy Agent.`,
            "It was left running. Stop it, then try again.",
        );
    }
    return {
        kind: "replace",
        pid: identity.pid,
        ...(identity.supervisorPid === undefined ? {} : { supervisorPid: identity.supervisorPid }),
        ...(identity.version === undefined ? {} : { version: identity.version }),
    };
}

function refuse(message: string, hint: string): ListenerReplacement {
    return {
        kind: "refuse",
        error: new AgentDaemonError(message, { hint, exitCode: AGENT_SOCKET_IN_USE_EXIT_CODE }),
    };
}
