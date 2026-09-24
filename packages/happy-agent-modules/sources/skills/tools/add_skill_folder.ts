import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    skillFolderChangeSchema,
    skillFolderInputSchema,
    type SkillFolderInput,
} from "../SkillFolders.js";
import type { SkillFoldersModule } from "../SkillFoldersModule.js";
import { formatSkillFolders } from "./skillFolderToolOutput.js";

/** Add one extra skill folder for every agent on this installation, without a restart. */
export function addSkillFolderTool(skillFolders: SkillFoldersModule, actingAgentId: string) {
    return defineAgentTool({
        name: "add_skill_folder",
        defer: true,
        capabilities: ["List, add, and remove this installation's extra skill folders."],
        searchKeywords: ["add skill folder", "skill directory", "install skills", "skills path"],
        description:
            "Add a folder, given as an absolute path on this machine, that every agent on this Happy Agent installation scans for skills. Each subdirectory of the folder that contains a SKILL.md becomes a skill, exactly like ~/.agents/skills. The change is saved in runtime.toml and applies from each agent's next turn. Only active admin bots may use it.",
        parameters: skillFolderInputSchema,
        returnType: skillFolderChangeSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ path }: SkillFolderInput) =>
            `adding ${JSON.stringify(path)} as a skill folder for every agent on this Happy Agent installation. Access: installation-wide configuration write`,
        execute: async (ctx, { path }: SkillFolderInput) =>
            await skillFolders.add(ctx, actingAgentId, path),
        toLLM: (result) => [
            {
                type: "text",
                text: `${
                    result.changed
                        ? `Added ${result.path} as a skill folder.`
                        : `${result.path} was already a skill folder.`
                }\n\n${formatSkillFolders(result.folders)}`,
            },
        ],
    });
}
