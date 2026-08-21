import { truncateToWidth } from "@earendil-works/pi-tui";

import type { CodexDiffPalette } from "./CodexFileDiff.js";
import { CODEX_DIFF_ANSI, codexDiffBackground } from "./codexDiffAnsi.js";
import { highlightCodexDiffLine } from "./highlightCodexDiffLine.js";
import type { LaidOutCodexDiffLine } from "./layoutCodexFileDiff.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

export function renderCodexDiffLine(
    line: LaidOutCodexDiffLine,
    lineNumberWidth: number,
    language: string | undefined,
    palette: CodexDiffPalette,
    width: number,
): string {
    const gutter = `${line.lineNumber.toString().padStart(lineNumberWidth)} `;
    const safeText = sanitizeTerminalText(line.text)
        .replace(/[\n\u2028\u2029]/gu, " ")
        .replaceAll("\t", "    ");
    const renderedContent = highlightCodexDiffLine(safeText, language, palette);
    const prefix = `    ${CODEX_DIFF_ANSI.dim}${gutter}${CODEX_DIFF_ANSI.notBoldOrDim}`;

    if (line.kind === "context") {
        return fit(`${prefix} ${renderedContent}${CODEX_DIFF_ANSI.reset}`, width);
    }

    const added = line.kind === "add";
    const background = codexDiffBackground(
        added ? palette.addedBackground : palette.deletedBackground,
    );
    const signColor = added ? CODEX_DIFF_ANSI.green : CODEX_DIFF_ANSI.red;
    const content = added
        ? renderedContent
        : `${CODEX_DIFF_ANSI.dim}${renderedContent}${CODEX_DIFF_ANSI.notBoldOrDim}`;

    return fit(
        `${background}${prefix}${signColor}${added ? "+" : "-"}${CODEX_DIFF_ANSI.foregroundReset}${content}${CODEX_DIFF_ANSI.reset}`,
        width,
    );
}

function fit(line: string, width: number): string {
    return `${truncateToWidth(line, Math.max(1, width), "", false)}${CODEX_DIFF_ANSI.reset}`;
}
