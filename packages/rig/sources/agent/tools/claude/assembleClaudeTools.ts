import { deferToolLoading, type AnyDefinedTool } from "../../types.js";
import { claudeWaitForWorkflowTool, claudeWorkflowTool } from "../../../tools/workflows/index.js";
import { claudeAgentTool } from "./Agent.js";
import { claudeAskUserQuestionTool } from "./AskUserQuestion.js";
import { claudeSendMessageTool } from "./SendMessage.js";
import { claudeTaskCreateTool } from "./TaskCreate.js";
import { claudeTaskGetTool } from "./TaskGet.js";
import { claudeTaskInputTool } from "./TaskInput.js";
import { claudeTaskListTool } from "./TaskList.js";
import { claudeTaskOutputTool } from "./TaskOutput.js";
import { claudeTaskStopTool } from "./TaskStop.js";
import { claudeTaskUpdateTool } from "./TaskUpdate.js";

export const claudeTools = [
    deferToolLoading(claudeTaskOutputTool),
    deferToolLoading(claudeTaskCreateTool),
    deferToolLoading(claudeTaskGetTool),
    deferToolLoading(claudeTaskUpdateTool),
    deferToolLoading(claudeTaskListTool),
    deferToolLoading(claudeTaskStopTool),
    deferToolLoading(claudeTaskInputTool),
    claudeAskUserQuestionTool,
] as const;

export function claudeToolSurface(): readonly AnyDefinedTool[] {
    return claudeTools;
}

export const claudeCollaborationToolsWithoutWorkflows = [
    claudeAgentTool,
    claudeSendMessageTool,
] as const;

export const claudeCollaborationTools = [
    claudeAgentTool,
    deferToolLoading(claudeWorkflowTool),
    deferToolLoading(claudeWaitForWorkflowTool),
    claudeSendMessageTool,
] as const;

export const claudeLimitedCollaborationTools = [claudeSendMessageTool] as const;

export function assembleClaudeTools(): readonly AnyDefinedTool[] {
    return [...claudeTools, ...claudeCollaborationTools];
}
