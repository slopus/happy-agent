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
