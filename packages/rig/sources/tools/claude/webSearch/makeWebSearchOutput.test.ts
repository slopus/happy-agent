import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { describe, expect, it } from "vitest";

import { blocksContainSearch, makeWebSearchOutput } from "./makeWebSearchOutput.js";

describe("makeWebSearchOutput", () => {
    it("collects result links and surrounding model text", () => {
        const blocks = [
            { type: "text", text: "Searching now." },
            { type: "server_tool_use", id: "server-1", name: "web_search", input: {} },
            {
                type: "web_search_tool_result",
                tool_use_id: "server-1",
                content: [
                    {
                        type: "web_search_result",
                        title: "Example",
                        url: "https://example.com",
                        encrypted_content: "encrypted",
                        page_age: null,
                    },
                ],
            },
            { type: "text", text: "The result is current." },
        ] as BetaContentBlock[];

        expect(makeWebSearchOutput(blocks, "example", 1.25)).toEqual({
            query: "example",
            results: [
                "Searching now.",
                {
                    tool_use_id: "server-1",
                    content: [{ title: "Example", url: "https://example.com" }],
                },
                "The result is current.",
            ],
            durationSeconds: 1.25,
        });
    });

    it("preserves server-side search errors for the caller", () => {
        const blocks = [
            {
                type: "web_search_tool_result",
                tool_use_id: "server-1",
                content: { type: "web_search_tool_result_error", error_code: "unavailable" },
            },
        ] as BetaContentBlock[];

        expect(makeWebSearchOutput(blocks, "example", 0).results).toEqual([
            "Web search error: unavailable",
        ]);
    });
});

/**
 * The shapes a live Claude Agent SDK helper actually returns, captured from a real run.
 *
 * The SDK runs `WebSearch` itself, so nothing in the reply is a `server_tool_use` or a
 * `web_search_tool_result`. Reading only those found no search in a reply that plainly contained
 * one, which reported every search as never having happened once that became an error.
 */
describe("a search the Agent SDK ran", () => {
    const blocks = [
        { type: "text", text: "I'll search for that." },
        {
            type: "tool_use",
            id: "toolu_01N7mPz9Sj4bb5C7zvCtEcg6",
            name: "WebSearch",
            input: { query: "latest Deno release version 2026" },
        },
        {
            type: "tool_result",
            tool_use_id: "toolu_01N7mPz9Sj4bb5C7zvCtEcg6",
            content:
                'Web search results for query: "latest Deno release version 2026"\n\nLinks: [{"title":"Deno 2.8 | Deno","url":"https://deno.com/blog/v2.8"},{"title":"Blog | Deno","url":"https://deno.com/blog"}]\n\nSome trailing prose.',
        },
        { type: "text", text: "The latest Deno release is 2.9.4." },
    ] as never;

    it("counts as a search", () => {
        expect(blocksContainSearch(blocks)).toBe(true);
    });

    // The pages are the point: a reader judges a search by where it looked, and the helper's prose
    // is not something an interface can take that from.
    it("reports the pages it consulted", () => {
        expect(makeWebSearchOutput(blocks, "deno", 0).results).toEqual([
            "I'll search for that.",
            {
                tool_use_id: "toolu_01N7mPz9Sj4bb5C7zvCtEcg6",
                content: [
                    { title: "Deno 2.8 | Deno", url: "https://deno.com/blog/v2.8" },
                    { title: "Blog | Deno", url: "https://deno.com/blog" },
                ],
            },
            "The latest Deno release is 2.9.4.",
        ]);
    });

    /**
     * A title is prose, and prose contains brackets. Ending the array at the first `]` cut the
     * JSON mid-string, the parse failed, the failure was swallowed, and the whole search came back
     * as a success that consulted nothing — losing every result, not just the bracketed one.
     */
    it("keeps every page when a title contains a bracket", () => {
        const bracketed = [
            {
                type: "tool_use",
                id: "toolu_bracket",
                name: "WebSearch",
                input: { query: "rfc 9000" },
            },
            {
                type: "tool_result",
                tool_use_id: "toolu_bracket",
                content:
                    'Links: [{"title":"[PDF] RFC 9000","url":"https://example.com/rfc"},{"title":"Other","url":"https://other"}]',
            },
        ] as never;
        expect(makeWebSearchOutput(bracketed, "rfc 9000", 0).results).toEqual([
            {
                tool_use_id: "toolu_bracket",
                content: [
                    { title: "[PDF] RFC 9000", url: "https://example.com/rfc" },
                    { title: "Other", url: "https://other" },
                ],
            },
        ]);
    });

    it("still sees a search the raw Messages API ran", () => {
        expect(
            blocksContainSearch([
                { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
            ] as never),
        ).toBe(true);
    });

    it("does not call an answer from memory a search", () => {
        expect(blocksContainSearch([{ type: "text", text: "I already know." }] as never)).toBe(
            false,
        );
    });
});
