/** Public surface of `@slopus/happy-agent-modules`, re-exported by module. */

// Shared, module-neutral utilities: things more than one module needs and none of them owns.
export {
    AGENT_MESSAGE_ORIGIN_METADATA,
    MESSAGE_ORIGIN_METADATA_KEY,
    SENDER_AGENT_ID_METADATA_KEY,
    USER_MESSAGE_ORIGIN_METADATA,
    isUserOriginMetadata,
    senderAgentIdMetadata,
    senderAgentIdOf,
} from "./impl/messageOrigin.js";
export { getManagedProjectsDirectory } from "./impl/managedProjectsDirectory.js";
export { getManagedWorkspacesDirectory } from "./impl/managedWorkspacesDirectory.js";
export { FileReadLog } from "./impl/FileReadLog.js";
export { createTimedSignal, type TimedSignal } from "./impl/createTimedSignal.js";
export { quoteVisibleExact } from "./impl/quoteVisibleExact.js";

// Files: safe, project- and workspace-rooted filesystem access.
export * from "./files/index.js";

// Happy: the optional mobile connection and its durable remote projection.
export * from "./happy/index.js";
export * from "./api/index.js";
export * from "./runtime/index.js";

// Config: the resolved filesystem layout and layered Happy Agent settings.
export {
    ConfigModule,
    happyAgentConfigSourceSchema,
    happyAgentConfigValuesSchema,
    happyAgentConfigurationInputSchema,
    happyAgentConfigurationPathsSchema,
    happyAgentConfigurationSchema,
    loadHappyAgentConfiguration,
    parseHappyAgentConfigToml,
    type ConfigInferenceFactory,
    type ConfigInferenceOverride,
    type HappyAgentConfigSource,
    type HappyAgentConfigValues,
    type HappyAgentConfiguration,
    type HappyAgentConfigurationInput,
    type HappyAgentConfigurationPaths,
} from "./config/index.js";

// Git: reading repositories, probing and watching them, and the worktree and clone actions the
// project and workspace catalogs perform. A plain domain module: no hooks, no tools.
export * from "./git/index.js";

// Events: bounded in-memory queue of raw events with strict UUIDv7 identifiers.
export {
    appendEventInputSchema,
    eventAgentIdSchema,
    eventContextSchema,
    eventIdSchema,
    eventListenerSchema,
    eventReplaySchema,
    eventSchema,
    eventTypeSchema,
    eventsModuleListenerSchema,
    EVENT_TYPE,
    EVENTS_CAPACITY,
    EventsModule,
    MAX_EVENT_AGENT_ID_LENGTH,
    MAX_EVENT_TYPE_LENGTH,
    type AgentEvent,
    type AppendEventInput,
    type EventListener,
    type EventReplay,
    type EventsModuleListener,
    type EventType,
} from "./events/index.js";
export { createUuidV7Factory } from "./events/index.js";

// Goal: long-running work the agent keeps pursuing until it is complete or blocked.
export {
    GoalModule,
    FAILED_TURNS_BEFORE_BLOCKED,
    GOAL_OUTPUT_CHARACTERS,
} from "./goal/GoalModule.js";
export {
    goalEventSchema,
    goalContextSchema,
    goalEventListenerSchema,
    type GoalEvent,
    type GoalEventListener,
    type GoalUnsubscribe,
} from "./goal/GoalEvent.js";
export { createGoalTool } from "./goal/tools/create_goal.js";
export { clearGoalTool } from "./goal/tools/clear_goal.js";
export { getGoalTool } from "./goal/tools/get_goal.js";
export { updateGoalTool } from "./goal/tools/update_goal.js";
export {
    goalAgentIdSchema,
    goalObjectiveSchema,
    goalOperationIdSchema,
    goalStatusSchema,
    goalTimestampSchema,
    MAX_GOAL_AGENT_ID_LENGTH,
    MAX_GOAL_OBJECTIVE_CHARS,
    MAX_GOAL_OPERATION_ID_LENGTH,
    MAX_GOAL_OUTPUT_CHARACTERS,
    sessionGoalSchema,
    type GoalAgentId,
    type GoalOperationId,
    type GoalStatus,
    type SessionGoal,
} from "./goal/SessionGoal.js";
export {
    createGoalContinuationPrompt,
    goalContinuationPromptSchema,
    MAX_GOAL_CONTINUATION_PROMPT_CHARS,
    type GoalContinuationPrompt,
} from "./goal/impl/createGoalContinuationPrompt.js";
export { formatGoalForModel } from "./goal/impl/formatGoalForModel.js";

// System prompt: the instructions each model is written for, chosen by the model in force.
export {
    SystemPromptModule,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODEL_FIELD_LENGTH,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    MAX_SYSTEM_PROMPT_OUTPUT_BYTES,
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
    systemPromptIdentitySchema,
    systemPromptSelectionSchema,
    type SystemPromptAvailableModel,
    type SystemPromptAvailableModels,
    type SystemPromptSelection,
} from "./systemPrompt/SystemPromptModule.js";
export {
    AGENTS_MD_SPEC,
    MAX_AGENTS_MD_AGENT_ID_LENGTH,
    MAX_AGENTS_MD_DOCUMENT_BYTES,
    MAX_AGENTS_MD_DOCUMENTS,
    MAX_AGENTS_MD_GLOBAL_BYTES,
    MAX_AGENTS_MD_OUTPUT_CHARACTERS,
    MAX_AGENTS_MD_PATH_LENGTH,
    MAX_AGENTS_MD_TOTAL_BYTES,
    MAX_AGENTS_SECURITY_MD_BYTES,
    agentsMdAgentIdSchema,
    agentsMdDocumentSchema,
    agentsMdGlobalDocumentSchema,
    agentsMdPathSchema,
    agentsMdSnapshotSchema,
    type AgentsMdAgentId,
    type AgentsMdDocument,
    type AgentsMdGlobalDocument,
    type AgentsMdSnapshot,
} from "./systemPrompt/AgentsMd.js";
export {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    MAX_SYSTEM_PROMPT_IDENTITY_NAME_LENGTH,
    MAX_SYSTEM_PROMPT_IDENTITY_PROMPT_LENGTH,
    type SystemPromptIdentity,
} from "./systemPrompt/SystemPromptIdentity.js";
export {
    MAX_SYSTEM_PROMPT_MODEL_LENGTH,
    systemPromptProviderKindSchema,
    type SystemPromptProviderKind,
} from "./systemPrompt/SystemPromptSelection.js";
export { systemPromptForModel } from "./systemPrompt/impl/systemPromptForModel.js";

// History: the agent's own durable record of what happened, which it can read back.
export {
    HistoryModule,
    MAX_HISTORY_EXCERPT_CHARACTERS,
    type HistoryAppendListener,
} from "./history/HistoryModule.js";
export {
    historyAgentIdSchema,
    historyBlockSchema,
    historyImageBlockSchema,
    historyMessageSchema,
    historyMessageInputSchema,
    historyModelSchema,
    historyProviderSchema,
    historyRecordIdSchema,
    historyRoleSchema,
    historyTextBlockSchema,
    historyThinkingBlockSchema,
    historyTimestampSchema,
    historyToolArgumentsSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    MAX_HISTORY_AGENT_ID_LENGTH,
    MAX_HISTORY_ARGUMENT_ARRAY_ITEMS,
    MAX_HISTORY_ARGUMENT_BYTES,
    MAX_HISTORY_ARGUMENT_DEPTH,
    MAX_HISTORY_ARGUMENT_KEY_LENGTH,
    MAX_HISTORY_ARGUMENT_OBJECT_PROPERTIES,
    MAX_HISTORY_ARGUMENT_STRING_LENGTH,
    MAX_HISTORY_BLOCKS_PER_PAGE,
    MAX_HISTORY_BLOCKS_PER_MESSAGE,
    MAX_HISTORY_CALL_ID_LENGTH,
    MAX_HISTORY_MEDIA_TYPE_LENGTH,
    MAX_HISTORY_MESSAGES_PER_APPEND,
    MAX_HISTORY_MODEL_LENGTH,
    MAX_HISTORY_MESSAGE_JSON_BYTES,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_PENDING_BLOCKS,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_PROVIDER_LENGTH,
    MAX_HISTORY_QUERY_LENGTH,
    MAX_HISTORY_RECORD_ID_LENGTH,
    MAX_HISTORY_TEXT_LENGTH,
    MAX_HISTORY_THINKING_LENGTH,
    MAX_HISTORY_TOOL_DISPLAY_LENGTH,
    MAX_HISTORY_TOOL_NAME_LENGTH,
    MAX_HISTORY_TOOL_OUTPUT_LENGTH,
    MAX_HISTORY_TOTAL_MESSAGES,
    MAX_HISTORY_TOTAL_BLOCKS,
    MAX_HISTORY_TOTAL_TEXT_CHARACTERS,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryMessageInput,
    type HistoryRole,
    historyMessageWithinPersistenceBounds,
    historyToolArgumentsWithinByteLimit,
} from "./history/HistoryMessage.js";
export {
    historyPageSchema,
    historyQuerySchema,
    type HistoryPage,
    type HistoryQuery,
} from "./history/HistoryPage.js";
export {
    historyContextSchema,
    historyRecordSchema,
    historyStoreSchema,
    historyStoreQuerySchema,
    type HistoryRecord,
    type HistoryStore,
    type HistoryStoreQuery,
} from "./history/HistoryStore.js";
export { readAgentHistoryTool } from "./history/tools/read_agent_history.js";
export {
    formatHistoryPage,
    MAX_HISTORY_CHARACTERS,
    type FormattedHistoryPage,
} from "./history/impl/formatHistoryPage.js";
export { formatHistoryMessage } from "./history/impl/formatHistoryMessage.js";
export { createHistoryExcerpt, type HistoryExcerpt } from "./history/impl/createHistoryExcerpt.js";
export {
    historyStatsSchema,
    summarizeHistory,
    type HistoryStats,
} from "./history/impl/summarizeHistory.js";
export {
    foldHistorySearchText,
    historyMessageSearchParts,
    messageMatchesHistoryFilters,
} from "./history/impl/messageMatchesHistoryFilters.js";
export { selectHistoryPage } from "./history/impl/selectHistoryPage.js";

// Compute: the machine an agent works on, as file and command tools over one compute.
export * from "./compute/index.js";

// Model switch: the notice a model gets when it inherits a conversation it cannot see.
export { ModelSwitchModule } from "./modelSwitch/ModelSwitchModule.js";
export {
    createModelSwitchNotice,
    type ModelSwitchNotice,
} from "./modelSwitch/impl/createModelSwitchNotice.js";

// Auto: the automatic permission reviewer and its private, unaddressable review system.
export * from "./auto/index.js";

// Permissions: the mode an agent runs in, enforced call by call.
export {
    PERMISSION_ANNOUNCE_TIMEOUT_MS,
    PERMISSION_REFUSALS_BEFORE_STOPPING,
    PERMISSION_REVIEW_TIMEOUT_MS,
    PermissionsModule,
    type PermissionEventListener,
    type PermissionUnsubscribe,
} from "./permissions/PermissionsModule.js";
export { permissionEventSchema, type PermissionEvent } from "./permissions/PermissionEvent.js";
export {
    type PermissionReviewDecision,
    type PermissionReviewer,
    type PermissionReviewRequest,
    type PermissionReviewTranscript,
} from "./permissions/PermissionReviewer.js";
export {
    permissionModeChangeNotice,
    permissionModeGuidance,
} from "./permissions/impl/permissionModeGuidance.js";

// Presence: host-owned current status, temporary fallbacks, and optional recurring windows.
export {
    BUILT_IN_PRESENCES,
    ONLINE_PRESENCE,
    AWAY_PRESENCE,
    OFFLINE_PRESENCE,
    DND_PRESENCE,
} from "./presence/PresenceCatalog.js";
export {
    MAX_PRESENCE_SCHEDULES,
    PresenceModule,
    formatPresenceInstruction,
} from "./presence/PresenceModule.js";
export {
    MAX_PRESENCE_DEFINITIONS,
    readConfiguredPresence,
    type ConfiguredPresence,
} from "./presence/PresenceConfiguration.js";
export {
    assertPresenceEventListener,
    presenceContextSchema,
    presenceEventListenerSchema,
    presenceEventSchema,
    type PresenceEvent,
    type PresenceEventListener,
    type PresenceUnsubscribe,
} from "./presence/PresenceEvent.js";
export {
    assertPresenceUserInputResult,
    presenceUserInputChangeCallbackSchema,
    type PresenceUserInputChangeCallback,
} from "./presence/PresenceUserInput.js";
export {
    presenceScheduleInputSchema,
    presenceScheduleSchema,
    assertPresenceSchedule,
    assertPresenceScheduleInput,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./presence/PresenceSchedule.js";
export {
    assertPresenceState,
    assertPresenceToolInput,
    assertTemporaryPresenceInput,
    presenceFallbackSchema,
    presenceStoredStateSchema,
    presenceStateSchema,
    presenceStatusSchema,
    presenceToolInputSchema,
    presenceUserInputStateSchema,
    temporaryPresenceInputSchema,
    type PresenceFallback,
    type PresenceDefinition,
    type PresenceStoredState,
    type PresenceState,
    type PresenceStatus,
    type PresenceToolInput,
    type PresenceUserInputState,
    type TemporaryPresenceInput,
} from "./presence/PresenceState.js";
export {
    assertPresenceContext,
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    presenceReaderSchema,
    presenceScheduleStoreSchema,
    presenceStoreSchema,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceStore,
} from "./presence/PresenceStore.js";
export { getPresenceTool } from "./presence/tools/get_presence.js";
export { setPresenceTool } from "./presence/tools/set_presence.js";

// Tasks: a bounded persistent todo list owned by the module.
export {
    TasksModule,
    DEFAULT_TASK_PRIORITY,
    MAX_TASKS,
    MAX_TASKS_PER_AGENT,
    MAX_TASK_OUTPUT_CHARACTERS,
    MAX_TASK_PAGE_SIZE,
} from "./tasks/TasksModule.js";
export {
    taskCreateInputSchema,
    taskDetailSchema,
    taskIdSchema,
    taskPrioritySchema,
    taskSchema,
    taskStatusSchema,
    taskTimestampSchema,
    taskTitleSchema,
    taskUpdateInputSchema,
    type Task,
    type TaskCreateInput,
    type TaskId,
    type TaskPriority,
    type TaskStatus,
    type TaskUpdateInput,
} from "./tasks/Task.js";
export {
    taskEventIdSchema,
    taskEventPayloadSchema,
    taskEventListenerSchema,
    taskEventSchema,
    type TaskEvent,
    type TaskEventListener,
    type TaskEventPayload,
} from "./tasks/TaskEvent.js";
export {
    MAX_TASK_DEPENDENCY_PAGE_SIZE,
    MAX_TASK_DETAIL_PAGE_SIZE,
    taskDetailPageSchema,
    taskDetailQuerySchema,
    type TaskDetailPage,
    type TaskDetailQuery,
} from "./tasks/TaskDetailPage.js";
export {
    taskPageQuerySchema,
    taskPageSchema,
    type TaskPage,
    type TaskPageQuery,
} from "./tasks/TaskPage.js";
export { createTaskTool } from "./tasks/tools/create_task.js";
export { getTaskTool } from "./tasks/tools/get_task.js";
export { listTasksTool } from "./tasks/tools/list_tasks.js";
export { updateTaskTool } from "./tasks/tools/update_task.js";
export { completeTaskTool } from "./tasks/tools/complete_task.js";

// Abort: one transactional cancellation across an agent and its complete descendant tree.
export * from "./abort/index.js";

// Collaboration: create agents, exchange asynchronous messages, and interrupt delegated work.
export * from "./collaboration/index.js";

// Workflows: host-managed durable workflow runs, scoped to the calling agent.
export * from "./workflows/index.js";

// Usage: advisory provider, model, token, and timing accounting.
export * from "./usage/index.js";
export * from "./providerUsage/index.js";

// Compactions: durable manual and automatic context-replacement lifecycle.
export * from "./compactions/index.js";

// Context windows: automatic compaction from exact provider measurements.
export * from "./contextWindow/index.js";

// Image generation: one prompt becomes one PNG on a configured Codex account, written to disk.
export * from "./imageGeneration/index.js";

// Secrets: safe metadata/reference operations backed by a host-owned registry.
export {
    secretAgentIdSchema,
    secretAttachReferenceResultSchema,
    secretAttachmentSchema,
    secretAttachInputSchema,
    secretCursorSchema,
    secretDetachInputSchema,
    secretDescriptionSchema,
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableValueSchema,
    secretHostEnvironmentSchema,
    secretIdSchema,
    secretListInputSchema,
    secretListQuerySchema,
    secretMutationOperationSchema,
    secretPageSchema,
    secretReferenceSchema,
    secretRegistrationInputSchema,
    secretRegistrationSchema,
    secretRevisionSchema,
    secretScopeRefSchema,
    secretUpdateInputSchema,
    type SecretAgentId,
    type SecretAttachReferenceResult,
    type SecretAttachment,
    type SecretAttachInput,
    type SecretCursor,
    type SecretDetachInput,
    type SecretEnvironmentVariableName,
    type SecretEnvironmentVariableValue,
    type SecretHostEnvironment,
    type SecretId,
    type SecretListInput,
    type SecretListQuery,
    type SecretMutationOperation,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretRegistrationInput,
    type SecretRevision,
    type SecretScopeRef,
    type SecretUpdateInput,
} from "./secrets/Secret.js";
export {
    secretEventIdSchema,
    secretEventSchema,
    secretEventTimestampSchema,
    secretContextSchema,
    secretEventListenerSchema,
    type SecretEvent,
    type SecretEventListener,
    type SecretUnsubscribe,
} from "./secrets/SecretEvent.js";
export {
    assertSecretAttachment,
    assertSecretHostEnvironment,
    assertSecretPage,
    assertSecretReference,
    assertSecretStore,
    assertSecretStoreMutationResult,
    secretStoreAttachResultSchema,
    secretStoreDetachResultSchema,
    secretStoreMutationResultSchema,
    secretStoreRegisterResultSchema,
    secretStoreRemoveResultSchema,
    secretStoreSchema,
    secretStoreUpdateResultSchema,
    type SecretStore,
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreMutationResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./secrets/SecretStore.js";
export {
    SecretsModule,
    SECRETS_OUTPUT_CHARACTERS,
    SECRETS_PAGE_SIZE,
} from "./secrets/SecretsModule.js";
export { attachSecretTool } from "./secrets/tools/attach_secret.js";
export { detachSecretTool } from "./secrets/tools/detach_secret.js";
export { listSecretsTool } from "./secrets/tools/list_secrets.js";
export { referenceSecretTool } from "./secrets/tools/reference_secret.js";

// Search: per-vendor web search and a bounded page fetch, run by the module itself.
export {
    MAX_FETCH_CONTENT_CHARACTERS,
    MAX_FETCH_CONTENT_TYPE_LENGTH,
    MAX_FETCH_TITLE_LENGTH,
    MAX_FETCH_URL_LENGTH,
    MAX_SEARCH_AGENT_ID_LENGTH,
    MAX_SEARCH_QUERY_LENGTH,
    MAX_SEARCH_RESULT_TITLE_LENGTH,
    MAX_SEARCH_RESULT_URL_LENGTH,
    MAX_SEARCH_ANSWER_LENGTH,
    MAX_SEARCH_ANSWER_SOURCES,
    fetchInputSchema,
    fetchResultSchema,
    searchAgentIdSchema,
    searchAnswerSchema,
    searchProviderRequestSchema,
    searchProviderSchema,
    searchSourceSchema,
    type FetchInput,
    type FetchResult,
    type SearchAnswer,
    type SearchProvider,
    type SearchProviderRequest,
    searchContextSchema,
    type SearchSource,
} from "./search/Search.js";
export {
    MAX_SEARCH_FETCH_CHARACTERS,
    MAX_SEARCH_OUTPUT_CHARACTERS,
    SearchModule,
} from "./search/SearchModule.js";
export { bedrockWebSearchTool } from "./search/tools/bedrock_web_search.js";
export { claudeWebSearchTool } from "./search/tools/claude_web_search.js";
export { codexWebSearchTool } from "./search/tools/codex_web_search.js";
export { geminiWebSearchTool } from "./search/tools/gemini_web_search.js";
export { grokWebSearchTool } from "./search/tools/grok_web_search.js";
export { grokXSearchTool } from "./search/tools/grok_x_search.js";
export { webFetchTool } from "./search/tools/web_fetch.js";

// Gemini: image generation, music generation, and questions about local media files.
export {
    GeminiModule,
    type GeminiConnection,
    type GeminiGeneratedMedia,
    type GeminiMediaInput,
    type GeminiMediaInputType,
} from "./gemini/index.js";
export { geminiAnalyzeMediaTool } from "./gemini/tools/gemini_analyze_media.js";
export { geminiGenerateImageTool } from "./gemini/tools/gemini_imagegen.js";
export { geminiGenerateMusicTool } from "./gemini/tools/gemini_generate_music.js";

// Workspaces: host-owned worktree/Git references, bounded catalogs, and
// cursor-addressable detail.
export * from "./workspaces/index.js";

// Scheduling: messages the agent asks to be delivered later, and waits it can take.
export * from "./scheduling/index.js";

// Projects: the durable places work happens, with their own settings.
export * from "./projects/index.js";

// Terminals: real pseudo-terminals on a project or workspace folder, shared by everyone looking
// at that folder, each with one canonical Ghostty emulator behind it.
export * from "./terminals/index.js";

// Titles: the names a first message settles — the chat, its workspace, and its branch.
export * from "./titles/index.js";

// User input: questions the agent asks a person, and the answers it waits for.
export * from "./userInput/index.js";

// Observation: what the agent records about itself — logs, traces, and a readable history dump.
export * from "./observation/index.js";

// Integration modules: Happy clients, MCP servers, and skills.
export * from "./mcp/index.js";
export * from "./slashCommands/index.js";
export * from "./skills/index.js";

// Profile: the one person this installation belongs to.
export * from "./profile/index.js";

// Murmur: contacts over one shared identity, and the requests either side is waiting on.
export * from "./murmur/index.js";
