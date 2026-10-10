import { createHash } from "node:crypto";

import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
    ArtifactAuthor,
    ArtifactFile,
    ArtifactRecord,
    ArtifactSource,
    ArtifactUpload,
    ArtifactVersion,
} from "../artifacts/index.js";
import type { BotRecord } from "../bots/index.js";
import type { Profile } from "../profile/index.js";
import { STANDALONE_TASK_MEMBER, type TaskMembership, type TaskRecord } from "../tasks/index.js";
import {
    ProjectsModule,
    type Project,
    type ProjectCompute,
    type ProjectSettings,
} from "../projects/index.js";
import type { Terminal } from "../terminals/index.js";
import type { UserInputRequest } from "../userInput/index.js";
import type { Workspace } from "../workspaces/index.js";
import { EventsModule, type LatestAgentEvent } from "../events/index.js";

/** Deterministic, time-ordered UUIDv7 projection of a module's numeric resource version. */
export function apiResourceVersion(updatedAt: number, version: number, resourceId: string): string {
    const timestamp = BigInt(Math.max(0, Math.trunc(updatedAt))) & 0xffffffffffffn;
    const numericVersion = BigInt(Math.max(0, Math.trunc(version))) & ((1n << 53n) - 1n);
    const hash = createHash("sha256").update(resourceId).digest();
    const hashTail = BigInt(hash.readUInt32BE(0) & 0x1fffff);
    const random = (numericVersion << 21n) | hashTail;
    const highRandom = Number((random >> 62n) & 0xfffn);
    const middleRandom = Number((random >> 48n) & 0x3fffn);
    const lowRandom = random & 0xffffffffffffn;
    const timestampHex = timestamp.toString(16).padStart(12, "0");
    return [
        timestampHex.slice(0, 8),
        timestampHex.slice(8),
        `7${highRandom.toString(16).padStart(3, "0")}`,
        (0x8000 | middleRandom).toString(16).padStart(4, "0"),
        lowRandom.toString(16).padStart(12, "0"),
    ].join("-");
}

export async function projectResource(
    ctx: Context,
    projects: ProjectsModule,
    project: Project,
): Promise<Record<string, unknown>> {
    const settings = await projects.readSettings(ctx, project.id);
    return projectResourceWithSettings(project, settings, projects.compute(project));
}

/** Where new workspaces of a project run, as clients are shown it. */
function workspaceComputeSelection(
    settings: ProjectSettings,
    compute: ProjectCompute,
): Record<string, unknown> {
    const selected = settings.defaultWorkspaceCompute;
    if (compute.type === "runner") {
        return selected?.type === "docker"
            ? { type: "docker", image: selected.image, runnerId: compute.runnerId }
            : { type: "runner", runnerId: compute.runnerId };
    }
    return selected === undefined || selected.type === "local" ? { type: "host" } : selected;
}

/** Where a workspace's files are and where its agents work. */
function workspaceCompute(workspace: Workspace): Record<string, unknown> {
    if (workspace.dockerImage !== undefined) {
        return {
            type: "docker",
            image: workspace.dockerImage,
            path: workspace.path,
            ...(workspace.runnerId === undefined ? {} : { runnerId: workspace.runnerId }),
        };
    }
    return workspace.runnerId === undefined
        ? { type: "host", path: workspace.path }
        : { type: "runner", runnerId: workspace.runnerId, path: workspace.path };
}

/** Where a bot's folder is. */
function botCompute(bot: BotRecord): Record<string, unknown> {
    return bot.runnerId === undefined
        ? { type: "host", path: bot.path }
        : { type: "runner", runnerId: bot.runnerId, path: bot.path };
}

export function projectResourceWithSettings(
    project: Project,
    settings: ProjectSettings,
    compute: ProjectCompute = { type: "host", path: project.repositoryRef },
): Record<string, unknown> {
    const hasGit =
        project.gitBranch !== undefined ||
        project.gitHead !== undefined ||
        project.gitUpstream !== undefined ||
        project.gitDetached;
    return {
        id: project.id,
        name: project.name,
        nameSource: project.nameSource === "user" ? "user" : "folder",
        compute,
        status: project.status,
        initialization: {
            status: project.initializationStatus,
            attempt: project.initializationAttempt,
            error: project.initializationError ?? null,
        },
        git: hasGit
            ? {
                  branch: project.gitBranch ?? null,
                  head: project.gitHead ?? null,
                  upstream: project.gitUpstream ?? null,
                  ahead: project.gitAhead,
                  behind: project.gitBehind,
                  detached: project.gitDetached,
              }
            : null,
        defaultBranch: project.defaultBranch ?? null,
        worktreeSupport: project.worktreeSupport,
        ...(project.worktreeUnsupportedReason === undefined
            ? {}
            : { worktreeUnsupportedReason: project.worktreeUnsupportedReason }),
        remoteSource: project.remoteSource ?? null,
        avatar:
            project.kind === "home"
                ? { kind: "home" }
                : project.avatar === undefined
                  ? null
                  : {
                        kind: "image",
                        source: project.avatar.source,
                        thumbhash: project.avatar.thumbhash,
                    },
        description: project.description ?? null,
        // Empty until the workspaces catalog has read the project's `happy.toml`; a client
        // shows "nothing to run" either way, and the list arrives with the next update.
        workspaceSetupCommands: project.workspaceSetupCommands ?? [],
        settings: {
            defaultWorkspaceCompute: workspaceComputeSelection(settings, compute),
            workspaceInitialPrompt: settings.workspaceInitialPrompt ?? null,
        },
        orderKey: project.orderKey,
        version: apiResourceVersion(project.updatedAt, project.version, project.id),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        archivedAt: project.archivedAt ?? null,
    };
}

export function workspaceResource(
    workspace: Workspace,
    projectId = workspace.projectRef,
): Record<string, unknown> {
    const hasGit =
        workspace.gitHead !== undefined ||
        workspace.gitUpstream !== undefined ||
        workspace.gitDetached ||
        workspace.branch.length > 0;
    return {
        id: workspace.id,
        projectId,
        parentId: workspace.parentId,
        botId: null,
        name: workspace.name,
        nameSource: workspace.nameConfigured ? "user" : "generated",
        kind: workspace.kind === "git_worktree" ? "worktree" : "copy",
        compute: workspaceCompute(workspace),
        status: workspaceStatus(workspace.status),
        initialization: {
            status: workspaceInitializationStatus(workspace.status),
            attempt: workspace.initializationAttempt,
            error: workspace.initializationError ?? null,
        },
        base:
            workspace.baseRef === undefined && workspace.baseCommit === undefined
                ? null
                : {
                      ref: workspace.baseRef ?? null,
                      commit: workspace.baseCommit ?? null,
                  },
        git: hasGit
            ? {
                  branch: workspace.branch,
                  head: workspace.gitHead ?? null,
                  upstream: workspace.gitUpstream ?? null,
                  ahead: workspace.gitAhead,
                  behind: workspace.gitBehind,
                  detached: workspace.gitDetached,
              }
            : null,
        creatorAgentId: workspace.creatorSessionId ?? null,
        subtaskAgentId: workspace.subtaskAgentId ?? null,
        orderKey: workspace.orderKey,
        version: apiResourceVersion(workspace.updatedAt, workspace.version, workspace.id),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        archivedAt: workspace.archivedAt ?? null,
        ...(workspace.serviceCleanup === undefined
            ? {}
            : { serviceCleanup: structuredClone(workspace.serviceCleanup) }),
    };
}

export function botResource(
    bot: BotRecord,
    agent: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    return {
        id: bot.id,
        isAdmin: bot.isAdmin,
        name: bot.name,
        username: bot.username,
        workspaceId: bot.workspaceId,
        compute: botCompute(bot),
        status: bot.status,
        systemKey: bot.systemKey ?? null,
        avatar: bot.avatar ?? null,
        agent,
        orderKey: bot.orderKey,
        version: apiResourceVersion(bot.updatedAt, bot.version, bot.id),
        createdAt: bot.createdAt,
        updatedAt: bot.updatedAt,
        archivedAt: bot.archivedAt ?? null,
    };
}

/**
 * One task as the API shows it. `canArchive` depends on who is asking, so it is supplied only for
 * a caller's own response and left out of events, which reach every member alike.
 */
export function taskResource(
    task: TaskRecord,
    agent: Readonly<Record<string, unknown>>,
    canArchive?: boolean,
): Record<string, unknown> {
    return {
        id: task.id,
        name: task.name,
        folderName: task.folderName,
        ownerUserId: task.ownerUserId ?? null,
        creatorAgentId: task.creatorAgentId ?? null,
        workspaceId: task.workspaceId,
        compute:
            task.runnerId === undefined
                ? { type: "host", path: task.path }
                : { type: "runner", runnerId: task.runnerId, path: task.path },
        status: task.status,
        ...(canArchive === undefined ? {} : { canArchive }),
        agent,
        version: apiResourceVersion(task.updatedAt, task.version, task.id),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        archivedAt: task.archivedAt ?? null,
    };
}

/** The unlisted workspace owned by one task, shaped like a bot's. */
export function taskWorkspaceResource(
    task: TaskRecord,
    agent: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    return {
        id: task.workspaceId,
        projectId: null,
        parentId: null,
        botId: null,
        taskId: task.id,
        name: task.folderName,
        nameSource: "user",
        kind: "task",
        compute:
            task.runnerId === undefined
                ? { type: "host", path: task.path }
                : { type: "runner", runnerId: task.runnerId, path: task.path },
        status: task.status,
        initialization: { status: "ready", attempt: 0, error: null },
        base: null,
        git: null,
        creatorAgentId: task.creatorAgentId ?? null,
        orderKey: "5",
        version: apiResourceVersion(
            task.workspaceUpdatedAt,
            task.workspaceVersion,
            task.workspaceId,
        ),
        createdAt: task.createdAt,
        updatedAt: task.workspaceUpdatedAt,
        archivedAt: task.archivedAt ?? null,
        agents: [agent],
        subtaskAgentId: null,
    };
}

/** A person's place in one task. The standalone installation's one person has no user ID. */
export function taskMembershipResource(membership: TaskMembership): Record<string, unknown> {
    return {
        taskId: membership.taskId,
        userId: membership.memberId === STANDALONE_TASK_MEMBER ? null : membership.memberId,
        orderKey: membership.orderKey,
        joinedAt: membership.joinedAt,
    };
}

/** One artifact as the API shows it: its latest version, creation, latest change, and deletion. */
export function artifactResource(artifact: ArtifactRecord): Record<string, unknown> {
    return {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        status: artifact.status,
        latestVersion: artifact.latestVersion,
        entry: artifactFileResource(artifact.entry),
        fileCount: artifact.fileCount,
        size: artifact.size,
        source: artifactSourceResource(artifact.source),
        createdBy: artifactAuthorResource(artifact.createdBy),
        createdAt: artifact.createdAt,
        updatedBy: artifactAuthorResource(artifact.updatedBy),
        updatedSource: artifactSourceResource(artifact.updatedSource),
        updatedAt: artifact.updatedAt,
        deletedBy:
            artifact.deletedBy === undefined ? null : artifactAuthorResource(artifact.deletedBy),
        deletedSource: artifactSourceResource(artifact.deletedSource),
        deletedAt: artifact.deletedAt ?? null,
        version: apiResourceVersion(artifact.updatedAt, artifact.revision, artifact.id),
    };
}

/** One immutable version of an artifact with its whole manifest. */
export function artifactVersionResource(version: ArtifactVersion): Record<string, unknown> {
    return {
        artifactId: version.artifactId,
        number: version.number,
        title: version.title,
        entry: artifactFileResource(version.entry),
        files: version.files.map(artifactFileResource),
        createdBy: artifactAuthorResource(version.createdBy),
        source: artifactSourceResource(version.source),
        createdAt: version.createdAt,
    };
}

/** A staged upload; whether its bytes are UTF-8 stays the daemon's business. */
export function artifactUploadResource(upload: ArtifactUpload): Record<string, unknown> {
    return {
        id: upload.id,
        size: upload.size,
        sha256: upload.sha256,
        createdAt: upload.createdAt,
        expiresAt: upload.expiresAt,
    };
}

function artifactFileResource(file: ArtifactFile): Record<string, unknown> {
    return { path: file.path, mimeType: file.mimeType, size: file.size, sha256: file.sha256 };
}

/** Every kind but `agent` names its conversation as `agentId`, `null` when a person acted. */
function artifactSourceResource(
    source: ArtifactSource | undefined,
): Record<string, unknown> | null {
    if (source === undefined) return null;
    switch (source.kind) {
        case "bot":
            return { kind: "bot", botId: source.botId, agentId: source.agentId ?? null };
        case "task":
            return { kind: "task", taskId: source.taskId, agentId: source.agentId ?? null };
        case "project":
            return {
                kind: "project",
                projectId: source.projectId,
                agentId: source.agentId ?? null,
            };
        case "workspace":
            return {
                kind: "workspace",
                workspaceId: source.workspaceId,
                projectId: source.projectId,
                agentId: source.agentId ?? null,
            };
        case "agent":
            return { kind: "agent", agentId: source.agentId };
    }
}

function artifactAuthorResource(author: ArtifactAuthor): Record<string, unknown> {
    return author.kind === "agent"
        ? { kind: "agent", agentId: author.agentId, botId: author.botId ?? null }
        : { kind: "user", userId: author.userId ?? null };
}

/** The unlisted workspace owned by one bot. */
export function botWorkspaceResource(
    bot: BotRecord,
    agent: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    return {
        id: bot.workspaceId,
        projectId: null,
        parentId: null,
        botId: bot.id,
        name: bot.username,
        nameSource: "user",
        kind: "bot",
        compute: botCompute(bot),
        status: bot.status,
        initialization: { status: "ready", attempt: 0, error: null },
        base: null,
        git: null,
        creatorAgentId: null,
        orderKey: "5",
        version: apiResourceVersion(bot.workspaceUpdatedAt, bot.workspaceVersion, bot.workspaceId),
        createdAt: bot.createdAt,
        updatedAt: bot.workspaceUpdatedAt,
        archivedAt: bot.archivedAt ?? null,
        agents: [agent],
        subtaskAgentId: null,
    };
}

export function rootWorkspaceResource(
    project: Project,
    compute: ProjectCompute = { type: "host", path: project.repositoryRef },
): Record<string, unknown> {
    return {
        subtaskAgentId: null,
        id: project.id,
        projectId: project.id,
        parentId: null,
        botId: null,
        name: project.name,
        nameSource: project.nameSource === "user" ? "user" : "generated",
        kind: "root",
        compute,
        status: project.status,
        initialization: {
            status: project.initializationStatus,
            attempt: project.initializationAttempt,
            error: project.initializationError ?? null,
        },
        base: null,
        git:
            project.gitBranch === undefined &&
            project.gitHead === undefined &&
            project.gitUpstream === undefined &&
            !project.gitDetached
                ? null
                : {
                      branch: project.gitBranch ?? null,
                      head: project.gitHead ?? null,
                      upstream: project.gitUpstream ?? null,
                      ahead: project.gitAhead,
                      behind: project.gitBehind,
                      detached: project.gitDetached,
                  },
        creatorAgentId: null,
        orderKey: project.orderKey,
        version: apiResourceVersion(project.updatedAt, project.version, project.id),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        archivedAt: project.archivedAt ?? null,
    };
}

export function terminalResource(
    _workspaceId: string,
    terminal: Terminal,
): Record<string, unknown> {
    return { ...terminal };
}

export function questionResource(
    request: UserInputRequest,
    runId: string | undefined,
): Record<string, unknown> {
    const questions = request.questions?.map((question) => ({
        id: question.id,
        header: question.header ?? "Question",
        question: question.question,
        multiSelect: question.options?.multiSelect ?? false,
        options: (question.options?.choices ?? []).map((option) => ({
            label: option.label,
            description: option.description,
        })),
    })) ?? [
        {
            id: request.id,
            header: request.header ?? "Question",
            question: request.question,
            multiSelect: request.options?.multiSelect ?? false,
            options:
                request.options?.choices.map((option) => ({
                    label: option.label,
                    description: option.description,
                })) ?? [],
        },
    ];
    return {
        id: request.id,
        agentId: request.askingAgentId,
        runId: runId ?? null,
        status:
            request.status === "pending"
                ? "pending"
                : request.status === "answered"
                  ? "answered"
                  : "canceled",
        questions,
        autoResolveAt: request.deadlineAt ?? null,
        answers: questionAnswers(request),
        version: apiResourceVersion(request.updatedAt, statusVersion(request.status), request.id),
        createdAt: request.createdAt,
        answeredAt: request.status === "answered" ? request.answeredAt : null,
    };
}

export function profileResource(profile: Profile | undefined): Record<string, unknown> {
    if (profile === undefined) {
        return {
            userId: null,
            name: null,
            email: null,
            photo: null,
            version: apiResourceVersion(0, 1, "profile"),
            updatedAt: 0,
        };
    }
    return {
        userId: null,
        name: profile.name,
        email: profile.email,
        photo: profile.photo === null ? null : { thumbhash: profile.photo.thumbhash },
        version: profile.version,
        updatedAt: profile.updatedAt,
    };
}

const agentArchivedAtSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** Keep collection filtering and the resource's archival fact identical. */
export function agentArchivedAt(config: AgentConfig): number | null {
    const value = config.metadata?.["archivedAt"];
    return Value.Check(agentArchivedAtSchema, value) ? value : null;
}

export async function agentResource(
    ctx: Context,
    agents: AgentSystemRef,
    events: EventsModule,
    agentId: string,
    workspaceId: string,
    state: {
        readonly config?: AgentConfig;
        readonly children?: readonly string[];
        readonly orderKey?: string | null;
        readonly pendingQuestionId?: string | null;
        readonly runningProcesses?: number;
        readonly runningSubagents?: number;
        readonly working?: boolean;
        readonly userVisible?: boolean;
        readonly subtask?: boolean;
        readonly subtasks?: readonly Record<string, unknown>[];
        readonly subtaskOrderKey?: string | null;
        /** Read before `config`, so the version can only trail the state it is paired with. */
        readonly latestEvent?: LatestAgentEvent | null;
    } = {},
): Promise<Record<string, unknown> | undefined> {
    const config = state.config ?? (await agents.config(ctx, agentId));
    if (config === undefined) return undefined;
    const parentAgentId = await agents.parentOf(ctx, agentId);
    const children = state.children ?? (await agents.childOf(ctx, agentId));
    const latestEvent =
        state.latestEvent === undefined
            ? await events.latestAgentEvent(ctx, agentId)
            : (state.latestEvent ?? undefined);
    const metadata = config.metadata ?? {};
    const createdAt = config.provenance?.createdAt ?? 0;
    const updatedAt = Math.max(
        numericMetadata(metadata["updatedAt"]) ?? createdAt,
        latestEvent?.occurredAt ?? 0,
    );
    const version =
        latestEvent?.cursor ??
        apiResourceVersion(updatedAt, numericMetadata(metadata["version"]) ?? 1, agentId);
    const archivedAt = agentArchivedAt(config);
    const managedByAnotherAgent = parentAgentId !== null;
    return {
        id: agentId,
        workspaceId,
        parentAgentId,
        subtask: state.subtask ?? false,
        subtasks: state.subtasks ?? [],
        subtaskOrderKey: state.subtaskOrderKey ?? null,
        userVisible: state.userVisible ?? state.orderKey != null,
        managedByAnotherAgent,
        canSendMessages: (!managedByAnotherAgent || state.subtask === true) && archivedAt === null,
        title: typeof metadata.title === "string" ? metadata.title : null,
        titleStatus: typeof metadata.title === "string" ? "ready" : "idle",
        status: state.working === true ? "working" : "idle",
        subagents: { total: children.length, running: state.runningSubagents ?? 0 },
        processes: { running: state.runningProcesses ?? 0 },
        pendingQuestionId: state.pendingQuestionId ?? null,
        unread: metadata["unread"] ?? null,
        orderKey: state.orderKey ?? null,
        lastCursor: latestEvent?.cursor ?? null,
        version,
        createdAt,
        updatedAt,
        archivedAt,
    };
}

function workspaceStatus(status: Workspace["status"]): string {
    if (status === "archiving" || status === "archived") return status;
    return "active";
}

function workspaceInitializationStatus(status: Workspace["status"]): string {
    if (status === "initializing") return "initializing";
    if (status === "failed") return "failed";
    return "ready";
}

function questionAnswers(request: UserInputRequest): Record<string, readonly string[]> | null {
    if (request.status !== "answered") return null;
    if (request.answers !== undefined) {
        return Object.fromEntries(
            Object.entries(request.answers).map(([id, answer]) => [id, answerValues(answer)]),
        );
    }
    return { [request.id]: answerValues(request.answer) };
}

function answerValues(answer: unknown): readonly string[] {
    if (typeof answer === "string") return [answer];
    if (answer === undefined || answer === null || typeof answer !== "object") return [];
    const structured = answer as { text?: string; selectedOptions?: readonly string[] };
    return [
        ...(structured.selectedOptions ?? []),
        ...(structured.text === undefined ? [] : [structured.text]),
    ];
}

function statusVersion(status: UserInputRequest["status"]): number {
    if (status === "pending") return 1;
    if (status === "answered") return 2;
    return 3;
}

function numericMetadata(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

export function agentModeFromConfig(config: AgentConfig): unknown {
    const value = config.metadata?.["lastMode"];
    return value === undefined ? null : value;
}
