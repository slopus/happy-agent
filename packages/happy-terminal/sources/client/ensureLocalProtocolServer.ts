/** Retained as a type-only compatibility surface for older terminal integrations. */
export interface DaemonRestartRequest {
    currentIdentity: { version: string };
    runningIdentity: { version: string };
}

export {
    ensureLocalProtocolServer,
    readTokenIfPresent,
    runDaemonInProcess,
    type EnsureLocalProtocolServerOptions,
    type LocalProtocolServerConnection,
} from "../daemon/index.js";
