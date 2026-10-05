import { Value } from "@sinclair/typebox/value";

import {
    projectAvatarSchema,
    projectRemoteSourceSchema,
    projectSchema,
    projectWorkspaceSetupCommandsSchema,
    type Project,
    type ProjectAvatar,
    type ProjectRemoteSource,
    type ProjectWorkspaceSetupCommands,
} from "./Project.js";
import { projectSettingsSchema, type ProjectSettings } from "./ProjectSettings.js";

/** One stored project, exactly as SQLite hands it back. */
export type ProjectRow = {
    readonly id: string;
    readonly repository_ref: string;
    readonly kind: string;
    readonly storage_key: string;
    readonly name: string;
    readonly name_source: string;
    readonly status: string;
    readonly presence: string;
    readonly initialization_status: string;
    readonly initialization_attempt: number | string;
    readonly initialization_error: string | null;
    readonly default_branch: string | null;
    readonly worktree_support: string;
    readonly worktree_unsupported_reason: string | null;
    readonly remote_source_json: string | null;
    readonly required_secret_kind: string | null;
    readonly git_ahead: number | string;
    readonly git_behind: number | string;
    readonly git_detached: number | string;
    readonly git_branch: string | null;
    readonly git_head: string | null;
    readonly git_upstream: string | null;
    readonly workspace_setup_commands_json: string | null;
    readonly order_key: string;
    readonly version: number | string;
    readonly avatar_json: string | null;
    readonly description: string | null;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly archived_at: number | string | null;
};

export type ProjectSettingsRow = {
    readonly project_id: string;
    readonly settings_json: string;
};

export function projectFromRow(row: ProjectRow): Project {
    const project: Project = {
        id: row.id,
        repositoryRef: row.repository_ref,
        kind: row.kind as Project["kind"],
        storageKey: row.storage_key,
        name: row.name,
        nameSource: row.name_source as Project["nameSource"],
        status: row.status as Project["status"],
        presence: row.presence as Project["presence"],
        initializationStatus: row.initialization_status as Project["initializationStatus"],
        initializationAttempt: Number(row.initialization_attempt),
        ...(row.initialization_error === null
            ? {}
            : { initializationError: row.initialization_error }),
        ...(row.default_branch === null ? {} : { defaultBranch: row.default_branch }),
        worktreeSupport: row.worktree_support as Project["worktreeSupport"],
        ...(row.worktree_unsupported_reason === null
            ? {}
            : { worktreeUnsupportedReason: row.worktree_unsupported_reason }),
        ...(row.remote_source_json === null
            ? {}
            : { remoteSource: parseProjectRemoteSource(row.remote_source_json) }),
        ...(row.required_secret_kind === null
            ? {}
            : { requiredSecretKind: row.required_secret_kind as "github" }),
        gitAhead: Number(row.git_ahead),
        gitBehind: Number(row.git_behind),
        gitDetached: storedBoolean(row.git_detached, "gitDetached"),
        ...(row.git_branch === null ? {} : { gitBranch: row.git_branch }),
        ...(row.git_head === null ? {} : { gitHead: row.git_head }),
        ...(row.git_upstream === null ? {} : { gitUpstream: row.git_upstream }),
        ...(row.workspace_setup_commands_json === null
            ? {}
            : {
                  workspaceSetupCommands: parseProjectWorkspaceSetupCommands(
                      row.workspace_setup_commands_json,
                  ),
              }),
        orderKey: row.order_key,
        version: Number(row.version),
        ...(row.avatar_json === null ? {} : { avatar: parseProjectAvatar(row.avatar_json) }),
        ...(row.description === null ? {} : { description: row.description }),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
    assertProject(project);
    return project;
}

/**
 * A stored flag is 0 or 1. Anything else is a value this catalog never wrote, so it is refused
 * rather than coerced into a true that nobody recorded.
 */
function storedBoolean(value: number | string, field: string): boolean {
    const numeric = typeof value === "string" ? Number(value) : value;
    if (numeric !== 0 && numeric !== 1) {
        throw new Error(`Project storage holds an invalid "${field}" value.`);
    }
    return numeric === 1;
}

export function assertProject(value: unknown): asserts value is Project {
    if (!Value.Check(projectSchema, value)) {
        throw new Error("Project storage returned an invalid project.");
    }
}

export function parseProjectAvatar(value: string): ProjectAvatar {
    const parsed = parseJson(value, "avatar");
    if (!Value.Check(projectAvatarSchema, parsed)) {
        throw new Error("Project avatar storage contains an invalid value.");
    }
    return structuredClone(parsed);
}

export function parseProjectWorkspaceSetupCommands(value: string): ProjectWorkspaceSetupCommands {
    const parsed = parseJson(value, "workspace setup commands");
    if (!Value.Check(projectWorkspaceSetupCommandsSchema, parsed)) {
        throw new Error("Project workspace setup command storage contains an invalid value.");
    }
    return structuredClone(parsed);
}

export function parseProjectRemoteSource(value: string): ProjectRemoteSource {
    const parsed = parseJson(value, "remote source");
    if (!Value.Check(projectRemoteSourceSchema, parsed)) {
        throw new Error("Project remote-source storage contains an invalid value.");
    }
    return structuredClone(parsed);
}

export function parseProjectSettings(value: string): ProjectSettings {
    const parsed = parseJson(value, "settings");
    if (!Value.Check(projectSettingsSchema, parsed)) {
        throw new Error("Project settings storage contains an invalid value.");
    }
    return structuredClone(parsed);
}

function parseJson(value: string, label: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`Project ${label} storage contains invalid JSON.`);
    }
}
