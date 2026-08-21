import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type {
    CodexMcpToolCall,
    CodexMcpToolPalette,
    CodexMcpToolRenderOptions,
} from "./CodexMcpToolCall.js";
import { DEFAULT_CODEX_MCP_TOOL_PALETTE } from "./CodexMcpToolCall.js";
import { boundedJsonStringify } from "./boundedJsonStringify.js";
import { renderChildRows, type ChildRow } from "./renderChildRows.js";
import { sanitizeTerminalText } from "./sanitizeTerminalText.js";
import { truncateTextForDisplay } from "./truncateTextForDisplay.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NOT_BOLD_OR_DIM = "\x1b[22m";
const DEFAULT_MAX_REVIEW_ROWS = 3;
const DEFAULT_MAX_RESULT_ROWS = 4;
const MAXIMUM_ARGUMENT_BYTES = 4_096;
const MAXIMUM_INVOCATION_ROWS = 8;
const MAXIMUM_NAME_CHARACTERS = 128;
const MAXIMUM_RESULT_BLOCKS = 128;
const MINIMUM_WRAPPED_WIDTH = 20;

interface InvocationLayout {
    readonly argumentsEnd: number;
    readonly argumentsStart: number;
    readonly plain: string;
    readonly serverEnd: number;
    readonly toolEnd: number;
    readonly toolStart: number;
}

interface WrappedSegment {
    readonly start: number;
    readonly text: string;
}

interface TextToken {
    readonly end: number;
    readonly start: number;
    readonly text: string;
    readonly whitespace: boolean;
    readonly width: number;
}

export function renderCodexMcpToolCall(
    call: CodexMcpToolCall,
    options: CodexMcpToolRenderOptions,
): string[] {
    const width = Math.max(1, Math.floor(options.width));
    const maxReviewRows = Math.max(0, Math.floor(options.maxReviewRows ?? DEFAULT_MAX_REVIEW_ROWS));
    const maxResultRows = Math.max(0, Math.floor(options.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS));
    const palette = options.palette ?? DEFAULT_CODEX_MCP_TOOL_PALETTE;
    const invocation = invocationLayout(call, width);
    const header = renderHeader(call.status, palette);
    if (width < MINIMUM_WRAPPED_WIDTH) {
        return renderNarrowCall(call, invocation, header, palette, width, {
            maxReviewRows,
            maxResultRows,
        });
    }
    const inline = visibleWidth(invocation.plain) <= Math.max(0, width - visibleWidth(header) - 1);
    const lines: string[] = [];
    const childRows: ChildRow[] = [];

    if (inline) {
        lines.push(
            `${header} ${renderInvocationSegment(invocation, 0, invocation.plain, palette)}`,
        );
    } else {
        lines.push(header);
        const wrappedInvocation = wrapWithHangingIndent(
            invocation.plain,
            Math.max(1, width - 4),
            Math.max(1, width - 4),
        );
        childRows.push(
            ...wrappedInvocation.map((segment) => ({
                text: renderInvocationSegment(invocation, segment.start, segment.text, palette),
                wrap: false,
            })),
        );
    }

    const reviewLines = renderResultLines(call.review, Math.max(1, width - 4), maxReviewRows);
    childRows.push(
        ...reviewLines.map((reviewLine) => ({
            prefix: DIM,
            suffix: NOT_BOLD_OR_DIM,
            text: reviewLine,
            wrap: false,
        })),
    );

    const resultLines = renderResultLines(call.result, Math.max(1, width - 4), maxResultRows);
    childRows.push(
        ...resultLines.map((resultLine) => ({
            prefix: DIM,
            suffix: NOT_BOLD_OR_DIM,
            text: resultLine,
            wrap: false,
        })),
    );
    lines.push(
        ...renderChildRows(childRows, {
            afterMarker: NOT_BOLD_OR_DIM,
            markerStyle: DIM,
            pad: false,
            width,
        }),
    );

    return lines.map((line) => truncateToWidth(line, width, "", false));
}

function compactArguments(value: unknown, width: number): string {
    if (value === undefined) return "";
    const serialized = boundedJsonStringify(value, MAXIMUM_ARGUMENT_BYTES);
    const maximumCharacters = Math.max(64, width * MAXIMUM_INVOCATION_ROWS);
    return sanitizeTerminalText(truncateTextForDisplay(serialized, maximumCharacters).text);
}

function invocationLayout(call: CodexMcpToolCall, width: number): InvocationLayout {
    const server = sanitizeName(call.invocation.server);
    const tool = sanitizeName(call.invocation.tool);
    const argumentsText = compactArguments(call.invocation.arguments, width);
    const toolStart = server.length + 1;
    const toolEnd = toolStart + tool.length;
    const argumentsStart = toolEnd + 1;
    const argumentsEnd = argumentsStart + argumentsText.length;
    return {
        argumentsEnd,
        argumentsStart,
        plain: `${server}.${tool}(${argumentsText})`,
        serverEnd: server.length,
        toolEnd,
        toolStart,
    };
}

function renderHeader(status: CodexMcpToolCall["status"], palette: CodexMcpToolPalette): string {
    const label = status === "active" ? "Calling" : "Called";
    const bullet =
        status === "active"
            ? `${palette.primary}${DIM}◦${NOT_BOLD_OR_DIM}`
            : `${status === "error" ? palette.error : palette.success}${BOLD}•${NOT_BOLD_OR_DIM}${palette.primary}`;
    return `${bullet} ${BOLD}${label}${NOT_BOLD_OR_DIM}`;
}

function renderNarrowCall(
    call: CodexMcpToolCall,
    invocation: InvocationLayout,
    header: string,
    palette: CodexMcpToolPalette,
    width: number,
    limits: { readonly maxReviewRows: number; readonly maxResultRows: number },
): string[] {
    const lines = [header];
    if (width >= 5) {
        const contentWidth = Math.max(1, width - 4);
        const reviewLines = renderResultLines(call.review, contentWidth, limits.maxReviewRows);
        const resultLines = renderResultLines(call.result, contentWidth, limits.maxResultRows);
        lines.push(
            ...renderChildRows(
                [
                    {
                        text: renderInvocationSegment(invocation, 0, invocation.plain, palette),
                        wrap: false,
                    },
                    ...[...reviewLines, ...resultLines].map((line) => ({
                        prefix: DIM,
                        suffix: NOT_BOLD_OR_DIM,
                        text: line,
                        wrap: false,
                    })),
                ],
                { afterMarker: NOT_BOLD_OR_DIM, markerStyle: DIM, pad: false, width },
            ),
        );
    }
    return lines.map((line) => truncateToWidth(line, width, "", false));
}

function renderInvocationSegment(
    layout: InvocationLayout,
    start: number,
    text: string,
    palette: CodexMcpToolPalette,
): string {
    const end = start + text.length;
    const boundaries = [
        start,
        end,
        layout.serverEnd,
        layout.toolStart,
        layout.toolEnd,
        layout.argumentsStart,
        layout.argumentsEnd,
    ]
        .filter((boundary) => boundary >= start && boundary <= end)
        .sort((left, right) => left - right)
        .filter((boundary, index, values) => index === 0 || boundary !== values[index - 1]);
    let rendered = "";

    for (let index = 0; index < boundaries.length - 1; index += 1) {
        const rangeStart = boundaries[index] ?? start;
        const rangeEnd = boundaries[index + 1] ?? end;
        if (rangeEnd <= rangeStart) continue;
        const value = layout.plain.slice(rangeStart, rangeEnd);
        if (
            (rangeStart >= 0 && rangeEnd <= layout.serverEnd) ||
            (rangeStart >= layout.toolStart && rangeEnd <= layout.toolEnd)
        ) {
            rendered += `${palette.accent}${value}${palette.primary}`;
        } else if (rangeStart >= layout.argumentsStart && rangeEnd <= layout.argumentsEnd) {
            rendered += `${DIM}${value}${NOT_BOLD_OR_DIM}`;
        } else {
            rendered += value;
        }
    }

    return rendered;
}

function renderResultLines(
    result: CodexMcpToolCall["result"],
    width: number,
    maxRows: number,
): string[] {
    if (result === undefined || maxRows === 0) return [];
    const blocks = typeof result === "string" ? [result] : result;
    const maximumCharacters = Math.max(64, width * maxRows * 2);
    const wrapped: string[] = [];
    let consumedCharacters = 0;
    let preWrapTruncated = false;
    for (let index = 0; index < blocks.length; index += 1) {
        if (index >= MAXIMUM_RESULT_BLOCKS) {
            preWrapTruncated = true;
            break;
        }
        const remainingCharacters = Math.max(0, maximumCharacters - consumedCharacters);
        if (remainingCharacters === 0) {
            preWrapTruncated = true;
            break;
        }
        const bounded = truncateTextForDisplay(blocks[index] ?? "", remainingCharacters);
        consumedCharacters += bounded.text.length;
        preWrapTruncated ||= bounded.truncated;
        wrapped.push(
            ...wrapTextWithAnsi(sanitizeTerminalText(bounded.text).replaceAll("\t", "    "), width),
        );
        if (wrapped.length > maxRows) {
            break;
        }
    }
    if (wrapped.length <= maxRows && !preWrapTruncated) return wrapped;

    const visible = wrapped.slice(0, maxRows);
    if (visible.length === 0) return [];
    const lastIndex = visible.length - 1;
    const fullEllipsis = preWrapTruncated ? "... [truncated]" : "...";
    const ellipsis =
        width >= visibleWidth(fullEllipsis) ? fullEllipsis : ".".repeat(Math.min(3, width));
    visible[lastIndex] = `${truncateToWidth(
        visible[lastIndex] ?? "",
        Math.max(0, width - visibleWidth(ellipsis)),
        "",
    )}${ellipsis}`;
    return visible;
}

function sanitizeName(value: string): string {
    return sanitizeTerminalText(
        truncateTextForDisplay(value, MAXIMUM_NAME_CHARACTERS).text,
    ).replace(/\s+/gu, "_");
}

function wrapWithHangingIndent(
    text: string,
    firstWidth: number,
    continuationWidth: number,
): WrappedSegment[] {
    const tokens = tokenize(text);
    const lines: WrappedSegment[] = [];
    let capacity = firstWidth;
    let lineStart: number | undefined;
    let lineEnd = 0;
    let lineWidth = 0;
    let pendingWhitespace: TextToken | undefined;

    const flush = () => {
        if (lineStart === undefined) return;
        lines.push({ start: lineStart, text: text.slice(lineStart, lineEnd) });
        lineStart = undefined;
        lineEnd = 0;
        lineWidth = 0;
        pendingWhitespace = undefined;
        capacity = continuationWidth;
    };

    for (const token of tokens) {
        if (token.whitespace) {
            if (lineStart !== undefined) pendingWhitespace = token;
            continue;
        }

        const whitespaceWidth = pendingWhitespace?.width ?? 0;
        if (lineStart !== undefined && lineWidth + whitespaceWidth + token.width > capacity) {
            flush();
        }

        if (token.width <= capacity) {
            if (lineStart === undefined) lineStart = token.start;
            lineEnd = token.end;
            lineWidth += (lineWidth === 0 ? 0 : (pendingWhitespace?.width ?? 0)) + token.width;
            pendingWhitespace = undefined;
            continue;
        }

        const graphemes = [
            ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token.text),
        ];
        for (const grapheme of graphemes) {
            const graphemeWidth = visibleWidth(grapheme.segment);
            if (lineStart !== undefined && lineWidth + graphemeWidth > capacity) flush();
            if (lineStart === undefined) lineStart = token.start + grapheme.index;
            lineEnd = token.start + grapheme.index + grapheme.segment.length;
            lineWidth += graphemeWidth;
        }
        pendingWhitespace = undefined;
    }

    flush();
    return lines.length > 0 ? lines : [{ start: 0, text: "" }];
}

function tokenize(text: string): TextToken[] {
    const tokens: TextToken[] = [];
    for (const match of text.matchAll(/\s+|\S+/gu)) {
        const value = match[0];
        const start = match.index;
        tokens.push({
            start,
            end: start + value.length,
            text: value,
            whitespace: /^\s+$/u.test(value),
            width: visibleWidth(value),
        });
    }
    return tokens;
}
