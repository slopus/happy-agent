import { truncateToWidth } from "@earendil-works/pi-tui";

import type { CodexDiffPalette, CodexFileDiff } from "./CodexFileDiff.js";
import { CODEX_DARK_DIFF_PALETTE } from "./CodexFileDiff.js";
import { CODEX_DIFF_ANSI } from "./codexDiffAnsi.js";
import { detectCodexDiffLanguage } from "./detectCodexDiffLanguage.js";
import { layoutCodexFileDiff } from "./layoutCodexFileDiff.js";
import { renderCodexDiffLine } from "./renderCodexDiffLine.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

export interface RenderCodexFileDiffOptions {
    readonly maxRows?: number;
    readonly palette?: CodexDiffPalette;
    readonly width?: number;
}

export function renderCodexFileDiff(
    diff: CodexFileDiff,
    options: RenderCodexFileDiffOptions = {},
): string[] {
    const palette = options.palette ?? CODEX_DARK_DIFF_PALETTE;
    const width = Math.max(1, Math.floor(options.width ?? 10_000));
    const maxRows = Math.max(1, Math.floor(options.maxRows ?? 80));
    let added = 0;
    let deleted = 0;
    let lineCount = 0;
    let maxLineNumber = 1;
    for (const hunk of diff.hunks) {
        let oldLineNumber = hunk.oldStart;
        let newLineNumber = hunk.newStart;
        for (const line of hunk.lines) {
            lineCount += 1;
            if (line.kind === "delete") {
                deleted += 1;
                maxLineNumber = Math.max(maxLineNumber, oldLineNumber);
                oldLineNumber += 1;
                continue;
            }
            if (line.kind === "add") added += 1;
            maxLineNumber = Math.max(maxLineNumber, newLineNumber);
            newLineNumber += 1;
            if (line.kind === "context") oldLineNumber += 1;
        }
    }
    const exactAdded = nonnegativeInteger(diff.added, added);
    const exactDeleted = nonnegativeInteger(diff.deleted, deleted);
    const omittedLines = nonnegativeInteger(diff.omittedLines, 0);
    const verb = diff.kind === "add" ? "Added" : diff.kind === "delete" ? "Deleted" : "Edited";
    const safePath = sanitizeTerminalText(diff.path).replace(/\s+/gu, " ").trim();
    const header = fit(
        `${CODEX_DIFF_ANSI.dim}• ${CODEX_DIFF_ANSI.notBoldOrDim}${CODEX_DIFF_ANSI.bold}${verb}${CODEX_DIFF_ANSI.notBoldOrDim} ${safePath} (${CODEX_DIFF_ANSI.green}+${exactAdded}${CODEX_DIFF_ANSI.foregroundReset} ${CODEX_DIFF_ANSI.red}-${exactDeleted}${CODEX_DIFF_ANSI.foregroundReset})`,
        width,
    );
    if (width < 5) return [header];
    const lineNumberWidth = maxLineNumber.toString().length;
    const language = diff.language ?? detectCodexDiffLanguage(diff.path);
    const totalBodyRows = lineCount + Math.max(0, diff.hunks.length - 1) + omittedLines;
    const truncated = totalBodyRows > maxRows;
    const visibleRowBudget = truncated ? Math.max(0, maxRows - 1) : totalBodyRows;
    const body: string[] = [];

    const rows = layoutCodexFileDiff(diff);
    while (body.length < visibleRowBudget) {
        const next = rows.next();
        if (next.done) break;
        const row = next.value;
        if (row.type === "hunk_separator") {
            body.push(
                fit(
                    `    ${"".padStart(lineNumberWidth)} ${CODEX_DIFF_ANSI.dim}⋮${CODEX_DIFF_ANSI.notBoldOrDim}`,
                    width,
                ),
            );
            continue;
        }
        body.push(renderCodexDiffLine(row.line, lineNumberWidth, language, palette, width));
    }

    if (!truncated) return [header, ...body];
    const hidden = totalBodyRows - body.length;
    body.push(
        fit(
            `    ${"".padStart(lineNumberWidth)} ${CODEX_DIFF_ANSI.dim}… ${hidden} more line${hidden === 1 ? "" : "s"}${CODEX_DIFF_ANSI.notBoldOrDim}`,
            width,
        ),
    );
    return [header, ...body];
}

function fit(line: string, width: number): string {
    return `${truncateToWidth(line, width, "", false)}${CODEX_DIFF_ANSI.reset}`;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
    return value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.max(0, Math.floor(value));
}
