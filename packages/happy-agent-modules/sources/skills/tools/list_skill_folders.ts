import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { skillFolderListSchema } from "../SkillFolders.js";
import type { SkillFoldersModule } from "../SkillFoldersModule.js";
import { formatSkillFolders } from "./skillFolderToolOutput.js";

/** Read the extra skill folders this installation scans beside the standard roots. */
export function listSkillFoldersTool(skillFolders: SkillFoldersModule, actingAgentId: string) {
    return defineAgentTool({
        name: "list_skill_folders",
        defer: true,
        capabilities: ["List, add, and remove this installation's extra skill folders."],
        searchKeywords: ["skill folders", "skill directories", "skills path", "list skills roots"],
        description:
            "List the extra folders this Happy Agent installation scans for skills, beside ~/.agents/skills and each project's .agents/skills. Only active admin bots may use it.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: skillFolderListSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await skillFolders.list(ctx, actingAgentId),
        toLLM: (result) => [{ type: "text", text: formatSkillFolders(result.folders) }],
    });
}
