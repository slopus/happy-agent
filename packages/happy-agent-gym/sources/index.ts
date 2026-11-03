/** Public surface of the Happy agent gym. */

export {
    createAgentGym,
    removeWorkspacePath,
    runIdOf,
    type AgentGym,
    type AgentGymOptions,
    type GymAgentEvent,
    type GymAgentHistory,
    type GymAcceptance,
    type GymCreateSessionOptions,
    type GymSelection,
    type GymSendOptions,
    type GymSessionRecord,
} from "./createAgentGym.js";
export { createUnixSocketFetch } from "./createUnixSocketFetch.js";
export { recordGymMigration, runGymSql } from "./recordGymMigration.js";
export {
    BridgeUpgradeError,
    connectBridgeWebSocket,
    GymBridgeWebSocket,
    type GymBridgeMessage,
    connectTerminalWebSocket,
    connectWorkspaceProxy,
    type HappyAgentSocketTransport,
} from "./HappyAgentDuplex.js";
export { createGymCompute, type GymMachineConnection } from "./createGymCompute.js";
export { GymRunner, type GymRunnerOptions } from "./GymRunner.js";
export * from "./chaos/index.js";
export {
    createGymHome,
    resolveFixturePath,
    type GymFixture,
    type GymHome,
    type GymHomeOptions,
} from "./createGymHome.js";
export {
    frameEvent,
    GymEventStream,
    type GymEventStreamOptions,
    type GymSseFrame,
} from "./GymEventStream.js";
export { HappyAgentEventStream, frameEvent as clientFrameEvent } from "./HappyAgentEventStream.js";
export { GymHttpClient, type GymHttpClientOptions, type GymHttpResponse } from "./GymHttpClient.js";
export {
    createScriptedInference,
    GYM_MODEL_ID,
    GYM_MODELS,
    GYM_PROVIDER_ID,
    GYM_SECOND_MODEL_ID,
    type GymBlock,
    type GymCompactionHandler,
    type GymCompactionRequest,
    type GymInference,
    type GymInferenceHandler,
    type GymInferenceLog,
    type GymInferenceRequest,
    type GymTurn,
    type ScriptedInference,
    type ScriptedInferenceOptions,
} from "./scriptedInference.js";
