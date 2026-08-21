import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";

export function compactCompletedTurnEntries(
    entries: readonly AppTranscriptEntry[],
): AppTranscriptEntry[] {
    const hiddenEntryIds = new Set(
        entries.flatMap((entry) => entry.completedTurn?.hiddenEntryIds ?? []),
    );
    return entries.filter((entry) => !hiddenEntryIds.has(entry.id));
}
