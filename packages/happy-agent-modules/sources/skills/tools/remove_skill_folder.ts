import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    skillFolderChangeSchema,
    skillFolderInputSchema,
    type SkillFolderInput,
} from "../SkillFolders.js";
import type { SkillFoldersModule } from "../SkillFoldersModule.js";
import { formatSkillFolders } from "./skillFolderToolOutput.js";

/** Stop scanning one live-added skill folder on this installation, without a restart. */
export function removeSkillFolderTool(skillFolders: SkillFoldersModule, actingAgentId: string) {
    return defineAgentTool({
        name: "remove_skill_folder",
        defer: true,
        capabilities: ["List, add, and remove this installation's extra skill folders."],
        searchKeywords: ["remove skill folder", "skill directory", "uninstall skills"],
        description:
            "Stop scanning a skill folder, given as an absolute path, that was added to this Happy Agent installation. The folder and its files are left untouched. Folders listed in the user's happy.toml cannot be removed with this tool. The change is saved in runtime.toml and applies from each agent's next turn. Only active admin bots may use it.",
        parameters: skillFolderInputSchema,
        returnType: skillFolderChangeSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ path }: SkillFolderInput) =>
            `removing ${JSON.stringify(path)} from the skill folders of every agent on this Happy Agent installation. Access: installation-wide configuration write`,
        execute: async (ctx, { path }: SkillFolderInput) =>
            await skillFolders.remove(ctx, actingAgentId, path),
        toLLM: (result) => [
            {
                type: "text",
                text: `${
                    result.changed
                        ? `Removed ${result.path} from the skill folders.`
                        : `${result.path} was not a skill folder.`
                }\n\n${formatSkillFolders(result.folders)}`,
            },
        ],
    });
}
