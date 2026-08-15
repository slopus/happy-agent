import type { FileSystemContext } from "../context/FileSystemContext.js";
import { formatSkillsForPrompt } from "./formatSkillsForPrompt.js";
import { loadSkills } from "./loadSkills.js";
import type { Skill } from "./Skill.js";

export async function loadSkillInstructions(
    fs: FileSystemContext,
    loadedSkills?: readonly Skill[],
): Promise<string | undefined> {
    return formatSkillsForPrompt(loadedSkills ?? (await loadSkills(fs)));
}
