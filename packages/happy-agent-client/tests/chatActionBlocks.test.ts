import { describe, expect, it } from "vitest";

import { chatActionBlocksOf, parseChatActionBlock } from "../sources/chatActionBlocks.js";
import { splitChatActionBlocks, stripChatActionBlocks } from "../sources/mediaLayoutBlocks.js";
import vectors from "./fixtures/chatActionBlocks.vectors.json" with { type: "json" };

describe("inline action vectors shared with desktop and iOS", () => {
    it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_name, vector) => {
        const segments = splitChatActionBlocks(vector.markdown);
        expect(
            segments.map((part) => (part.type === "markdown" ? part.text : part.html)).join(""),
        ).toBe(vector.markdown);
        expect(chatActionBlocksOf(vector.markdown)).toEqual(vector.blocks);
        expect(stripChatActionBlocks(vector.markdown)).toBe(vector.stripped);
    });
});

describe("splitChatActionBlocks", () => {
    it("holds back a menu while its tag is still being written", () => {
        expect(splitChatActionBlocks("Choose:\n<me")).toEqual([
            { type: "markdown", text: "Choose:\n" },
            { type: "action", html: "<me", complete: false },
        ]);
    });

    it("leaves other HTML to Markdown", () => {
        const markdown = "<form><button>Go</button></form>\n<ol><li>One</li></ol>\n";
        expect(splitChatActionBlocks(markdown)).toEqual([{ type: "markdown", text: markdown }]);
    });
});

describe("parseChatActionBlock", () => {
    it("reads one menu and nothing after it", () => {
        expect(parseChatActionBlock('<menu><button data-action="reply">A</button></menu> x')).toBe(
            null,
        );
        expect(
            parseChatActionBlock(
                '<menu><button data-action="reply">A</button></menu><menu></menu>',
            ),
        ).toBe(null);
    });

    it("collapses whitespace in a label and keeps every other data attribute as a parameter", () => {
        expect(
            parseChatActionBlock(
                '<menu><button data-action="reply" data-tone="warm">\n  Use this\n  draft </button></menu>',
            ),
        ).toEqual({
            kind: "menu",
            buttons: [
                {
                    label: "Use this draft",
                    action: { id: "reply", params: { tone: "warm" }, text: "Use this draft" },
                },
            ],
        });
    });
});
