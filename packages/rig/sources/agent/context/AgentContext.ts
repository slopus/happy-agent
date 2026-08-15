import type { BashContext } from "./BashContext.js";
import type { ChatHistoryContext } from "./ChatHistoryContext.js";
import type { FileReadState } from "./FileReadState.js";
import type { FileSystemContext } from "./FileSystemContext.js";
import type { FolderContext } from "./FolderContext.js";
import type { GoalContext } from "./GoalContext.js";
import type { PluginContext } from "./PluginContext.js";
import type { SlotContext } from "./SlotContext.js";
import type { WorkletContext } from "./WorkletContext.js";
import type { SubagentContext } from "./SubagentContext.js";
import type { UserInputContext } from "./UserInputContext.js";
import type { TaskContext } from "./TaskContext.js";
import type { PermissionContext } from "../../permissions/index.js";
import type { WorkflowContext } from "../../workflows/index.js";
import type { SessionSecretContext } from "../../secrets/index.js";
import type { AgentCommunicationContext } from "./AgentCommunicationContext.js";
import type { WorkspaceContext } from "./WorkspaceContext.js";
import type { SchedulingContext } from "../../scheduling/index.js";
import type { ProviderUsageContext } from "./ProviderUsageContext.js";
import type { AgentTreeUsageContext } from "./AgentTreeUsageContext.js";

export interface AgentContext {
    agentCommunication?: AgentCommunicationContext;
    agentTreeUsage?: AgentTreeUsageContext;
    fs: FileSystemContext;
    bash: BashContext;
    chatHistory?: ChatHistoryContext;
    /** Absolute path to Rig's bundled read-only documentation in this execution environment. */
    docsPath?: string;
    fileReads?: FileReadState;
    /** The folder tree, and the folder this chat files itself into. */
    folders?: FolderContext;
    goals?: GoalContext;
    permissions?: PermissionContext;
    plugins?: PluginContext;
    providerUsage?: ProviderUsageContext;
    scheduling?: SchedulingContext;
    secrets?: SessionSecretContext;
    slots?: SlotContext;
    /** Managing the worklets installed on this machine. */
    worklets?: WorkletContext;
    subagents?: SubagentContext;
    tasks?: TaskContext;
    userInput?: UserInputContext;
    workflows?: WorkflowContext;
    workspaces?: WorkspaceContext;
}
