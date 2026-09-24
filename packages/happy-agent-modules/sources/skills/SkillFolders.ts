import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

/** An absolute path to a folder on the daemon's machine that holds skill directories. */
export const skillFolderPathSchema = Type.String({
    minLength: 1,
    maxLength: 4_096,
    pattern: "^/[^\\u0000\\r\\n]*$",
    description: "The absolute path of a folder whose subdirectories each contain a SKILL.md.",
});

/**
 * One extra skill folder this machine scans. `user` folders come from the user `happy.toml` and
 * only that file can remove them; `runtime` folders were added live and can be removed live.
 */
export const skillFolderSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        source: Type.Union([Type.Literal("user"), Type.Literal("runtime")]),
    },
    exact,
);
export type SkillFolder = Static<typeof skillFolderSchema>;

export const skillFolderListSchema = Type.Object(
    { folders: Type.Array(skillFolderSchema, { maxItems: 512 }) },
    exact,
);
export type SkillFolderList = Static<typeof skillFolderListSchema>;

export const skillFolderChangeSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
        changed: Type.Boolean(),
        folders: Type.Array(skillFolderSchema, { maxItems: 512 }),
    },
    exact,
);
export type SkillFolderChange = Static<typeof skillFolderChangeSchema>;

export const skillFolderInputSchema = Type.Object({ path: skillFolderPathSchema }, exact);
export type SkillFolderInput = Static<typeof skillFolderInputSchema>;
