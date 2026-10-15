import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";

import { skillEntrySchema, type SkillEntry } from "../Skills.js";
import { parseSkillFrontmatter } from "./parseSkillFrontmatter.js";

/** Where builtin skills say they come from, in the catalog and in `list_skills`. */
export const BUILTIN_SKILL_SOURCE = "builtin";

/** One skill Happy Agent ships, with its complete document already in memory. */
export interface BuiltinSkill {
    readonly entry: SkillEntry;
    readonly content: string;
}

const guidedReview = readFileSync(
    new URL("../builtin/guided-review/SKILL.md", import.meta.url),
    "utf8",
);

/**
 * The skills shipped inside Happy Agent, read from the package when it loads. Their location names
 * them rather than a path, so only `read_skill` can open one. The bundled binary has no files, so
 * its build inlines each document in place of the read above.
 */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
    builtinSkill("guided-review", guidedReview),
];

function builtinSkill(directory: string, content: string): BuiltinSkill {
    const metadata = parseSkillFrontmatter(content, directory);
    const entry = {
        description: metadata.description,
        ...(metadata.disableModelInvocation === true ? { disableModelInvocation: true } : {}),
        location: `${BUILTIN_SKILL_SOURCE}:${directory}/SKILL.md`,
        name: metadata.name,
        source: BUILTIN_SKILL_SOURCE,
    };
    if (!Value.Check(skillEntrySchema, entry))
        throw new Error(`The builtin "${directory}" skill is invalid.`);
    return { entry, content };
}
