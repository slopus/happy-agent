export {
    ensureLocalProtocolServer,
    readTokenIfPresent,
    runDaemonInProcess,
    type DaemonRestartRequest,
    type EnsureLocalProtocolServerOptions,
    type LocalProtocolServerConnection,
} from "./ensureLocalProtocolServer.js";
export { createUnixSocketFetch } from "../daemon/index.js";
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
