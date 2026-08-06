import { describe, expect, it } from "vitest";

import { createClaudeWebSearchTool } from "../../agent/tools/claude/WebSearch.js";
import { createGeminiSearchTool } from "./createGeminiSearchTool.js";
import type { WebSearchOutput } from "../claude/webSearch/types.js";

const output: WebSearchOutput = {
    durationSeconds: 1.5,
    query: "Node.js current stable version",
    results: [
        "Node 24 is the current release.",
        {
            content: [
                {
                    title: "Previous releases",
                    url: "https://nodejs.org/en/about/previous-releases",
                },
                { title: "Node.js", url: "https://nodejs.org/en" },
            ],
            tool_use_id: "srvtoolu_1",
        },
        {
            // The provider repeating a page must not make it look like two.
            content: [{ title: "Node.js", url: "https://nodejs.org/en" }],
            tool_use_id: "srvtoolu_2",
        },
    ],
};

/**
 * Rig executes these two searches itself, and that is deliberately left alone. What converges is
 * what a reader is shown: the same value a search the provider ran produces.
 */
describe("a search Rig runs itself", () => {
    const tools = [
        ["WebSearch", createClaudeWebSearchTool()],
        ["gemini_search", createGeminiSearchTool("test-key")],
    ] as const;

    for (const [name, tool] of tools) {
        it(`announces ${name} as a search before it has consulted anything`, () => {
            expect(
                tool.toCallPresentation?.(
                    { query: "Node.js current stable version" } as never,
                    {} as never,
                ),
            ).toEqual({
                query: "Node.js current stable version",
                target: "web",
                type: "search",
            });
        });

        it(`reports what ${name} consulted, in order and without repeats`, () => {
            expect(tool.toPresentation?.(output as never, { query: "asked for" } as never)).toEqual(
                {
                    query: "Node.js current stable version",
                    // The model's own prose is not a page anyone can follow, so it is not a source.
                    sources: [
                        {
                            title: "Previous releases",
                            url: "https://nodejs.org/en/about/previous-releases",
                        },
                        { title: "Node.js", url: "https://nodejs.org/en" },
                    ],
                    target: "web",
                    type: "search",
                },
            );
        });
    }

    it("falls back to what was asked for when the provider reports no query", () => {
        const tool = createGeminiSearchTool("test-key");
        expect(
            tool.toPresentation?.(
                { ...output, query: "", results: [] } as never,
                { query: "asked for" } as never,
            ),
        ).toEqual({ query: "asked for", sources: [], target: "web", type: "search" });
    });
});
