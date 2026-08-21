export {
    ensureLocalProtocolServer,
    readTokenIfPresent,
    resolveAgentDaemonEntrypoint,
    runDaemonInProcess,
    toRigError,
    type DaemonRestartRequest,
    type EnsureLocalProtocolServerOptions,
    type LocalProtocolServerConnection,
} from "./ensureLocalProtocolServer.js";
export { createUnixSocketFetch } from "@slopus/happy-agent";
export { HappyAgentEventHub } from "./HappyAgentEventHub.js";
export {
    ensureWorkspaceForCwd,
    loadAgentCatalog,
    waitForWorkspaceReady,
    workspaceForCwd,
    type AgentCatalog,
    type AgentCatalogEntry,
} from "./loadAgentCatalog.js";
export { RemoteTerminalAttachment } from "./RemoteTerminalAttachment.js";
export { RemoteTerminalClientReplica } from "./RemoteTerminalClientReplica.js";
export { RemoteAgent, type RemoteAgentOptions } from "./RemoteAgent.js";
export { RemoteAgentRunError } from "./RemoteAgentRunError.js";
