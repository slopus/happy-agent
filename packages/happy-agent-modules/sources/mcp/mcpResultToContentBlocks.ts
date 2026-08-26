import type { SessionOutputBlock } from "@slopus/happy-providers";

import {
    MAX_MCP_IMAGE_BASE64_BYTES,
    MAX_MCP_JSON_DEPTH,
    MAX_MCP_TEXT_BYTES,
    type McpToolResult,
} from "./Mcp.js";

const MAXIMUM_RESULT_BLOCKS = 128;
const MAXIMUM_IMAGE_BLOCKS = 4;
const TRUNCATION_MARKER = "... [truncated]";

interface ResultBudget {
    imageBlocks: number;
    remainingTextBytes: number;
}

/**
 * Turn one untrusted MCP result into the provider-neutral output blocks the model actually sees.
 *
 * Traversal is deliberately bounded before serialization: a server can return a huge/proxied
 * content array or cyclic structured data, and formatting must remain finite in either case.
 */
export function mcpResultToContentBlocks(
    result: McpToolResult | unknown,
): readonly SessionOutputBlock[] {
    if (!isRecord(result)) {
        return [
            {
                type: "text",
                text: truncateUtf8BytesForDisplay(safeString(result), MAX_MCP_TEXT_BYTES),
            },
        ];
    }

    const blocks: SessionOutputBlock[] = [];
    const budget: ResultBudget = {
        imageBlocks: 0,
        remainingTextBytes: MAX_MCP_TEXT_BYTES,
    };

    let content: unknown;
    try {
        content = result.content;
    } catch {
        content = undefined;
    }
    if (Array.isArray(content)) {
        let contentLength = 0;
        try {
            contentLength = content.length;
        } catch {
            contentLength = 0;
        }
        let index = 0;
        for (; index < contentLength && blocks.length < MAXIMUM_RESULT_BLOCKS; index += 1) {
            let candidates: SessionOutputBlock[] = [];
            try {
                candidates = contentToBlocks(content[index]);
            } catch {
                candidates = [];
            }
            for (const candidate of candidates) {
                appendWithinBudget(blocks, candidate, budget);
                if (blocks.length >= MAXIMUM_RESULT_BLOCKS) break;
            }
            if (budget.remainingTextBytes === 0) break;
        }
        if (index < contentLength) appendTruncationMarker(blocks, budget);
    }

    if (blocks.length > 0) return blocks;
    let structuredContent: unknown;
    try {
        structuredContent = result.structuredContent;
    } catch {
        structuredContent = undefined;
    }
    if (structuredContent !== undefined) {
        return [
            {
                type: "text",
                text: boundedMcpJsonStringify(structuredContent, MAX_MCP_TEXT_BYTES),
            },
        ];
    }
    return [{ type: "text", text: "(empty result)" }];
}

/**
 * Say that content was left out, without the notice itself pushing the result past its maximum.
 *
 * The declared block count is a ceiling on what the model receives, so a full result gives up its
 * last block to make room for the marker rather than growing by one more.
 */
function appendTruncationMarker(blocks: SessionOutputBlock[], budget: ResultBudget): void {
    if (budget.remainingTextBytes === 0) return;
    if (blocks.length >= MAXIMUM_RESULT_BLOCKS) {
        const displaced = blocks.pop();
        if (displaced?.type === "image") budget.imageBlocks -= 1;
    }
    appendWithinBudget(blocks, { type: "text", text: TRUNCATION_MARKER }, budget);
}

function appendWithinBudget(
    blocks: SessionOutputBlock[],
    block: SessionOutputBlock,
    budget: ResultBudget,
): void {
    if (block.type === "text") {
        if (budget.remainingTextBytes === 0) return;
        const text = truncateUtf8BytesForDisplay(block.text, budget.remainingTextBytes);
        if (text.length === 0) return;
        blocks.push({ type: "text", text });
        budget.remainingTextBytes -= Buffer.byteLength(text);
        return;
    }

    if (Buffer.byteLength(block.data) > MAX_MCP_IMAGE_BASE64_BYTES) {
        appendWithinBudget(
            blocks,
            {
                type: "text",
                text: "The MCP tool returned an image that exceeded the size limit.",
            },
            budget,
        );
        return;
    }
    if (budget.imageBlocks >= MAXIMUM_IMAGE_BLOCKS) {
        appendWithinBudget(
            blocks,
            { type: "text", text: "Additional MCP images were truncated." },
            budget,
        );
        return;
    }
    blocks.push(block);
    budget.imageBlocks += 1;
}

function contentToBlocks(content: unknown): SessionOutputBlock[] {
    if (!isRecord(content) || typeof content.type !== "string") return [];
    if (content.type === "text" && typeof content.text === "string") {
        return [{ type: "text", text: content.text }];
    }
    if (
        content.type === "image" &&
        typeof content.data === "string" &&
        typeof content.mimeType === "string"
    ) {
        return [{ type: "image", data: content.data, mimeType: content.mimeType }];
    }
    if (content.type === "resource" && isRecord(content.resource)) {
        if (typeof content.resource.text === "string") {
            return [{ type: "text", text: content.resource.text }];
        }
        return [
            {
                type: "text",
                text: `MCP resource: ${
                    typeof content.resource.uri === "string"
                        ? content.resource.uri
                        : "embedded content"
                }`,
            },
        ];
    }
    if (content.type === "resource_link") {
        return [
            {
                type: "text",
                text: `MCP resource: ${
                    typeof content.uri === "string" ? content.uri : "linked content"
                }`,
            },
        ];
    }
    if (content.type === "audio") {
        return [{ type: "text", text: "The MCP tool returned audio content." }];
    }
    return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown): string {
    try {
        return String(value);
    } catch {
        return "[unavailable]";
    }
}

const MAXIMUM_JSON_NODES = 128;
const TRUNCATED_JSON_VALUE = "... [truncated]";

interface PreviewState {
    remainingCharacters: number;
    remainingNodes: number;
    readonly seen: WeakSet<object>;
}

export function boundedMcpJsonStringify(value: unknown, maximumBytes: number): string {
    if (value === undefined) return "";
    const limit = Math.max(0, Math.floor(maximumBytes));
    const state: PreviewState = {
        remainingCharacters: limit,
        remainingNodes: MAXIMUM_JSON_NODES,
        seen: new WeakSet(),
    };
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(preview(value, state, 0));
    } catch {
        serialized = JSON.stringify(safeString(value).slice(0, state.remainingCharacters));
    }
    return truncateUtf8BytesForDisplay(serialized ?? "", limit);
}

function preview(value: unknown, state: PreviewState, depth: number): unknown {
    if (state.remainingNodes <= 0) return TRUNCATED_JSON_VALUE;
    state.remainingNodes -= 1;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "bigint") return safeString(value);
    if (typeof value === "string") {
        const bounded = value.slice(0, state.remainingCharacters);
        state.remainingCharacters = Math.max(0, state.remainingCharacters - bounded.length);
        return bounded;
    }
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
        return undefined;
    }
    if (depth >= MAX_MCP_JSON_DEPTH) return TRUNCATED_JSON_VALUE;
    if (state.seen.has(value)) return "[Circular]";

    state.seen.add(value);
    try {
        if (Array.isArray(value)) return previewArray(value, state, depth);
        if (value instanceof Date) return value.toJSON();
        if (ArrayBuffer.isView(value)) {
            return `[${value.constructor.name} with ${String(value.byteLength)} bytes]`;
        }
        return previewObject(value, state, depth);
    } finally {
        state.seen.delete(value);
    }
}

function previewArray(value: readonly unknown[], state: PreviewState, depth: number): unknown[] {
    const result: unknown[] = [];
    let index = 0;
    for (; index < value.length; index += 1) {
        if (state.remainingCharacters <= 0 || state.remainingNodes <= 0) break;
        try {
            result.push(preview(value[index], state, depth + 1));
        } catch {
            result.push("[unavailable]");
        }
    }
    if (index < value.length) result.push(TRUNCATED_JSON_VALUE);
    return result;
}

function previewObject(value: object, state: PreviewState, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let stopped = false;
    try {
        for (const sourceKey in value) {
            if (!Object.hasOwn(value, sourceKey)) continue;
            if (state.remainingCharacters <= 0 || state.remainingNodes <= 0) {
                stopped = true;
                break;
            }
            const key = sourceKey.slice(0, state.remainingCharacters);
            state.remainingCharacters = Math.max(0, state.remainingCharacters - key.length);
            try {
                result[key] = preview(
                    (value as Record<string, unknown>)[sourceKey],
                    state,
                    depth + 1,
                );
            } catch {
                result[key] = "[unavailable]";
            }
        }
    } catch {
        stopped = true;
    }
    if (stopped) result[TRUNCATED_JSON_VALUE] = TRUNCATED_JSON_VALUE;
    return result;
}

function truncateUtf8BytesForDisplay(value: string, maximumBytes: number): string {
    const limit = Math.max(0, Math.floor(maximumBytes));
    if (Buffer.byteLength(value) <= limit) return value;
    if (limit === 0) return "";
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
    if (limit <= markerBytes) return TRUNCATION_MARKER.slice(0, limit);

    const prefixBytes = limit - markerBytes;
    let low = 0;
    let high = Math.min(value.length, prefixBytes);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle)) <= prefixBytes) low = middle;
        else high = middle - 1;
    }
    let prefix = value.slice(0, low);
    const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
    return `${prefix}${TRUNCATION_MARKER}`;
}
