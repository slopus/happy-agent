import type { AppTranscriptEntry } from "./AppTranscriptEntry.js";

interface CachedEntryRender {
    readonly backgroundTerminalCompletion: string | undefined;
    readonly backgroundTerminalInteraction: AppTranscriptEntry["backgroundTerminalInteraction"];
    readonly childText: boolean | undefined;
    readonly detail: string | undefined;
    readonly dynamicState: string;
    readonly execCommand: AppTranscriptEntry["execCommand"];
    readonly exploration: AppTranscriptEntry["exploration"];
    readonly fileDiffs: AppTranscriptEntry["fileDiffs"];
    readonly lines: readonly string[];
    readonly mcpToolCall: AppTranscriptEntry["mcpToolCall"];
    readonly noticeChildren: AppTranscriptEntry["noticeChildren"];
    readonly omittedFileDiffs: number | undefined;
    readonly toolPermission: AppTranscriptEntry["toolPermission"];
    readonly role: AppTranscriptEntry["role"];
    readonly text: string;
    readonly theme: object;
    readonly title: string | undefined;
    readonly turnElapsedMs: number | undefined;
    readonly width: number;
}

export class TranscriptEntryRenderCache {
    #entries = new WeakMap<AppTranscriptEntry, CachedEntryRender>();

    render(
        entry: AppTranscriptEntry,
        options: { dynamicState: string; theme: object; width: number },
        renderEntry: () => readonly string[],
    ): readonly string[] {
        const cached = this.#entries.get(entry);
        if (cached !== undefined && matches(cached, entry, options)) return cached.lines;

        const lines = renderEntry();
        this.#entries.set(entry, {
            backgroundTerminalCompletion: entry.backgroundTerminalCompletion,
            backgroundTerminalInteraction: entry.backgroundTerminalInteraction,
            childText: entry.childText,
            detail: entry.detail,
            dynamicState: options.dynamicState,
            execCommand: entry.execCommand,
            exploration: entry.exploration,
            fileDiffs: entry.fileDiffs,
            lines,
            mcpToolCall: entry.mcpToolCall,
            noticeChildren: entry.noticeChildren,
            omittedFileDiffs: entry.omittedFileDiffs,
            toolPermission: entry.toolPermission,
            role: entry.role,
            text: entry.text,
            theme: options.theme,
            title: entry.title,
            turnElapsedMs: entry.turnElapsedMs,
            width: options.width,
        });
        return lines;
    }

    clear(): void {
        this.#entries = new WeakMap();
    }
}

function matches(
    cached: CachedEntryRender,
    entry: AppTranscriptEntry,
    options: { dynamicState: string; theme: object; width: number },
): boolean {
    return (
        cached.backgroundTerminalCompletion === entry.backgroundTerminalCompletion &&
        cached.backgroundTerminalInteraction === entry.backgroundTerminalInteraction &&
        cached.childText === entry.childText &&
        cached.detail === entry.detail &&
        cached.dynamicState === options.dynamicState &&
        cached.execCommand === entry.execCommand &&
        cached.exploration === entry.exploration &&
        cached.fileDiffs === entry.fileDiffs &&
        cached.mcpToolCall === entry.mcpToolCall &&
        cached.noticeChildren === entry.noticeChildren &&
        cached.omittedFileDiffs === entry.omittedFileDiffs &&
        cached.toolPermission === entry.toolPermission &&
        cached.role === entry.role &&
        cached.text === entry.text &&
        cached.theme === options.theme &&
        cached.title === entry.title &&
        cached.turnElapsedMs === entry.turnElapsedMs &&
        cached.width === options.width
    );
}
