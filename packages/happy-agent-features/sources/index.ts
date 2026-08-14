/** Public surface of `@slopus/happy-agent-features`, re-exported by feature. */

// Goal: long-running work the agent keeps pursuing until it is complete or blocked.
export { GoalFeature, type GoalFeatureOptions } from "./goal/GoalFeature.js";
export { type GoalEvent, type GoalFeatureListener } from "./goal/GoalEvent.js";
export { createGoalTool } from "./goal/tools/create_goal.js";
export { getGoalTool } from "./goal/tools/get_goal.js";
export { updateGoalTool } from "./goal/tools/update_goal.js";
export {
    goalStatusSchema,
    sessionGoalSchema,
    type GoalStatus,
    type SessionGoal,
} from "./goal/SessionGoal.js";

// System prompt: the instructions each model is written for, chosen by the model in force.
export {
    SystemPromptFeature,
    type SystemPromptFeatureOptions,
} from "./systemPrompt/SystemPromptFeature.js";
export {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    type SystemPromptIdentity,
} from "./systemPrompt/SystemPromptIdentity.js";
export { systemPromptForModel } from "./systemPrompt/impl/systemPromptForModel.js";

// History: the agent's own durable record of what happened, which it can read back.
export { HistoryFeature, type HistoryFeatureOptions } from "./history/HistoryFeature.js";
export {
    historyBlockSchema,
    historyMessageSchema,
    historyRoleSchema,
    type HistoryBlock,
    type HistoryMessage,
    type HistoryRole,
} from "./history/HistoryMessage.js";
export { type HistoryPage, type HistoryQuery } from "./history/HistoryPage.js";
export { type HistoryRecord, type HistoryStore } from "./history/HistoryStore.js";
export { readAgentHistoryTool } from "./history/tools/read_agent_history.js";
export {
    formatHistoryPage,
    MAX_HISTORY_CHARACTERS,
    type FormattedHistoryPage,
} from "./history/impl/formatHistoryPage.js";
export { formatHistoryMessage } from "./history/impl/formatHistoryMessage.js";
export { summarizeHistory, type HistoryStats } from "./history/impl/summarizeHistory.js";
export { selectHistoryPage } from "./history/impl/selectHistoryPage.js";

// Compute: the machine an agent works on, as file and command tools over one compute.
export { ComputeFeature, type ComputeFeatureOptions } from "./compute/ComputeFeature.js";
export {
    type Compute,
    type ComputeFileStat,
    type ComputeFileSystem,
    type ComputePermissions,
    type ComputeRunOptions,
    type ComputeSessionActivity,
    type ComputeSessionReadOptions,
    type ComputeSessionSnapshot,
    type ComputeSessionStatus,
    type ComputeShell,
} from "./compute/Compute.js";
export { readFileTool } from "./compute/tools/read_file.js";
export { writeFileTool } from "./compute/tools/write_file.js";
export { editFileTool } from "./compute/tools/edit_file.js";
export { listDirectoryTool } from "./compute/tools/list_directory.js";
export { findFilesTool } from "./compute/tools/find_files.js";
export { searchFilesTool } from "./compute/tools/search_files.js";
export { runCommandTool } from "./compute/tools/run_command.js";
export { readCommandOutputTool } from "./compute/tools/read_command_output.js";
export { sendCommandInputTool } from "./compute/tools/send_command_input.js";
export { stopCommandTool } from "./compute/tools/stop_command.js";
export {
    commandResultSchema,
    createCommandResult,
    formatCommandResult,
    type CommandResult,
} from "./compute/impl/commandResult.js";
export { FileReadLog } from "./compute/impl/FileReadLog.js";

// Model switch: the notice a model gets when it inherits a conversation it cannot see.
export {
    ModelSwitchFeature,
    type ModelSwitchFeatureOptions,
} from "./modelSwitch/ModelSwitchFeature.js";
export {
    createModelSwitchNotice,
    type ModelSwitchNotice,
} from "./modelSwitch/impl/createModelSwitchNotice.js";

// Permissions: the mode an agent runs in, enforced call by call.
export {
    PermissionsFeature,
    type PermissionsFeatureOptions,
} from "./permissions/PermissionsFeature.js";
export {
    type PermissionEvent,
    type PermissionFeatureListener,
} from "./permissions/PermissionEvent.js";
export {
    type PermissionReviewDecision,
    type PermissionReviewer,
    type PermissionReviewRequest,
} from "./permissions/PermissionReviewer.js";
export {
    permissionModeChangeNotice,
    permissionModeGuidance,
} from "./permissions/impl/permissionModeGuidance.js";

// Presence: host-owned current status, temporary fallbacks, and optional recurring windows.
export {
    PresenceFeature,
    presenceFeatureOptionsSchema,
    presenceMutationOptionsSchema,
    type PresenceFeatureOptions,
    type PresenceMutationOptions,
} from "./presence/PresenceFeature.js";
export {
    presenceEventSchema,
    presenceFeatureListenerSchema,
    presenceContextSchema,
    type PresenceEvent,
    type PresenceFeatureListener,
} from "./presence/PresenceEvent.js";
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
    presenceStateSchema,
    presenceStatusSchema,
    presenceToolInputSchema,
    temporaryPresenceInputSchema,
    type PresenceFallback,
    type PresenceState,
    type PresenceStatus,
    type PresenceToolInput,
    type TemporaryPresenceInput,
} from "./presence/PresenceState.js";
export {
    assertPresenceContext,
    assertPresenceMutationReceipt,
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    assertPresenceTransactionChange,
    assertPresenceVoidResult,
    presenceFingerprintSchema,
    presenceMutationReceiptSchema,
    presenceOperationIdSchema,
    presenceReaderSchema,
    presenceScheduleStoreSchema,
    presenceStoreSchema,
    presenceTransactionChangeSchema,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceMutationReceipt,
    type PresenceStore,
    type PresenceTransactionChange,
} from "./presence/PresenceStore.js";
export { getPresenceTool } from "./presence/tools/get_presence.js";
export { setPresenceTool } from "./presence/tools/set_presence.js";

// Tasks: a bounded persistent todo list stored in each agent's supplied feature KV.
export {
    TasksFeature,
    DEFAULT_MAX_TASKS,
    DEFAULT_TASK_PRIORITY,
    MAX_TASKS,
    assertTasksFeatureOptions,
    tasksFeatureOptionsSchema,
    type TasksFeatureOptions,
} from "./tasks/TasksFeature.js";
export {
    assertTaskPersistence,
    taskPersistenceSchema,
    taskStorageSchema,
    type TaskPersistence,
    type TaskStorage,
} from "./tasks/TaskStore.js";
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
    taskEventSchema,
    taskFeatureListenerSchema,
    type TaskEvent,
    type TaskFeatureListener,
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

// Collaboration: durable agent rosters, directed messages, reply obligations, waits, and schedules.
export * from "./collaboration/index.js";

// Workflows: host-managed durable workflow runs, scoped to the calling agent.
export {
    MAX_WORKFLOW_AGENT_ID_LENGTH,
    MAX_WORKFLOW_ERROR_LENGTH,
    MAX_WORKFLOW_ID_LENGTH,
    MAX_WORKFLOW_INPUT_LENGTH,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OPERATION_FINGERPRINT_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_PAGE_SIZE,
    workflowAgentIdSchema,
    workflowIdSchema,
    workflowInputSchema,
    workflowLaunchInputSchema,
    workflowLaunchToolInputSchema,
    workflowLogPageSchema,
    workflowLogQuerySchema,
    workflowMutationInputSchema,
    workflowMutationResultSchema,
    workflowMutationToolInputSchema,
    workflowNameSchema,
    workflowOperationFingerprintSchema,
    workflowOperationReceiptSchema,
    workflowPageQuerySchema,
    workflowPageSchema,
    workflowRunSchema,
    workflowStatusSchema,
    workflowTimestampSchema,
    type WorkflowAgentId,
    type WorkflowId,
    type WorkflowInput,
    type WorkflowLaunchInput,
    type WorkflowLaunchToolInput,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowName,
    type WorkflowMutationInput,
    type WorkflowMutationResult,
    type WorkflowMutationToolInput,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowOperationFingerprint,
    type WorkflowOperationReceipt,
    type WorkflowRun,
    type WorkflowStatus,
} from "./workflows/Workflow.js";
export {
    workflowEventIdSchema,
    workflowEventSchema,
    workflowFeatureListenerSchema,
    type WorkflowEvent,
    type WorkflowFeatureListener,
} from "./workflows/WorkflowEvent.js";
export {
    assertWorkflowLogPage,
    assertWorkflowMutationResult,
    assertWorkflowPage,
    assertWorkflowRun,
    assertWorkflowTransactionChange,
    workflowStoreSchema,
    workflowTransactionChangeSchema,
    type WorkflowStore,
    type WorkflowTransactionChange,
} from "./workflows/WorkflowStore.js";
export {
    WorkflowsFeature,
    workflowFeatureOptionsSchema,
    type WorkflowFeatureOptions,
} from "./workflows/WorkflowsFeature.js";
export { listWorkflowsTool } from "./workflows/tools/list_workflows.js";
export { runWorkflowTool } from "./workflows/tools/run_workflow.js";
export { stopWorkflowTool } from "./workflows/tools/stop_workflow.js";
export { resumeWorkflowTool } from "./workflows/tools/resume_workflow.js";
export { waitWorkflowTool } from "./workflows/tools/wait_workflow.js";
export { workflowLogsTool } from "./workflows/tools/workflow_logs.js";
export { workflowStatusTool } from "./workflows/tools/workflow_status.js";

// Applets: host-managed versioned UI sources and bounded assets.
export {
    MAX_APPLET_ASSET_BYTES,
    MAX_APPLET_ASSET_OUTPUT_CHARACTERS,
    MAX_APPLET_LIST_SIZE,
    MAX_APPLET_SOURCE_BYTES,
    MAX_APPLET_SOURCE_FILE_BYTES,
    MAX_APPLET_SOURCE_FILES,
    MAX_APPLET_VERSIONS,
    appletActionRefSchema,
    appletAssetEncodingSchema,
    appletAssetPathSchema,
    appletAssetReadInputSchema,
    appletAssetResultSchema,
    appletAssetSchema,
    appletChangeDescriptionSchema,
    appletCreateInputSchema,
    appletCurrentResultSchema,
    appletDescriptionSchema,
    appletFingerprintSchema,
    appletImportInputSchema,
    appletListPageSchema,
    appletListQuerySchema,
    appletListSchema,
    appletNameSchema,
    appletOperationReceiptSchema,
    appletPurposeSchema,
    appletRefSchema,
    appletRevertInputSchema,
    appletSchema,
    appletScopeRefSchema,
    appletSourceImportInputSchema,
    appletSourceImportResultSchema,
    appletSourcePathSchema,
    appletTimestampSchema,
    appletToolImportInputSchema,
    appletToolRevertInputSchema,
    appletToolUpdateInputSchema,
    appletUpdateInputSchema,
    appletVersionNumberSchema,
    appletVersionSchema,
    type Applet,
    type AppletActionRef,
    type AppletAsset,
    type AppletAssetEncoding,
    type AppletAssetPath,
    type AppletAssetReadInput,
    type AppletChangeDescription,
    type AppletCreateInput,
    type AppletCurrentResult,
    type AppletDescription,
    type AppletFingerprint,
    type AppletImportInput,
    type AppletListPage,
    type AppletListQuery,
    type AppletName,
    type AppletOperationReceipt,
    type AppletPurpose,
    type AppletRef,
    type AppletRevertInput,
    type AppletScopeRef,
    type AppletSourceImportInput,
    type AppletSourceImportResult,
    type AppletSourcePath,
    type AppletTimestamp,
    type AppletToolImportInput,
    type AppletToolRevertInput,
    type AppletToolUpdateInput,
    type AppletUpdateInput,
    type AppletVersion,
    type AppletVersionNumber,
} from "./applets/Applet.js";
export {
    appletEventIdSchema,
    appletEventSchema,
    appletFeatureListenerSchema,
    type AppletEvent,
    type AppletFeatureListener,
} from "./applets/AppletEvent.js";
export {
    appletCatalogCreateInputSchema,
    appletCatalogCreateResultSchema,
    appletCatalogMutationProofSchema,
    appletCatalogMutationReceiptSchema,
    appletCatalogMutationResultSchema,
    appletCatalogOperationSchema,
    appletCatalogRemoveResultSchema,
    appletCatalogRevertInputSchema,
    appletCatalogRevertResultSchema,
    appletCatalogSchema,
    appletCatalogUpdateInputSchema,
    appletCatalogUpdateResultSchema,
    assetReaderSchema,
    assertApplet,
    assertAppletAsset,
    assertAppletCurrent,
    assertAppletMutation,
    assertAppletMutationProof,
    assertAppletMutationReceipt,
    assertAppletPage,
    assertSourceStage,
    sourceImporterSchema,
    type AppletAssetReaderInput,
    type AppletCatalog,
    type AppletCatalogCreateInput,
    type AppletCatalogCreateResult,
    type AppletCatalogMutationProof,
    type AppletCatalogMutationReceipt,
    type AppletCatalogMutationResult,
    type AppletCatalogOperation,
    type AppletCatalogRemoveResult,
    type AppletCatalogRevertInput,
    type AppletCatalogRevertResult,
    type AppletCatalogSchema,
    type AppletCatalogUpdateInput,
    type AppletCatalogUpdateResult,
    type AssetReader,
    type AssetReaderSchema,
    type SourceImporter,
    type SourceImporterSchema,
} from "./applets/AppletStore.js";
export {
    AppletFeature,
    appletFeatureOptionsSchema,
    assertAppletFeatureOptions,
    type AppletFeatureOptions,
} from "./applets/AppletFeature.js";
export { createAppletTool } from "./applets/tools/create_applet.js";
export { getAppletTool } from "./applets/tools/get_applet.js";
export { importAppletTool } from "./applets/tools/import_applet.js";
export { listAppletsTool } from "./applets/tools/list_applets.js";
export { readAppletAssetTool } from "./applets/tools/read_applet_asset.js";
export { removeAppletTool } from "./applets/tools/remove_applet.js";
export { revertAppletTool } from "./applets/tools/revert_applet.js";
export { updateAppletTool } from "./applets/tools/update_applet.js";
