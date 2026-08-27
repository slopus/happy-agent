/** Public surface of `@slopus/happy-agent-base`, re-exported by concern. */

// Agent instances and the collection that creates, resolves, and stores them.
export { Agent, type AgentOptions } from "./Agent.js";
export {
    type AgentSystem,
    type AgentCreateOptions,
    type AgentInitialContext,
    type AgentSystemDrainAgent,
    type AgentSystemDrainProgress,
} from "./AgentSystem.js";
export { AgentSystemLocal, type AgentSystemLocalOptions } from "./AgentSystemLocal.js";
export { AgentSystemRef } from "./AgentSystemRef.js";
export { AgentRef } from "./AgentRef.js";
export { agentSystem, withAgentSystem } from "./AgentSystemContext.js";

// Agent configuration: fixed environment/settings, mergeable metadata, and its context carrier.
export {
    agentConfig,
    agentConfigSchema,
    agentCreatedAt,
    agentCreatedBy,
    agentModuleConfig,
    agentMetadata,
    agentEnvironment,
    agentEnvironmentSchema,
    agentModuleConfigSchema,
    agentPlatformSchema,
    agentProvenance,
    agentProvenanceSchema,
    currentAgentEnvironment,
    withAgentConfig,
    type AgentConfig,
    type AgentEnvironment,
    type AgentModuleConfig,
    type AgentPlatform,
    type AgentProvenance,
} from "./AgentConfig.js";
export {
    agentMessageMetadataSchema,
    agentMetadataSchema,
    agentMetadataValueSchema,
    cuid2Schema,
    type AgentMessageMetadata,
    type AgentMetadata,
    type AgentMetadataChange,
    type AgentMetadataValue,
} from "./AgentMetadata.js";
export { type AgentMessageAcceptance } from "./AgentMessageAcceptance.js";
export { type AgentQueuedMessage } from "./AgentQueuedMessage.js";
export { AgentStorage, type AgentStorageLock, type AgentStorageOptions } from "./AgentStorage.js";
export {
    agentDatabaseRows,
    agentDatabaseRun,
    isAgentSQLiteDatabase,
    type AgentDatabase,
    type AgentDatabaseFacade,
    type AgentModuleMigration,
    type AgentPostgresDatabase,
    type AgentSQLiteDatabase,
} from "./AgentDatabase.js";
export {
    AgentDatabaseConnection,
    agentDatabaseConnection,
    ensureAgentDatabaseConnection,
} from "./AgentDatabaseConnection.js";
export { openAgentSQLiteDatabase, type AgentLibSQLDatabase } from "./openAgentSQLiteDatabase.js";
export { AgentSQLiteDatabaseLockedError } from "./AgentSQLiteProcessLock.js";
export {
    openAgentPGliteDatabase,
    type AgentPGliteDatabase,
    type OpenAgentPGliteDatabaseOptions,
} from "./openAgentPGliteDatabase.js";
export {
    openAgentPostgresDatabase,
    type AgentPostgresJsDatabase,
    type OpenAgentPostgresDatabaseOptions,
} from "./openAgentPostgresDatabase.js";

// Provider/model routing and the curated model catalog.
export { type AgentModel } from "./AgentModel.js";
export { knownModels, type Model } from "./models.js";

// The run loop itself: its context carriers, key-value store, hook contracts, and persistence.
export {
    AgentBase,
    type AgentBaseMessageOptions,
    type AgentBaseOptions,
    type AgentBaseQueueMode,
} from "./AgentBase.js";
export {
    agentDatabase,
    agentEffort,
    agentHistoryKV,
    agentId,
    agentKV,
    agentModel,
    agentPermissionMode,
    agentProvider,
    agentRunKV,
    agentServiceTier,
    withAgentContext,
    withAgentDatabase,
    withAgentHistoryKV,
    withAgentKV,
    withAgentPermissionMode,
    withAgentRunKV,
} from "./AgentContexts.js";
export {
    agentPermissionModeLabel,
    agentPermissionModeSchema,
    isAgentPermissionMode,
    DEFAULT_AGENT_PERMISSION_MODE,
    type AgentPermissionMode,
} from "./AgentPermissionMode.js";
export {
    agentTaskContext,
    taskContextBeforeToolCall,
    withAgentTaskContext,
} from "./AgentTaskContext.js";
export { inTx, type AgentTransactionWork } from "./inTx.js";
export { AgentKV } from "./AgentKV.js";
export {
    type AgentBaseAcceptedMessage,
    type AgentBaseActivation,
    type AgentBaseCompaction,
    type AgentBaseCompactionStart,
    type AgentBaseCompletedCompaction,
    type AgentBaseHooks,
    type AgentBaseInference,
    type AgentBaseInferencePreparation,
    type AgentBaseInferenceStart,
    type AgentBaseLoop,
    type AgentBaseModelChange,
    type AgentBasePermissionModeChange,
    type AgentBasePersistedEvent,
    type AgentBaseSettlement,
    type AgentBaseToolCall,
    type AgentBaseToolCallDecision,
    type AgentBaseToolOutcome,
    type AgentBaseTurn,
    type AgentBaseTurnStart,
    type MaybePromise,
} from "./AgentBaseHooks.js";
export { type AgentPersistence, type AgentRecord } from "./AgentPersistence.js";
export {
    agentBasePendingStateOf,
    agentBaseStoreOwesWork,
    AGENT_BASE_PENDING_KEY,
    type AgentBasePendingStage,
    type AgentBasePendingState,
} from "./AgentBasePending.js";
export { type AgentBaseState } from "./AgentBaseState.js";
export {
    type AgentConfigurationContributor,
    type AgentConfigurationSelection,
    type AgentInstructionsContribution,
    type AgentInstructionsOverride,
    type AgentToolsContribution,
    type AgentToolsOverride,
} from "./AgentConfigurationOverride.js";

// Modules: pluggable capabilities that compose into an agent's hooks, tools, and instructions.
export {
    type AgentModule,
    type AgentModuleAgent,
    type AgentModuleAgentLifecycle,
    type AgentModuleHooks,
    type AgentModuleRuntime,
    type AgentModuleScope,
    type AgentModuleSystemScope,
} from "./AgentModule.js";
export {
    type AgentModuleAction,
    type AgentModuleInferencePreparationAction,
} from "./AgentModuleAction.js";

// Registry of provider sources agents resolve their selected models through.
export {
    AgentProviders,
    type AgentProviderSelection,
    type AgentProviderSource,
} from "./AgentProviders.js";

// Tool definitions.
export {
    agentGrammarToolParameters,
    defineAgentTool,
    type AgentGrammarToolArguments,
    type AgentTool,
    type AgentToolCall,
    type AgentToolAutoPermissionActionDescriber,
    type AgentToolAutoPermissionPredicate,
    type AnyAgentTool,
} from "./AgentTool.js";
