import type { CodexFileDiff, CodexFileDiffLineKind } from "./CodexFileDiff.js";

export interface LaidOutCodexDiffLine {
    kind: CodexFileDiffLineKind;
    lineNumber: number;
    text: string;
}

export type LaidOutCodexDiffRow =
    | { readonly type: "hunk_separator" }
    | { readonly line: LaidOutCodexDiffLine; readonly type: "line" };

export function* layoutCodexFileDiff(diff: CodexFileDiff): Generator<LaidOutCodexDiffRow> {
    for (const [hunkIndex, hunk] of diff.hunks.entries()) {
        if (hunkIndex > 0) yield { type: "hunk_separator" };
        let oldLineNumber = hunk.oldStart;
        let newLineNumber = hunk.newStart;

        for (const line of hunk.lines) {
            if (line.kind === "delete") {
                const laidOut = {
                    kind: line.kind,
                    lineNumber: oldLineNumber,
                    text: line.text,
                };
                oldLineNumber += 1;
                yield { line: laidOut, type: "line" };
                continue;
            }

            const laidOut = {
                kind: line.kind,
                lineNumber: newLineNumber,
                text: line.text,
            };
            newLineNumber += 1;
            if (line.kind === "context") oldLineNumber += 1;
            yield { line: laidOut, type: "line" };
        }
    }
}
