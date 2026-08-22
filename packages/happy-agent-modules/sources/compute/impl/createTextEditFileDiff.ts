import type { ComputeFileDiff } from "../ComputeToolPresentation.js";
import { MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES } from "../ComputeToolPresentation.js";
import { BoundedFileDiffCollector, truncateFileDiffText } from "./BoundedFileDiffCollector.js";
import { iterateDiffContentLines } from "./iterateDiffContentLines.js";

export interface ComputeTextReplacement {
    readonly start: number;
    readonly oldText: string;
    readonly newText: string;
}

/** Build exact delete/add hunks for replacements whose offsets refer to the original content. */
export function createTextEditFileDiff(
    path: string,
    content: string,
    replacements: readonly ComputeTextReplacement[],
): ComputeFileDiff {
    let added = 0;
    let deleted = 0;
    let omittedLines = 0;
    let priorLineDelta = 0;
    let retainedLines = 0;
    let scannedOffset = 0;
    let oldStart = 1;
    const hunks: ComputeFileDiff["hunks"][number][] = [];

    for (const replacement of replacements) {
        const oldLines = splitReplacementLines(replacement.oldText);
        const newLines = splitReplacementLines(replacement.newText);
        added += newLines.length;
        deleted += oldLines.length;
        oldStart += countLineEndings(content, scannedOffset, replacement.start);
        scannedOffset = replacement.start;

        const lines: ComputeFileDiff["hunks"][number]["lines"][number][] = [];
        for (const [kind, texts] of [
            ["delete", oldLines],
            ["add", newLines],
        ] as const) {
            for (const text of texts) {
                if (retainedLines < MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES) {
                    lines.push({ kind, text: truncateFileDiffText(text) });
                    retainedLines += 1;
                } else {
                    omittedLines += 1;
                }
            }
        }
        if (lines.length > 0) {
            hunks.push({ lines, newStart: oldStart + priorLineDelta, oldStart });
        }
        priorLineDelta += newLines.length - oldLines.length;
    }

    return {
        path: truncateFileDiffText(path),
        kind: "update",
        added,
        deleted,
        hunks,
        ...(omittedLines === 0 ? {} : { omittedLines }),
    };
}

/** Build either a whole-file add or a full rewrite diff. */
export function createWholeFileDiff(
    path: string,
    previousContent: string | undefined,
    nextContent: string,
): ComputeFileDiff {
    if (previousContent !== undefined) {
        return createTextEditFileDiff(path, previousContent, [
            { start: 0, oldText: previousContent, newText: nextContent },
        ]);
    }

    const collector = new BoundedFileDiffCollector();
    collector.addWholeFile(path, "add", iterateDiffContentLines(nextContent));
    const diff = collector.finish().files[0];
    if (diff === undefined) {
        return { path: truncateFileDiffText(path), kind: "add", added: 0, deleted: 0, hunks: [] };
    }
    return diff;
}

function splitReplacementLines(text: string): string[] {
    if (text.length === 0) return [];
    const normalized = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    const lines = normalized.split("\n");
    if (lines.at(-1) === "" && normalized.endsWith("\n")) lines.pop();
    return lines;
}

function countLineEndings(content: string, start: number, end: number): number {
    let count = 0;
    for (let index = start; index < end; index += 1) {
        if (content[index] === "\r" && content[index + 1] === "\n") index += 1;
        if (content[index] === "\r" || content[index] === "\n") count += 1;
    }
    return count;
}
