import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { parseHappyAgentConfigToml } from "../../config/index.js";

/** The project configuration files a change to which re-arms sync. */
export const PROJECT_CONFIG_FILE_NAMES: readonly string[] = ["happy.toml"];

const MAX_PROJECT_CONFIG_BYTES = 1_048_576;

/**
 * The workspace-shaped part of the configuration, read for one folder.
 *
 * `sync` and `protectedSync` say which project files are replicated into every workspace,
 * `setupCommands` is what a new workspace runs once its checkout exists, and the two keep flags
 * decide what archival leaves on disk: a worktree Git can rebuild, or a copied folder that is
 * only ever the person's own.
 */
export const workspaceFolderSettingsSchema = Type.Object(
    {
        keepCopiesOnArchive: Type.Boolean(),
        keepWorktreesOnArchive: Type.Boolean(),
        protectedSync: Type.Array(Type.String()),
        setupCommands: Type.Array(Type.String()),
        sync: Type.Array(Type.String()),
    },
    { additionalProperties: false },
);

export type WorkspaceFolderSettings = Static<typeof workspaceFolderSettingsSchema>;

export const DEFAULT_WORKSPACE_FOLDER_SETTINGS: WorkspaceFolderSettings = {
    keepCopiesOnArchive: true,
    keepWorktreesOnArchive: false,
    protectedSync: [],
    setupCommands: [],
    sync: [],
};

/**
 * Reads a folder's own `happy.toml` over the agent's resolved defaults.
 *
 * The sync list and the setup commands belong to the folder being worked in, and they are read
 * again on every pass rather than cached, so an uncommitted change to a project's configuration
 * takes effect without restarting the agent. An unreadable or invalid file yields the defaults
 * instead of failing the workspace.
 */
export async function loadWorkspaceFolderSettings(
    folder: string,
    defaults: WorkspaceFolderSettings = DEFAULT_WORKSPACE_FOLDER_SETTINGS,
    read: (path: string) => Promise<string> = async (path) => await readFile(path, "utf8"),
): Promise<WorkspaceFolderSettings> {
    let source: string;
    try {
        source = await read(join(folder, PROJECT_CONFIG_FILE_NAMES[0] ?? "happy.toml"));
    } catch {
        return defaults;
    }
    if (Buffer.byteLength(source, "utf8") > MAX_PROJECT_CONFIG_BYTES) return defaults;
    let workspace: Record<string, unknown> | undefined;
    try {
        workspace = parseHappyAgentConfigToml(source).values.workspace as
            | Record<string, unknown>
            | undefined;
    } catch {
        return defaults;
    }
    if (workspace === undefined) return defaults;
    return {
        keepCopiesOnArchive: boolean(
            workspace.keep_copies_on_archive,
            defaults.keepCopiesOnArchive,
        ),
        keepWorktreesOnArchive: boolean(
            workspace.keep_worktrees_on_archive,
            defaults.keepWorktreesOnArchive,
        ),
        protectedSync: strings(workspace.protected_sync, defaults.protectedSync),
        setupCommands: strings(workspace.setup_commands, defaults.setupCommands),
        sync: strings(workspace.sync, defaults.sync),
    };
}

function strings(value: unknown, fallback: readonly string[]): string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? [...value]
        : [...fallback];
}

function boolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}
