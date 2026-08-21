import { truncateTextForDisplay } from "./truncateTextForDisplay.js";
import { truncateUtf8BytesForDisplay } from "./truncateUtf8BytesForDisplay.js";

const MAXIMUM_DEPTH = 8;
const MAXIMUM_NODES = 128;
const TRUNCATED_VALUE = "... [truncated]";

interface PreviewState {
    remainingCharacters: number;
    remainingNodes: number;
    readonly seen: WeakSet<object>;
}

export function boundedJsonStringify(value: unknown, maximumBytes: number): string {
    if (value === undefined) return "";
    const limit = Math.max(0, Math.floor(maximumBytes));
    const state: PreviewState = {
        remainingCharacters: limit,
        remainingNodes: MAXIMUM_NODES,
        seen: new WeakSet(),
    };
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(preview(value, state, 0));
    } catch {
        serialized = JSON.stringify(
            truncateTextForDisplay(String(value), state.remainingCharacters).text,
        );
    }
    return truncateUtf8BytesForDisplay(serialized ?? "", limit);
}

function preview(value: unknown, state: PreviewState, depth: number): unknown {
    if (state.remainingNodes <= 0) return TRUNCATED_VALUE;
    state.remainingNodes -= 1;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "bigint") return String(value);
    if (typeof value === "string") {
        const bounded = truncateTextForDisplay(value, state.remainingCharacters);
        state.remainingCharacters = Math.max(0, state.remainingCharacters - bounded.text.length);
        return bounded.text;
    }
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
        return undefined;
    }
    if (depth >= MAXIMUM_DEPTH) return TRUNCATED_VALUE;
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
        result.push(preview(value[index], state, depth + 1));
    }
    if (index < value.length) result.push(TRUNCATED_VALUE);
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
            const key = truncateTextForDisplay(sourceKey, state.remainingCharacters).text;
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
    if (stopped) result[TRUNCATED_VALUE] = TRUNCATED_VALUE;
    return result;
}
