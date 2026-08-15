import type { ServiceTier } from "../../protocol/index.js";

import type { Message } from "../types.js";
import type { SpawnSubagentResult, SubagentContextMode } from "./SubagentContext.js";
export interface AgentWorkspace {
    /** True once the workspace has logically ended, including while cleanup is still running. */
    archived: boolean;
    id: string;
    name: string;
    path: string;
    status: "initializing" | "ready" | "failed" | "archiving" | "archived";
    projectId: string;
    /** True only for workspaces this session created and may archive itself. */
    owned?: boolean;
}

export interface AgentProject {
    id: string;
    name: string;
    path: string;
    /** True for the project this session itself runs in. */
    current: boolean;
}

export interface AgentWorkspaceSession {
    /** True when the conversation has been put away and is no longer active. */
    archived: boolean;
    id: string;
    agentId: string;
    projectId: string;
    workspaceId?: string;
    title: string;
    status: string;
    updatedAt: number;
    /** The session that started this one, when an agent delegated the work. */
    delegatedBy?: string;
}

export interface WorkspaceAgentRequest {
    background?: boolean;
    contextMessages?: readonly Message[];
    contextMode?: SubagentContextMode;
    description: string;
    effort: string;
    modelId: string;
    prompt: string;
    providerId?: string;
    readOnly?: boolean;
    serviceTier?: ServiceTier;
    taskName?: string;
    workspaceId: string;
    parentToolCallId?: string;
}

export interface DelegatedSessionRequest {
    effort: string;
    modelId: string;
    projectId?: string;
    prompt: string;
    providerId?: string;
    readOnly?: boolean;
    serviceTier?: ServiceTier;
    title?: string;
    workspaceId: string;
}

export interface DelegatedSession {
    agentId: string;
    projectId: string;
    sessionId: string;
    title: string;
    workspaceId: string;
    workspacePath: string;
}

export interface AgentSessionTransferSchedule {
    state: "scheduled";
    targetWorkspaceId: string;
}

export interface WorkspaceContext {
    /** Whether this session may inspect, and start work in, other projects and workspaces. */
    crossWorkspace: boolean;
    archive(workspaceId: string): Promise<AgentWorkspace>;
    addProject(path: string): Promise<AgentProject>;
    create(input: { baseRef?: string; name: string }): Promise<AgentWorkspace>;
    delegate(request: DelegatedSessionRequest, signal?: AbortSignal): Promise<DelegatedSession>;
    listProjects(): Promise<readonly AgentProject[]>;
    listSessions(target: {
        projectId?: string;
        workspaceId?: string;
    }): Promise<readonly AgentWorkspaceSession[]>;
    listWorkspaces(projectId?: string): Promise<readonly AgentWorkspace[]>;
    spawn(request: WorkspaceAgentRequest, signal?: AbortSignal): Promise<SpawnSubagentResult>;
    transfer(targetWorkspaceId: string): Promise<AgentSessionTransferSchedule>;
}
