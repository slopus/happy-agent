import { describe, expect, it } from "vitest";

import { formatCodexMcpToolResult } from "./formatCodexMcpToolResult.js";

describe("formatCodexMcpToolResult", () => {
    it("preserves separate text blocks and describes image results", () => {
        expect(
            formatCodexMcpToolResult([
                { type: "text", text: "first" },
                { type: "text", text: "second\nline" },
                { type: "image", data: "base64", mediaType: "image/png" },
            ]),
        ).toEqual(["first", "second\nline", "Image result (image/png)."]);
    });

    it("handles empty and unavailable results", () => {
        expect(formatCodexMcpToolResult([{ type: "text", text: "" }])).toBe("(empty result)");
        expect(formatCodexMcpToolResult([])).toBe("(empty result)");
        expect(formatCodexMcpToolResult(undefined)).toBeUndefined();
    });

    it("bounds the number of result blocks retained for rendering", () => {
        const result = formatCodexMcpToolResult(
            Array.from({ length: 10_000 }, (_, index) => ({
                type: "text" as const,
                text: `result ${String(index)}`,
            })),
        );

        expect(result).toHaveLength(129);
        expect(result?.at(-1)).toBe("... [truncated]");
    });
});
