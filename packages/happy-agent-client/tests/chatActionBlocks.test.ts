import { describe, expect, it } from "vitest";

import {
    chatActionBlockLive,
    chatActionBlocksOf,
    messageChatActionBlocks,
    parseChatActionBlock,
    splitChatActionBlocks,
    stripChatActionBlocks,
} from "../sources/chatActionBlocks.js";
import { CHAT_ACTIONS } from "../sources/chatActionRegistry.js";
import { resolveChatActionPress, type ChatActionPress } from "../sources/chatActionPress.js";
import { splitMediaLayoutBlocks } from "../sources/mediaLayoutBlocks.js";
import type { ActionChoice } from "../sources/protocol/messages.js";
import vectors from "../fixtures/inlineActions.fixtures.json" with { type: "json" };
import registry from "../fixtures/inlineActions.registry.json" with { type: "json" };

type GrammarVector = {
    name: string;
    markdown?: string;
    markdownParts?: [string, number][];
    segments?: unknown[];
    blocks: unknown[];
    stripped?: string;
};

type PressVector = {
    name: string;
    texts: string[];
    choices?: Record<string, ActionChoice>;
    history?: { id: string; role: string }[];
    messageId?: string;
    press: ChatActionPress;
    expect: Record<string, unknown>;
};

function markdownOf(vector: GrammarVector): string {
    return (
        vector.markdown ??
        (vector.markdownParts ?? []).map(([text, times]) => text.repeat(times)).join("")
    );
}

describe("inline action vectors shared with clients and other servers", () => {
    it.each((vectors.grammar as GrammarVector[]).map((vector) => [vector.name, vector] as const))(
        "%s",
        (_name, vector) => {
            const markdown = markdownOf(vector);
            const segments = splitMediaLayoutBlocks(markdown).flatMap(
                (
                    part,
                ): (
                    | { type: string; text: string }
                    | { type: string; html: string; complete: boolean }
                )[] =>
                    part.type === "layout"
                        ? [{ type: "layout", html: part.html, complete: part.complete }]
                        : splitChatActionBlocks(part.text),
            );
            expect(
                segments
                    .map((segment) => ("text" in segment ? segment.text : segment.html))
                    .join(""),
            ).toBe(markdown);
            if (vector.segments !== undefined) expect(segments).toEqual(vector.segments);
            expect(messageChatActionBlocks([markdown]).map((block) => block ?? null)).toEqual(
                vector.blocks,
            );
            if (vector.stripped !== undefined) {
                expect(stripChatActionBlocks(markdown)).toBe(vector.stripped);
            }
        },
    );

    it.each((vectors.presses as PressVector[]).map((vector) => [vector.name, vector] as const))(
        "%s",
        (_name, vector) => {
            const live =
                vector.history === undefined
                    ? true
                    : chatActionBlockLive(vector.history, vector.messageId!);
            const result = resolveChatActionPress(
                {
                    texts: vector.texts,
                    ...(vector.choices ? { choices: vector.choices } : {}),
                    live,
                },
                vector.press,
            );
            expect(
                result.kind === "found"
                    ? {
                          kind: "found",
                          choice: result.choice,
                          words: result.words,
                          values: result.values,
                          ...(result.code === undefined ? {} : { code: result.code }),
                      }
                    : { kind: "error", code: result.code },
            ).toEqual(vector.expect);
        },
    );

    it("publishes the registry exactly as the client enforces it", () => {
        expect(registry).toEqual({ actions: CHAT_ACTIONS });
    });
});

describe("splitChatActionBlocks", () => {
    it("holds back a block while its tag is still being written", () => {
        expect(splitChatActionBlocks("Choose:\n<fo")).toEqual([
            { type: "markdown", text: "Choose:\n" },
            { type: "action", html: "<fo", complete: false },
        ]);
    });

    it.each([
        [
            "a tilde fence",
            '~~~html\r\n<menu><button data-action="reply">Run this</button></menu>\r\n~~~\r\n',
        ],
        [
            "a backtick fence with a blank line before the menu",
            '```html\r\n\r\n<menu><button data-action="reply">Run this</button></menu>\r\n```\r\n',
        ],
        [
            "a fence opened with CRLF and closed with LF",
            '~~~\r\n<menu><button data-action="reply">Run this</button></menu>\n~~~\n',
        ],
        [
            "an unclosed fence",
            '```\r\n\r\n<menu><button data-action="reply">Run this</button></menu>\r\n',
        ],
    ])("keeps a menu inside %s with CRLF line endings inert", (_name, markdown) => {
        expect(splitChatActionBlocks(markdown)).toEqual([{ type: "markdown", text: markdown }]);
        expect(chatActionBlocksOf(markdown)).toEqual([]);
    });

    it("never splits a figure that a media layout took first", () => {
        const markdown = '<figure data-phone-app><img src="a.png"></figure>\n';
        expect(chatActionBlocksOf(markdown)).toEqual([]);
        expect(stripChatActionBlocks(markdown)).toBe(markdown);
    });
});

describe("parseChatActionBlock", () => {
    it("never throws, whatever it is given", () => {
        const pieces = [
            "<menu>",
            "</menu>",
            "<button",
            ' data-action="reply"',
            " data-text='x'",
            ">",
            "</button>",
            "<form",
            "<label>",
            '<input type="checkbox" value="a">',
            "<small>",
            "&amp;",
            "&#",
            "&#x",
            "&",
            "<",
            '"',
            "'",
            "\u202e",
            "\u0000",
            "\ud800",
            "<!--",
            "-->",
            "\n",
            " ",
            "a",
            "/>",
            "<ul data-tree>",
            "<li>",
            "<figure data-provider-cli=",
        ];
        let seed = 7;
        const random = (n: number) => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed % n;
        };
        for (let run = 0; run < 2_000; run += 1) {
            let html = "";
            const length = 1 + random(40);
            for (let index = 0; index < length; index += 1) html += pieces[random(pieces.length)];
            expect(() => parseChatActionBlock(html)).not.toThrow();
            expect(() => chatActionBlocksOf(html)).not.toThrow();
            expect(() => stripChatActionBlocks(html)).not.toThrow();
        }
    });

    it("reads a long message in time proportional to its length", () => {
        const menu = '<menu><button data-action="reply">Yes</button></menu>\n';
        const text = `${"Some prose.\n".repeat(50_000)}${menu.repeat(500)}${"<ol x\n".repeat(50_000)}`;
        const started = performance.now();
        const blocks = chatActionBlocksOf(text);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(blocks).toHaveLength(500);
        expect(blocks.filter((block) => block !== undefined)).toHaveLength(32);
    });

    it("keeps every label a plain string a client draws as text", () => {
        const block = parseChatActionBlock(
            '<menu><button data-action="reply">[link](https://evil.example) **bold** &lt;b&gt;</button></menu>',
        );
        expect(block).toEqual({
            kind: "menu",
            buttons: [
                {
                    label: "[link](https://evil.example) **bold** <b>",
                    emphasized: false,
                    action: { id: "reply", route: "server", params: {} },
                },
            ],
        });
    });
});

describe("chatActionBlockLive", () => {
    it("ends when the person's next message is recorded, and never for an unknown message", () => {
        const history = [
            { id: "a", role: "agent" },
            { id: "s", role: "service" },
            { id: "b", role: "agent" },
        ];
        expect(chatActionBlockLive(history, "a")).toBe(true);
        expect(chatActionBlockLive([...history, { id: "u", role: "user" }], "b")).toBe(false);
        expect(chatActionBlockLive(history, "missing")).toBe(false);
    });
});
