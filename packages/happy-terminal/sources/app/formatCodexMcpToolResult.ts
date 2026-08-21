import type { ContentBlock } from "../protocol/index.js";
import type { CodexMcpToolCall } from "./CodexMcpToolCall.js";

const MAXIMUM_RESULT_BLOCKS = 128;

export function formatCodexMcpToolResult(
    blocks: readonly ContentBlock[] | undefined,
): CodexMcpToolCall["result"] {
    if (blocks === undefined) return undefined;
    const results: string[] = [];
    for (let index = 0; index < blocks.length && index < MAXIMUM_RESULT_BLOCKS; index += 1) {
        const block = blocks[index];
        if (block === undefined) continue;
        results.push(
            block.type === "text"
                ? block.text.length === 0
                    ? "(empty result)"
                    : block.text
                : `Image result (${block.mediaType}).`,
        );
    }
    if (blocks.length > MAXIMUM_RESULT_BLOCKS) results.push("... [truncated]");
    if (results.length === 0) return "(empty result)";
    return results.length === 1 ? results[0] : results;
}
