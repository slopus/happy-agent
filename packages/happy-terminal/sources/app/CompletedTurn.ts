export interface CompletedTurnStats {
    additions: number;
    deletions: number;
    elapsedMs: number;
    fileCount: number;
    toolCount: number;
}

export interface CompletedTurn {
    hiddenEntryIds: readonly string[];
    stats: CompletedTurnStats;
}
