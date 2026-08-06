import { Type } from "@sinclair/typebox";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../../agent/context/subagentSelectionDescriptions.js";
import { defineTool } from "../../agent/types.js";
import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { WorkspaceContext } from "../../agent/context/WorkspaceContext.js";

function requireWorkspaces(context: AgentContext): WorkspaceContext {
    if (context.workspaces === undefined) {
        throw new Error("Workspace tools are only available in a primary session.");
    }
    return context.workspaces;
}

function requireCrossWorkspace(context: AgentContext): WorkspaceContext {
    const workspaces = requireWorkspaces(context);
    if (!workspaces.crossWorkspace) {
        throw new Error(
            "Working across projects and workspaces is turned off. Ask the user to enable features.cross_workspace in their Rig configuration.",
        );
    }
    return workspaces;
}

const workspaceResult = Type.Object({
    archived: Type.Boolean({
        description:
            "True once this workspace has ended, including while archival cleanup is still running.",
    }),
    id: Type.String(),
    name: Type.String(),
    path: Type.String(),
    projectId: Type.String(),
    status: Type.String(),
    owned: Type.Optional(Type.Boolean()),
});

export const createWorkspaceTool = defineTool({
    name: "create_workspace",
    label: "Create workspace",
    description:
        "Create a managed Git workspace owned by this session. The durable reservation returns immediately with status initializing while its checkout and setup continue in the background. You may immediately call spawn_workspace_agent or delegate_to_workspace for it: those tools wait for readiness and stop clearly if setup fails or the call is aborted. Files, terminals, and shell still require ready status. A workspace isolates one piece of work from the others running alongside it: each parallel task gets its own fresh workspace so their changes never collide, while subtasks of the current work stay in the current workspace. It is a separate checkout with its own dependencies and context, so create one only when that isolation is needed. Only this session can later archive it or start a workspace agent inside it.",
    arguments: Type.Object(
        {
            base_ref: Type.Optional(
                Type.String({
                    description:
                        "Git ref to fork. Omit this to start from the project's main branch on the remote, which is almost always what you want.",
                }),
            ),
            name: Type.String({ description: "Human-readable workspace name." }),
        },
        { additionalProperties: false },
    ),
    returnType: workspaceResult,
    shouldReviewInAutoMode: () => false,
    execute: ({ base_ref, name }, context) =>
        requireWorkspaces(context).create({
            ...(base_ref === undefined ? {} : { baseRef: base_ref }),
            name,
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Created workspace ${result.name}.`,
    locks: [],
});

export const archiveWorkspaceTool = defineTool({
    name: "archive_workspace",
    label: "Archive workspace",
    description:
        "Archive a managed workspace created by this session. Workspaces created by another session cannot be archived with this tool.",
    arguments: Type.Object(
        { workspace_id: Type.String({ description: "Owned workspace ID." }) },
        { additionalProperties: false },
    ),
    returnType: workspaceResult,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ workspace_id }) =>
        `archive workspace ${JSON.stringify(workspace_id)} and remove its managed worktree`,
    execute: ({ workspace_id }, context) => requireWorkspaces(context).archive(workspace_id),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Archived workspace ${result.name}.`,
    locks: [],
});

export const spawnWorkspaceAgentTool = defineTool({
    name: "spawn_workspace_agent",
    label: "Start workspace agent",
    description:
        "Start a managed subagent inside a workspace created by this session. If its checkout is still initializing, this call waits for it to become ready without starting the agent early. It is hidden from the ordinary session list, appears under this session as a subagent, and reports its result back here. For a task that runs alongside other work, create a fresh workspace first instead of reusing one that holds other work.",
    arguments: Type.Object(
        {
            workspace_id: Type.String({ description: "Owned, ready workspace ID." }),
            description: Type.String({ description: "Short human-readable task description." }),
            prompt: Type.String({ description: "Complete task instructions." }),
            provider: Type.Optional(
                Type.String({
                    description:
                        "Optional provider ID for the new agent. Omit to let Rig choose a compatible available account.",
                }),
            ),
            model: Type.String({ description: SUBAGENT_MODEL_ARGUMENT_DESCRIPTION }),
            reasoning_effort: Type.String({
                description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
            }),
            context: Type.Optional(
                Type.Union([Type.Literal("parent"), Type.Literal("task")], {
                    description:
                        "Use parent to continue with this conversation's context, or task to start with only the delegated prompt. Defaults to task.",
                }),
            ),
            background: Type.Optional(
                Type.Boolean({ description: "Run in the background. Defaults to true." }),
            ),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
                }),
            ),
            service_tier: Type.Optional(
                Type.Literal("priority", {
                    description:
                        "Service tier override for the new agent. Omit unless explicitly requested.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agentId: Type.String(),
        output: Type.String(),
        path: Type.String(),
        status: Type.String(),
    }),
    shouldReviewInAutoMode: () => false,
    execute: async (
        {
            background = true,
            context: contextMode = "task",
            description,
            model,
            prompt,
            provider,
            read_only,
            reasoning_effort,
            service_tier,
            workspace_id,
        },
        context,
        execution,
    ) => {
        const result = await requireWorkspaces(context).spawn(
            {
                background,
                contextMode,
                description,
                effort: reasoning_effort,
                modelId: model,
                prompt,
                ...(provider === undefined ? {} : { providerId: provider }),
                ...(read_only === undefined ? {} : { readOnly: read_only }),
                ...(service_tier === "priority" ? { serviceTier: "fast" as const } : {}),
                ...(contextMode === "parent" && execution.messages !== undefined
                    ? { contextMessages: execution.messages.slice(0, -1) }
                    : {}),
                workspaceId: workspace_id,
                ...(execution.toolCallId === undefined
                    ? {}
                    : { parentToolCallId: execution.toolCallId }),
            },
            execution.signal,
        );
        return {
            agentId: result.agentId,
            output: result.output,
            path: result.path,
            status: result.status,
        };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Started workspace agent ${result.path}.`,
    locks: [],
});

export const listWorkspacesTool = defineTool({
    name: "list_workspaces",
    label: "List workspaces",
    description:
        "List the workspaces of this session's project, or of another project when a project ID is given. Ended workspaces remain visible with archived set to true. Listing is for inspecting and following up on existing work, not for picking a workspace to reuse: a parallel task gets its own workspace from create_workspace.",
    arguments: Type.Object(
        {
            project_id: Type.Optional(
                Type.String({
                    description:
                        "Project to list. Defaults to this session's project. Another project requires cross-workspace access.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({ workspaces: Type.Array(workspaceResult) }),
    shouldReviewInAutoMode: () => false,
    execute: ({ project_id }, context) => ({
        workspaces: requireWorkspaces(context)
            .listWorkspaces(project_id)
            .map((workspace) => ({ ...workspace })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.workspaces.length === 1
            ? "Found 1 workspace."
            : `Found ${String(result.workspaces.length)} workspaces.`,
    locks: [],
});

export const listWorkspaceSessionsTool = defineTool({
    name: "list_workspace_sessions",
    label: "List sessions",
    description:
        "List the conversations of a project or of one of its workspaces, most recently active first. Ended conversations remain visible with archived set to true.",
    arguments: Type.Object(
        {
            project_id: Type.Optional(
                Type.String({
                    description:
                        "Project to list. Defaults to this session's project. Another project requires cross-workspace access.",
                }),
            ),
            workspace_id: Type.Optional(
                Type.String({ description: "Restrict the list to one workspace." }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        sessions: Type.Array(
            Type.Object({
                archived: Type.Boolean({
                    description:
                        "True when this conversation has been put away and is no longer active.",
                }),
                id: Type.String(),
                agentId: Type.String(),
                projectId: Type.String(),
                workspaceId: Type.Optional(Type.String()),
                title: Type.String(),
                status: Type.String(),
                updatedAt: Type.Number(),
                delegatedBy: Type.Optional(Type.String()),
            }),
        ),
    }),
    shouldReviewInAutoMode: () => false,
    execute: ({ project_id, workspace_id }, context) => ({
        sessions: requireWorkspaces(context)
            .listSessions({
                ...(project_id === undefined ? {} : { projectId: project_id }),
                ...(workspace_id === undefined ? {} : { workspaceId: workspace_id }),
            })
            .map((session) => ({ ...session })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.sessions.length === 1
            ? "Found 1 session."
            : `Found ${String(result.sessions.length)} sessions.`,
    locks: [],
});

export const listProjectsTool = defineTool({
    name: "list_projects",
    label: "List projects",
    description: "List every project Rig knows about on this machine.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({
        projects: Type.Array(
            Type.Object({
                id: Type.String(),
                name: Type.String(),
                path: Type.String(),
                current: Type.Boolean(),
            }),
        ),
    }),
    shouldReviewInAutoMode: () => false,
    execute: (_arguments, context) => ({
        projects: requireCrossWorkspace(context)
            .listProjects()
            .map((project) => ({ ...project })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.projects.length === 1
            ? "Found 1 project."
            : `Found ${String(result.projects.length)} projects.`,
    locks: [],
});

export const addProjectTool = defineTool({
    name: "add_project",
    label: "Add project",
    description:
        "Register an existing local Git repository as a Rig project without creating a chat or workspace. The path must be the repository's top-level folder.",
    arguments: Type.Object(
        {
            path: Type.String({
                description: "Absolute Git repository path on the machine running Rig.",
            }),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        current: Type.Boolean(),
        id: Type.String(),
        name: Type.String(),
        path: Type.String(),
    }),
    requiresAutoOrFullAccess: true,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ path }) =>
        `inspect and register the local Git repository at ${JSON.stringify(path)} as a Rig project`,
    execute: ({ path }, context) => requireCrossWorkspace(context).addProject(path),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Added project ${result.name}.`,
    locks: [],
});

export const delegateToWorkspaceTool = defineTool({
    name: "delegate_to_workspace",
    label: "Delegate to workspace",
    description:
        "Start a visible conversation in another workspace and give it a task. If its checkout is still initializing, this call waits for it to become ready without starting the conversation early. The new session appears in the user's session list, keeps this session as its parent, and can be reached afterwards with agent_info and agent_send using the returned agent ID. When the user writes to it themselves, this session is told what they said.",
    arguments: Type.Object(
        {
            workspace_id: Type.String({
                description:
                    "Ready workspace to work in. For a task that runs alongside other work, create a fresh workspace first instead of reusing one that holds other work.",
            }),
            project_id: Type.Optional(
                Type.String({
                    description:
                        "Project owning the workspace. Defaults to this session's project.",
                }),
            ),
            prompt: Type.String({ description: "Complete task instructions." }),
            provider: Type.Optional(
                Type.String({
                    description:
                        "Optional provider ID for the new agent. Omit to let Rig choose a compatible available account.",
                }),
            ),
            model: Type.String({ description: SUBAGENT_MODEL_ARGUMENT_DESCRIPTION }),
            reasoning_effort: Type.String({
                description: SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
            }),
            title: Type.Optional(
                Type.String({
                    description: "Short human-readable title for the new conversation.",
                }),
            ),
            read_only: Type.Optional(
                Type.Boolean({
                    description:
                        "Run this child in Read only. Omit or set false to inherit the parent permission mode.",
                }),
            ),
            service_tier: Type.Optional(
                Type.Literal("priority", {
                    description:
                        "Service tier override for the new agent. Omit unless explicitly requested.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object({
        agentId: Type.String(),
        projectId: Type.String(),
        sessionId: Type.String(),
        title: Type.String(),
        workspaceId: Type.String(),
        workspacePath: Type.String(),
    }),
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: ({ workspace_id }) =>
        `start a user-visible agent session in workspace ${JSON.stringify(workspace_id)}, which works outside this conversation's own workspace`,
    execute: async (
        {
            model,
            project_id,
            prompt,
            provider,
            read_only,
            reasoning_effort,
            service_tier,
            title,
            workspace_id,
        },
        context,
        execution,
    ) => {
        const workspaces = requireWorkspaces(context);
        const request = {
            effort: reasoning_effort,
            modelId: model,
            prompt,
            ...(provider === undefined ? {} : { providerId: provider }),
            workspaceId: workspace_id,
            ...(project_id === undefined ? {} : { projectId: project_id }),
            ...(read_only === undefined ? {} : { readOnly: read_only }),
            ...(service_tier === "priority" ? { serviceTier: "fast" as const } : {}),
            ...(title === undefined ? {} : { title }),
        };
        return execution.signal === undefined
            ? workspaces.delegate(request)
            : workspaces.delegate(request, execution.signal);
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Started ${result.title} in another workspace.`,
    locks: [],
});

export const workspaceTools = [
    createWorkspaceTool,
    spawnWorkspaceAgentTool,
    archiveWorkspaceTool,
    listWorkspacesTool,
    listWorkspaceSessionsTool,
    delegateToWorkspaceTool,
] as const;

export const crossWorkspaceTools = [listProjectsTool, addProjectTool] as const;
