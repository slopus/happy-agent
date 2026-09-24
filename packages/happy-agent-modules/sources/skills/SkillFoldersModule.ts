import { stat } from "node:fs/promises";

import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import {
    skillFolderPathSchema,
    type SkillFolder,
    type SkillFolderChange,
    type SkillFolderList,
} from "./SkillFolders.js";
import { addSkillFolderTool } from "./tools/add_skill_folder.js";
import { listSkillFoldersTool } from "./tools/list_skill_folders.js";
import { removeSkillFolderTool } from "./tools/remove_skill_folder.js";

/**
 * Owns live changes to this machine's extra skill folders and the admin-only tools that make them.
 *
 * The folders live in generated `runtime.toml` beside those the user `happy.toml` names. Skill
 * discovery reads the list afresh on every scan, so a change reaches every agent's next turn
 * without a restart.
 */
export class SkillFoldersModule implements AgentModule {
    readonly name = "skill-folders";
    readonly #config: ConfigModule;
    readonly #bots: BotsModule;

    constructor(config: ConfigModule, bots: BotsModule) {
        this.#config = config;
        this.#bots = bots;
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> =>
            (await this.#isActiveAdminBot(ctx, scope.agent.id))
                ? [
                      listSkillFoldersTool(this, scope.agent.id),
                      addSkillFolderTool(this, scope.agent.id),
                      removeSkillFolderTool(this, scope.agent.id),
                  ]
                : [],
    });

    async list(ctx: Context, actingAgentId: string): Promise<SkillFolderList> {
        await this.#requireActiveAdminBot(ctx, actingAgentId);
        return { folders: this.#folders() };
    }

    /** Adding a folder that is already listed succeeds without change, so a retry is harmless. */
    async add(ctx: Context, actingAgentId: string, path: string): Promise<SkillFolderChange> {
        await this.#requireActiveAdminBot(ctx, actingAgentId);
        const resolved = this.#resolve(path);
        if (this.#config.userSkillDirectories.includes(resolved)) {
            return { path: resolved, changed: false, folders: this.#folders() };
        }
        const info = await stat(resolved).catch(() => undefined);
        if (info === undefined) throw new Error(`The folder ${resolved} does not exist.`);
        if (!info.isDirectory()) throw new Error(`${resolved} is not a folder.`);
        const changed = await this.#config.addRuntimeSkillDirectory(ctx, resolved);
        return { path: resolved, changed, folders: this.#folders() };
    }

    /** Removing a folder that is no longer listed succeeds without change, so a retry is harmless. */
    async remove(ctx: Context, actingAgentId: string, path: string): Promise<SkillFolderChange> {
        await this.#requireActiveAdminBot(ctx, actingAgentId);
        const resolved = this.#resolve(path);
        const changed = await this.#config.removeRuntimeSkillDirectory(ctx, resolved);
        if (!changed && this.#config.userSkillDirectories.includes(resolved)) {
            throw new Error(
                `The folder ${resolved} is listed in ${this.#config.configuration.paths.globalConfigPath}. Only the user can remove it by editing that file.`,
            );
        }
        return { path: resolved, changed, folders: this.#folders() };
    }

    #resolve(path: string): string {
        if (!Value.Check(skillFolderPathSchema, path)) {
            throw new Error("A skill folder must be an absolute path.");
        }
        return this.#config.resolveSkillDirectory(path);
    }

    #folders(): SkillFolder[] {
        const user = this.#config.userSkillDirectories;
        return [
            ...user.map((path) => ({ path, source: "user" as const })),
            ...this.#config.runtimeSkillDirectories
                .filter((path) => !user.includes(path))
                .map((path) => ({ path, source: "runtime" as const })),
        ];
    }

    async #isActiveAdminBot(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    async #requireActiveAdminBot(ctx: Context, agentId: string): Promise<void> {
        if (await this.#isActiveAdminBot(ctx, agentId)) return;
        throw new Error("Only an active admin bot can manage this installation's skill folders.");
    }
}
