import { codexStopWorkflowTool } from "../../../tools/workflows/stop_workflow.js";
import { codexWaitForWorkflowTool } from "../../../tools/workflows/waitForWorkflowTools.js";
import { codexWorkflowTool } from "../../../tools/workflows/workflowTools.js";
import { codexWorkflowStatusTool } from "../../../tools/workflows/workflow_status.js";
import { codexRequestUserInputTool } from "./request_user_input.js";
import { codexUpdatePlanTool } from "./update_plan.js";
import { codexV1CloseAgentTool } from "./v1/close_agent.js";
import { codexV1ResumeAgentTool } from "./v1/resume_agent.js";
import { codexV1SendInputTool } from "./v1/send_input.js";
import { codexV1SpawnAgentTool } from "./v1/spawn_agent.js";
import { codexV1WaitAgentTool } from "./v1/wait_agent.js";
import { codexFollowupTaskTool } from "./v2/followup_task.js";
import { codexInterruptAgentTool } from "./v2/interrupt_agent.js";
import { codexListAgentsTool } from "./v2/list_agents.js";
import { codexSendMessageTool } from "./v2/send_message.js";
import { codexSpawnAgentTool } from "./v2/spawn_agent.js";
import { codexExtendedFollowupTaskTool } from "./v2/collaboration_ext/followup_task.js";
import { codexExtendedSpawnAgentTool } from "./v2/collaboration_ext/spawn_agent.js";
import { codexWaitAgentTool } from "./v2/wait_agent.js";
import { deferToolLoading } from "../../types.js";

export const codexTools = [codexUpdatePlanTool, codexRequestUserInputTool] as const;

export const codexWorkflowTools = [
    deferToolLoading(codexWorkflowTool),
    deferToolLoading(codexWaitForWorkflowTool),
    deferToolLoading(codexWorkflowStatusTool),
    deferToolLoading(codexStopWorkflowTool),
] as const;

export const codexV2CollaborationTools = [
    codexSpawnAgentTool,
    deferToolLoading(codexExtendedSpawnAgentTool),
    deferToolLoading(codexExtendedFollowupTaskTool),
    codexFollowupTaskTool,
    codexSendMessageTool,
    codexWaitAgentTool,
    codexListAgentsTool,
    codexInterruptAgentTool,
] as const;

export const codexV1CollaborationTools = [
    codexV1CloseAgentTool,
    codexV1ResumeAgentTool,
    codexV1SendInputTool,
    codexV1SpawnAgentTool,
    codexV1WaitAgentTool,
] as const;

export const codexV2FullCollaborationTools = [
    ...codexWorkflowTools,
    ...codexV2CollaborationTools,
] as const;

export const codexV1FullCollaborationTools = [
    ...codexWorkflowTools,
    ...codexV1CollaborationTools,
] as const;

export const codexV2LimitedCollaborationTools = [
    deferToolLoading(codexExtendedFollowupTaskTool),
    codexFollowupTaskTool,
    codexSendMessageTool,
    codexWaitAgentTool,
    codexListAgentsTool,
    codexInterruptAgentTool,
] as const;

export const codexV1LimitedCollaborationTools = [
    codexV1CloseAgentTool,
    codexV1ResumeAgentTool,
    codexV1SendInputTool,
    codexV1WaitAgentTool,
] as const;

export const codexV2Tools = [...codexTools, ...codexV2FullCollaborationTools] as const;

export const codexV1Tools = [...codexTools, ...codexV1FullCollaborationTools] as const;
