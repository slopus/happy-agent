import type { SkillFolder } from "../SkillFolders.js";

/** One bounded, human-readable rendering of the folder list shared by the skill-folder tools. */
export function formatSkillFolders(folders: readonly SkillFolder[]): string {
    if (folders.length === 0) {
        return "No extra skill folders are configured. Skills are found only in the standard .agents/skills folders.";
    }
    const rows = folders.map(
        (folder) =>
            `- ${folder.path} (${folder.source === "user" ? "from happy.toml, only the user can remove it" : "added live"})`,
    );
    return `Extra skill folders:\n${rows.join("\n")}`;
}
