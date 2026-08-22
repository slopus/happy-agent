import type {
    ComputeFileDiff,
    ComputeFileDiffLine,
    ComputeFileDiffPresentation,
} from "../ComputeToolPresentation.js";
import {
    MAX_COMPUTE_FILE_DIFF_PRESENTATION_FILES,
    MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES,
    MAX_COMPUTE_FILE_DIFF_PRESENTATION_TEXT_CHARACTERS,
} from "../ComputeToolPresentation.js";

type UnboundedFileDiff = Pick<ComputeFileDiff, "hunks" | "kind" | "language" | "path">;

/** Collect several file changes under the stable public file-diff payload bounds. */
export class BoundedFileDiffCollector {
    readonly #files: ComputeFileDiff[] = [];
    #omittedFiles = 0;
    #retainedLines = 0;

    add(diff: UnboundedFileDiff): void {
        if (!this.#canRetainFile()) return;

        let added = 0;
        let deleted = 0;
        let omittedLines = 0;
        const hunks: ComputeFileDiff["hunks"][number][] = [];
        for (const hunk of diff.hunks) {
            const lines: ComputeFileDiffLine[] = [];
            for (const line of hunk.lines) {
                if (line.kind === "add") added += 1;
                if (line.kind === "delete") deleted += 1;
                if (this.#retainedLines < MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES) {
                    lines.push({ kind: line.kind, text: truncateFileDiffText(line.text) });
                    this.#retainedLines += 1;
                } else {
                    omittedLines += 1;
                }
            }
            if (lines.length > 0) {
                hunks.push({ lines, newStart: hunk.newStart, oldStart: hunk.oldStart });
            }
        }

        this.#files.push({
            path: truncateFileDiffText(diff.path),
            kind: diff.kind,
            added,
            deleted,
            hunks,
            ...(diff.language === undefined ? {} : { language: diff.language }),
            ...(omittedLines === 0 ? {} : { omittedLines }),
        });
    }

    addWholeFile(
        path: string,
        kind: Extract<ComputeFileDiff["kind"], "add" | "delete">,
        contentLines: Iterable<string>,
    ): void {
        if (!this.#canRetainFile()) return;

        let lineCount = 0;
        let omittedLines = 0;
        const lines: ComputeFileDiffLine[] = [];
        for (const text of contentLines) {
            lineCount += 1;
            if (this.#retainedLines < MAX_COMPUTE_FILE_DIFF_PRESENTATION_LINES) {
                lines.push({ kind, text: truncateFileDiffText(text) });
                this.#retainedLines += 1;
            } else {
                omittedLines += 1;
            }
        }

        this.#files.push({
            path: truncateFileDiffText(path),
            kind,
            added: kind === "add" ? lineCount : 0,
            deleted: kind === "delete" ? lineCount : 0,
            hunks: [
                {
                    lines,
                    newStart: kind === "add" ? 1 : 0,
                    oldStart: kind === "delete" ? 1 : 0,
                },
            ],
            ...(omittedLines === 0 ? {} : { omittedLines }),
        });
    }

    finish(): ComputeFileDiffPresentation {
        return {
            type: "file_diff",
            files: this.#files,
            ...(this.#omittedFiles === 0 ? {} : { omittedFiles: this.#omittedFiles }),
        };
    }

    #canRetainFile(): boolean {
        if (this.#files.length < MAX_COMPUTE_FILE_DIFF_PRESENTATION_FILES) return true;
        this.#omittedFiles += 1;
        return false;
    }
}

/** Truncate by Unicode code points without leaving half of a surrogate pair. */
export function truncateFileDiffText(text: string): string {
    let characterCount = 0;
    let end = 0;
    for (const character of text) {
        if (characterCount === MAX_COMPUTE_FILE_DIFF_PRESENTATION_TEXT_CHARACTERS) break;
        characterCount += 1;
        end += character.length;
    }
    return end === text.length ? text : text.slice(0, end);
}
