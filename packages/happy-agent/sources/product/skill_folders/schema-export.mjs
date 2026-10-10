import * as original from "../../../../happy-agent-modules/sources/skills/SkillFolders.ts";
import { listSkillFoldersTool } from "../../../../happy-agent-modules/sources/skills/tools/list_skill_folders.ts";
import { addSkillFolderTool } from "../../../../happy-agent-modules/sources/skills/tools/add_skill_folder.ts";
import { removeSkillFolderTool } from "../../../../happy-agent-modules/sources/skills/tools/remove_skill_folder.ts";
import { formatSkillFolders } from "../../../../happy-agent-modules/sources/skills/tools/skillFolderToolOutput.ts";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
export const skillFoldersTools = [
    listSkillFoldersTool(undefined, "source-agent"),
    addSkillFolderTool(undefined, "source-agent"),
    removeSkillFolderTool(undefined, "source-agent"),
];
export const skillFoldersSchemas = {
    ownerSkillFolderPath: original.skillFolderPathSchema,
    ownerSkillFolderList: original.skillFolderListSchema,
    ownerSkillFolderChange: original.skillFolderChangeSchema,
    ownerSkillFolderInput: original.skillFolderInputSchema,
    ownerSkillFolderAgentMetadata: Type.Object({}, { additionalProperties: true }),
};
for (const tool of skillFoldersTools) {
    skillFoldersSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
const cases = [
    [],
    [
        { path: "/user/skills", source: "user" },
        { path: "/live/skills", source: "runtime" },
    ],
];
writeFileSync(
    new URL("format_goldens.json", import.meta.url),
    `${JSON.stringify(
        cases.map((folders) => ({ folders, text: formatSkillFolders(folders) })),
        null,
        2,
    )}\n`,
);
