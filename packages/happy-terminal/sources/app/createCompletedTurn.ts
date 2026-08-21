import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";
import type { CompletedTurn, CompletedTurnStats } from "./CompletedTurn.js";

export function createCompletedTurn(
    entries: readonly AppTranscriptEntry[],
    elapsedMs: number,
): { entry: AppTranscriptEntry; turn: CompletedTurn } | undefined {
    const finalAssistantEntry = entries.findLast(
        (entry) => entry.role === "assistant" && entry.text.trim().length > 0,
    );
    if (finalAssistantEntry === undefined) return undefined;

    const filePaths = new Set<string>();
    let omittedFiles = 0;
    const stats: CompletedTurnStats = {
        additions: 0,
        deletions: 0,
        elapsedMs,
        fileCount: 0,
        toolCount: 0,
    };

    for (const entry of entries) {
        const isTool =
            entry.role === "tool" ||
            (entry.role === "error" && entry.detail !== undefined) ||
            entry.backgroundTerminalInteraction !== undefined ||
            entry.execCommand !== undefined ||
            entry.fileDiffs !== undefined ||
            entry.mcpToolCall !== undefined;
        if (isTool) stats.toolCount += 1;

        omittedFiles += Math.max(0, Math.floor(entry.omittedFileDiffs ?? 0));
        for (const diff of entry.fileDiffs ?? []) {
            filePaths.add(diff.path);
            stats.additions +=
                diff.added ??
                diff.hunks.reduce(
                    (total, hunk) =>
                        total + hunk.lines.filter((line) => line.kind === "add").length,
                    0,
                );
            stats.deletions +=
                diff.deleted ??
                diff.hunks.reduce(
                    (total, hunk) =>
                        total + hunk.lines.filter((line) => line.kind === "delete").length,
                    0,
                );
        }
    }
    stats.fileCount = filePaths.size + omittedFiles;

    return {
        entry: finalAssistantEntry,
        turn: {
            hiddenEntryIds: entries
                .filter((entry) => entry !== finalAssistantEntry && entry.role !== "user")
                .map((entry) => entry.id),
            stats,
        },
    };
}
