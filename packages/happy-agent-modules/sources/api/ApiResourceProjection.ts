import { createHash } from "node:crypto";

import type { AgentConfig, AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { GitChangeSnapshot } from "../git/index.js";
import type { Profile } from "../profile/index.js";
import { ProjectsModule, type Project, type ProjectSettings } from "../projects/index.js";
import type { Terminal } from "../terminals/index.js";
import type { UserInputRequest } from "../userInput/index.js";
import type { Workspace } from "../workspaces/index.js";
import { EventsModule } from "../events/index.js";

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
    return projectResourceWithSettings(project, settings);
}

export function projectResourceWithSettings(
    project: Project,
    settings: ProjectSettings,
): Record<string, unknown> {
    const defaultWorkspaceCompute = settings.defaultWorkspaceCompute;
    const hasGit =
        project.gitBranch !== undefined ||
        project.gitHead !== undefined ||
        project.gitUpstream !== undefined ||
        project.gitDetached;
    return {
        id: project.id,
        name: project.name,
        nameSource: project.nameSource === "user" ? "user" : "folder",
        compute: { type: "host", path: project.repositoryRef },
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
        settings: {
            defaultWorkspaceCompute:
                defaultWorkspaceCompute === undefined || defaultWorkspaceCompute.type === "local"
                    ? { type: "host" }
                    : defaultWorkspaceCompute,
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
        name: workspace.name,
        nameSource: workspace.nameConfigured ? "user" : "generated",
        kind: workspace.kind === "git_worktree" ? "worktree" : "copy",
        compute: { type: "host", path: workspace.path },
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
        orderKey: workspace.orderKey,
        version: apiResourceVersion(workspace.updatedAt, workspace.version, workspace.id),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        archivedAt: workspace.archivedAt ?? null,
    };
}

export function rootWorkspaceResource(project: Project): Record<string, unknown> {
    return {
        id: project.id,
        projectId: project.id,
        parentId: null,
        name: project.name,
        nameSource: project.nameSource === "user" ? "user" : "generated",
        kind: "root",
        compute: { type: "host", path: project.repositoryRef },
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

export function gitResource(snapshot: GitChangeSnapshot): Record<string, unknown> {
    return {
        facts: {
            branch: snapshot.facts.branch ?? null,
            detached: snapshot.facts.detached,
            head: snapshot.facts.head ?? null,
            upstream: snapshot.facts.upstream ?? null,
            ahead: snapshot.facts.ahead,
            behind: snapshot.facts.behind,
        },
        comparison: snapshot.comparison,
        base: snapshot.base ?? null,
        changedFiles: snapshot.changedFiles,
        insertions: snapshot.insertions,
        deletions: snapshot.deletions,
        countsExact: snapshot.countsExact,
        conflicted: snapshot.conflicted,
        files: snapshot.files.map((file) => ({
            path: file.path,
            ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
            status: file.status,
            staged: file.staged,
            unstaged: file.unstaged,
            binary: file.binary,
            ...(file.insertions === undefined ? {} : { insertions: file.insertions }),
            ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
        })),
        filesTruncated: snapshot.filesTruncated,
        scannedAt: snapshot.scannedAt,
    };
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
            name: null,
            email: null,
            photo: null,
            version: apiResourceVersion(0, 1, "profile"),
            updatedAt: 0,
        };
    }
    return {
        name: profile.name,
        email: profile.email,
        photo: profile.photo === null ? null : { thumbhash: profile.photo.thumbhash },
        version: profile.version,
        updatedAt: profile.updatedAt,
    };
}

export async function agentResource(
    ctx: Context,
    agents: AgentSystemRef,
    events: EventsModule,
    agentId: string,
    workspaceId: string,
    state: {
        readonly orderKey?: string | null;
        readonly pendingQuestionId?: string | null;
        readonly runningProcesses?: number;
        readonly runningSubagents?: number;
        readonly working?: boolean;
    } = {},
): Promise<Record<string, unknown> | undefined> {
    const config = await agents.config(ctx, agentId);
    if (config === undefined) return undefined;
    const parentAgentId = await agents.parentOf(ctx, agentId);
    const children = await agents.childOf(ctx, agentId);
    const latestEvent = await events.latestAgentEvent(ctx, agentId);
    const metadata = config.metadata ?? {};
    const createdAt = config.provenance?.createdAt ?? 0;
    const updatedAt = Math.max(
        numericMetadata(metadata["updatedAt"]) ?? createdAt,
        latestEvent?.occurredAt ?? 0,
    );
    const version =
        latestEvent?.cursor ??
        apiResourceVersion(updatedAt, numericMetadata(metadata["version"]) ?? 1, agentId);
    const archivedAt = numericMetadata(metadata["archivedAt"]) ?? null;
    const managedByAnotherAgent = parentAgentId !== null;
    return {
        id: agentId,
        workspaceId,
        parentAgentId,
        userVisible: state.orderKey != null,
        managedByAnotherAgent,
        canSendMessages: !managedByAnotherAgent && archivedAt === null,
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
