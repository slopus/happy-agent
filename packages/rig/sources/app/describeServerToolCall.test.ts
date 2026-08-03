import { describe, expect, it } from "vitest";

import { describeServerToolCall } from "./describeServerToolCall.js";

describe("describeServerToolCall", () => {
    it("says what the provider searched for instead of naming its tool", () => {
        expect(
            describeServerToolCall(
                "x_keyword_search",
                '{"query":"Claude Code","limit":"5","mode":"Latest"}',
            ),
        ).toEqual({
            active: 'Searching X for "Claude Code"',
            title: "Searched X",
            detail: 'for "Claude Code"',
        });
        expect(
            describeServerToolCall("x_semantic_search", '{"query":"Claude Code","limit":"5"}'),
        ).toMatchObject({ active: 'Searching X for "Claude Code"' });
        expect(
            describeServerToolCall(
                "web_search",
                '{"type":"search","query":"Node.js current stable version","sources":[{"type":"url","url":"https://nodejs.org/en"}]}',
            ),
        ).toEqual({
            active: 'Searching the web for "Node.js current stable version"',
            title: "Searched the web",
            detail: 'for "Node.js current stable version"',
        });
    });

    it("never shows JSON while the arguments are still arriving", () => {
        expect(describeServerToolCall("x_keyword_search", "")).toEqual({
            active: "Searching X",
            title: "Searched X",
            detail: "",
        });
        expect(describeServerToolCall("x_keyword_search", '{"que')).toMatchObject({
            active: "Searching X",
            detail: "",
        });
        expect(describeServerToolCall("x_keyword_search", '{"query":"Claude Co')).toMatchObject({
            active: "Searching X",
            detail: "",
        });
        expect(
            describeServerToolCall("web_search", '{"type":"search","query":"Node.js","sourc'),
        ).toMatchObject({ active: 'Searching the web for "Node.js"' });
        expect(describeServerToolCall("web_search", "not json at all")).toMatchObject({
            active: "Searching the web",
            detail: "",
        });
        expect(describeServerToolCall("web_search", '{"query":42}')).toMatchObject({
            active: "Searching the web",
            detail: "",
        });
    });

    it("keeps an unusual query readable on one row", () => {
        expect(
            describeServerToolCall("web_search", '{"query":"first line\\n\\tsecond line"}'),
        ).toMatchObject({ active: 'Searching the web for "first line second line"' });

        const description = describeServerToolCall(
            "web_search",
            JSON.stringify({ query: "a".repeat(200) }),
        );
        expect(description.active.length).toBeLessThan(90);
        expect(description.active.endsWith('…"')).toBe(true);
    });

    it("describes an unfamiliar provider-run tool in plain English", () => {
        expect(describeServerToolCall("browse_page", '{"url":"https://example.com"}')).toEqual({
            active: "Running the model's own browse page tool",
            title: "Ran the model's own browse page tool",
            detail: "",
        });
        expect(describeServerToolCall(undefined, "")).toEqual({
            active: "Working on the model's own servers",
            title: "Ran a tool on the model's own servers",
            detail: "",
        });
    });
});
