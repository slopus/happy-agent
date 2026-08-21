import type { PartialHappyTerminalConfig } from "./types.js";

/**
 * The startup notice shown when a project's config file asked for a machine-level setting the
 * merge refused. Only the permission mode is machine-level in this file's schema; everything
 * else it may set is an ordinary preference.
 */
export function createProjectConfigSecurityNotice(
    config: PartialHappyTerminalConfig,
    configFileName = "happy.toml",
): { text: string; title: string } | undefined {
    if (config.defaults?.permissionMode === undefined) return undefined;
    return {
        text: `This project's ${configFileName} requested a permission mode. Happy Terminal applied the other project preferences but kept your user-level permission choice.`,
        title: "Project permission ignored",
    };
}
