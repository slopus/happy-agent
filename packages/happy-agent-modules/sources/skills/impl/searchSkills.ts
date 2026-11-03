import type { SkillEntry } from "../Skills.js";
import { rankBm25 } from "../../utils/rankBm25.js";

/** Exact names first, then lexical coverage; names count more than descriptions. */
export function searchSkills(
    entries: readonly SkillEntry[],
    query: string | undefined,
): readonly SkillEntry[] {
    const normalized = query?.trim().toLowerCase();
    if (!normalized) return entries;
    const ranked = rankBm25(
        entries.map((entry) => `${entry.name} ${entry.name} ${entry.description}`),
        normalized,
    ).map(({ index }) => entries[index]!);
    const exact = entries.find((entry) => entry.name.toLowerCase() === normalized);
    return exact === undefined ? ranked : [exact, ...ranked.filter((entry) => entry !== exact)];
}
