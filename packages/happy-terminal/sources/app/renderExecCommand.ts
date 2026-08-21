import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ExecCommandPresentation } from "../protocol/index.js";
import { highlightShellCommand } from "./highlightShellCommand.js";
import { renderChildRows, type ChildRow } from "./renderChildRows.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const NOT_BOLD = "\x1b[22m";
const DIM = "\x1b[2m";
const MAX_OUTPUT_ROWS = 4;
const MAX_OUTPUT_HEAD_LINES = 2;
const MAX_OUTPUT_HEAD_ROWS = 2;
const MAX_OUTPUT_TAIL_LINES = 1;
const MAX_OUTPUT_TAIL_ROWS = 1;
const MIN_OUTPUT_EDGE_CHARACTERS = 256;

interface OutputLineRange {
    readonly end: number;
    readonly start: number;
}

export function renderExecCommand(
    presentation: ExecCommandPresentation,
    options: {
        active?: boolean;
        brand: string;
        detail?: string;
        primary: string;
        review?: string;
        status: string;
        verb: string;
        width: number;
    },
): string[] {
    const width = Math.max(1, options.width);
    const headerPrefix = `${options.status}•${RESET} ${options.brand}${BOLD}${options.verb}${NOT_BOLD}${RESET} `;
    const continuationPrefix = " ".repeat(visibleWidth(headerPrefix));
    const command = sanitizeTerminalText(presentation.command).replaceAll("\t", "    ");
    const highlighted = highlightShellCommand(command.length === 0 ? "command" : command);
    const commandWidth = Math.max(1, width - visibleWidth(headerPrefix));
    const wrappedCommand = wrapTextWithAnsi(highlighted, commandWidth);
    const lines = wrappedCommand.map((line, index) =>
        truncateToWidth(
            `${index === 0 ? headerPrefix : continuationPrefix}${line}${options.primary}`,
            width,
            "",
            true,
        ),
    );

    const childRows: ChildRow[] = [];
    if (options.review !== undefined) {
        childRows.push({ prefix: DIM, suffix: RESET, text: options.review });
    }
    if (options.detail !== undefined) {
        childRows.push({ prefix: DIM, suffix: RESET, text: options.detail });
    }
    if (options.active !== true) {
        const outputLines = selectOutputLines(presentation.output, Math.max(1, width - 4));
        childRows.push(
            ...outputLines.map((output) => ({
                prefix: DIM,
                suffix: RESET,
                text: output,
                wrap: false,
            })),
        );
    }
    lines.push(
        ...renderChildRows(childRows, { afterMarker: `${RESET}${DIM}`, markerStyle: DIM, width }),
    );
    return lines;
}

function selectOutputLines(output: string, width: number): string[] {
    let end = output.length;
    while (end > 0 && (output[end - 1] === "\n" || output[end - 1] === "\r")) end -= 1;
    if (end === 0) return ["(no output)"];

    const { first, last, lineCount } = outputLineRanges(output, end);
    const edgeCharacterLimit = Math.max(
        MIN_OUTPUT_EDGE_CHARACTERS,
        width * (MAX_OUTPUT_HEAD_ROWS + MAX_OUTPUT_TAIL_ROWS),
    );

    if (lineCount <= MAX_OUTPUT_ROWS) {
        if (end <= edgeCharacterLimit * 2) {
            const rows = wrapOutputText(output.slice(0, end), width);
            if (rows.length <= MAX_OUTPUT_ROWS) return rows;
            return [
                ...rows.slice(0, MAX_OUTPUT_HEAD_ROWS),
                "… output truncated",
                ...rows.slice(-MAX_OUTPUT_TAIL_ROWS),
            ];
        }

        return [
            ...wrapOutputText(output.slice(0, edgeCharacterLimit), width).slice(
                0,
                MAX_OUTPUT_HEAD_ROWS,
            ),
            "… output truncated",
            ...wrapOutputText(output.slice(end - edgeCharacterLimit, end), width).slice(
                -MAX_OUTPUT_TAIL_ROWS,
            ),
        ];
    }

    const firstEnd = first.at(-1)?.end ?? 0;
    const lastStart = last[0]?.start ?? end;
    const headRows = wrapOutputText(output.slice(0, Math.min(firstEnd, edgeCharacterLimit)), width);
    const tailRows = wrapOutputText(
        output.slice(Math.max(lastStart, end - edgeCharacterLimit), end),
        width,
    );
    const previewTruncated =
        firstEnd > edgeCharacterLimit ||
        end - lastStart > edgeCharacterLimit ||
        headRows.length > MAX_OUTPUT_HEAD_ROWS ||
        tailRows.length > MAX_OUTPUT_TAIL_ROWS;
    const omitted = lineCount - MAX_OUTPUT_HEAD_LINES - MAX_OUTPUT_TAIL_LINES;
    return [
        ...headRows.slice(0, MAX_OUTPUT_HEAD_ROWS),
        `… +${omitted} lines${previewTruncated ? "; output truncated" : ""}`,
        ...tailRows.slice(-MAX_OUTPUT_TAIL_ROWS),
    ];
}

function outputLineRanges(
    output: string,
    end: number,
): {
    readonly first: readonly OutputLineRange[];
    readonly last: readonly OutputLineRange[];
    readonly lineCount: number;
} {
    const first: OutputLineRange[] = [];
    const last: OutputLineRange[] = [];
    let lineStart = 0;
    let lineCount = 0;

    for (let index = 0; index <= end; index += 1) {
        if (index !== end && output[index] !== "\n") continue;
        const range = { end: index, start: lineStart };
        if (first.length < MAX_OUTPUT_HEAD_LINES) first.push(range);
        last.push(range);
        if (last.length > MAX_OUTPUT_TAIL_LINES) last.shift();
        lineCount += 1;
        lineStart = index + 1;
    }

    return { first, last, lineCount };
}

function wrapOutputText(text: string, width: number): string[] {
    const sanitized = sanitizeTerminalText(text).replaceAll("\t", "    ");
    return sanitized.split("\n").flatMap((line) => {
        const wrapped = wrapTextWithAnsi(line, width);
        return wrapped.length === 0 ? [""] : wrapped;
    });
}
