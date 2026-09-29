import type { Project } from "./Project.js";
import type { ProjectPage } from "./ProjectPage.js";
import type { ProjectSettings } from "./ProjectSettings.js";

/**
 * The model-facing wording for a project. Every value is written out in plain
 * English rather than as the stored identifier.
 */
export function projectText(project: Project): string {
    return [
        `Project ID: ${project.id}`,
        `Name: ${project.name} (${nameSourceText(project)})`,
        `Folder: ${project.repositoryRef}`,
        `Kind: ${project.kind === "home" ? "Home folder" : "Regular folder"}`,
        `Status: ${project.status === "archived" ? "Archived" : "Active"}`,
        `Folder on disk: ${project.presence === "present" ? "Yes" : "No"}`,
        `Setup: ${initializationText(project)}`,
        `Workspaces: ${worktreeText(project)}`,
        ...(project.defaultBranch === undefined
            ? []
            : [`Default branch: ${project.defaultBranch}`]),
        `Git: ${gitText(project)}`,
        ...(project.remoteSource === undefined ? [] : [`Remote: ${remoteText(project)}`]),
        ...(project.requiredSecretKind === undefined
            ? []
            : ["Needs a GitHub credential before it can be cloned again."]),
        ...(project.description === undefined ? [] : [`Description: ${project.description}`]),
        ...(project.avatar === undefined
            ? []
            : [`Avatar: ${project.avatar.source} image with a ThumbHash placeholder`]),
        `Order key: ${project.orderKey}`,
        `Version: ${String(project.version)}`,
        `Created at: ${String(project.createdAt)}`,
        `Updated at: ${String(project.updatedAt)}`,
        ...(project.archivedAt === undefined ? [] : [`Archived at: ${String(project.archivedAt)}`]),
    ].join("\n");
}

export function formatProjectForModel(
    label: string,
    project: Project,
    maxOutputCharacters: number,
): string {
    return fitText(`${label}\n${projectText(project)}`, maxOutputCharacters);
}

export function formatSettingsForModel(
    projectId: string,
    settings: ProjectSettings,
    maxOutputCharacters: number,
): string {
    const compute = settings.defaultWorkspaceCompute;
    const computeText =
        compute === undefined
            ? "No default workspace compute; new workspaces use the host default."
            : compute.type === "local"
              ? "New workspaces run locally."
              : `New workspaces run in Docker using the ${compute.image} image.`;
    const promptText =
        settings.workspaceInitialPrompt === undefined
            ? "No initial prompt: the first agent in a new workspace waits for the person."
            : `The first agent in a new workspace is told:\n${settings.workspaceInitialPrompt}`;
    return fitText(
        `Project ${projectId} settings\n${computeText}\n${promptText}`,
        maxOutputCharacters,
    );
}

/**
 * Trims a page to what fits the model-output budget and rewrites its cursor so
 * the caller can continue exactly where the visible rows stopped.
 */
export function fitProjectPage(
    page: ProjectPage,
    cursor: string | undefined,
    maxOutputCharacters: number,
): ProjectPage {
    if (page.projects.length === 0) return page;
    const start = cursor === undefined ? 0 : Number(cursor);
    const visible: Project[] = [];
    let size = 0;
    for (const project of page.projects) {
        const row = projectRow(project);
        const nextSize = size + row.length + (visible.length === 0 ? 0 : 1);
        const candidateCount = visible.length + 1;
        const needsContinuation =
            page.nextCursor !== undefined || candidateCount < page.projects.length;
        const continuation = needsContinuation
            ? `More projects at cursor ${String(start + candidateCount)}.`.length + 1
            : 0;
        if (nextSize + continuation > maxOutputCharacters) break;
        visible.push(project);
        size = nextSize;
    }
    if (visible.length === 0) {
        // A legal folder path can be longer than the whole output budget. Keeping the first row
        // and letting the text be truncated leaves the person something to act on, where an empty
        // page would leave them nothing at all.
        visible.push(page.projects[0]!);
    }
    const consumedAll = visible.length === page.projects.length;
    const nextCursor =
        consumedAll && page.nextCursor === undefined ? undefined : String(start + visible.length);
    return {
        projects: visible,
        ...(nextCursor === undefined ? {} : { nextCursor }),
    };
}

export function formatPageForModel(page: ProjectPage, maxOutputCharacters: number): string {
    const body =
        page.projects.length === 0 ? "No projects." : page.projects.map(projectRow).join("\n");
    const output =
        page.nextCursor === undefined
            ? body
            : `${body}\nMore projects at cursor ${page.nextCursor}.`;
    return fitText(output, maxOutputCharacters);
}

/** One line per project, for a list. */
export function projectRow(project: Project): string {
    return [
        `Project ID: ${project.id}`,
        `Name: ${project.name}`,
        `Folder: ${project.repositoryRef}`,
        `Status: ${project.status === "archived" ? "Archived" : "Active"}`,
        `Setup: ${initializationText(project)}`,
        `Version: ${String(project.version)}`,
    ].join(" | ");
}

function nameSourceText(project: Project): string {
    if (project.nameSource === "user") return "named by a person";
    if (project.nameSource === "remote") return "taken from the remote repository";
    return "taken from the folder";
}

function initializationText(project: Project): string {
    if (project.initializationStatus === "ready") return "Ready";
    if (project.initializationStatus === "initializing") return "Still being set up";
    return `Failed after ${String(project.initializationAttempt)} attempt(s): ${
        project.initializationError ?? "no detail was recorded"
    }`;
}

function worktreeText(project: Project): string {
    if (project.worktreeSupport === "supported") return "This project can create Git worktrees.";
    if (project.worktreeSupport === "unsupported") {
        return `This project cannot create Git worktrees: ${
            project.worktreeUnsupportedReason ?? "no reason was recorded"
        }`;
    }
    return "Worktree support has not been checked yet.";
}

function gitText(project: Project): string {
    if (project.gitHead === undefined && project.gitBranch === undefined) {
        return "No Git state has been recorded yet.";
    }
    const parts = [
        project.gitDetached
            ? "detached HEAD"
            : `on branch ${project.gitBranch ?? "an unnamed branch"}`,
        ...(project.gitHead === undefined ? [] : [`at commit ${project.gitHead}`]),
        ...(project.gitUpstream === undefined ? [] : [`tracking ${project.gitUpstream}`]),
        `${String(project.gitAhead)} ahead`,
        `${String(project.gitBehind)} behind`,
    ];
    return parts.join(", ");
}

function remoteText(project: Project): string {
    const remote = project.remoteSource;
    if (remote === undefined) return "none";
    return remote.kind === "github" ? `GitHub repository ${remote.repository}` : remote.url;
}

function fitText(text: string, maxOutputCharacters: number): string {
    if (maxOutputCharacters < 1) {
        throw new Error("The project model-output budget must leave room for text.");
    }
    if (text.length <= maxOutputCharacters) return text;
    return `${text.slice(0, maxOutputCharacters - 1)}…`;
}
