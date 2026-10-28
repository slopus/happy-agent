import { describe, expect, it } from "vitest";

import {
    escapeMarkdownText,
    formatHappyReferenceTag,
    happyReferencePartialTagLength,
    happyReferencePlaceholder,
    isKnownHappyReferenceKind,
    parseHappyReferences,
    parseHappyReferenceTag,
    renderHappyReferencesAsMarkdown,
    replaceHappyReferences,
} from "../sources/index.js";

const ID = "rg799k2m9q4w1e5t8y3u6i0o";

describe("parseHappyReferenceTag", () => {
    it("parses the canonical tag of every kind", () => {
        for (const kind of [
            "artifact",
            "agent",
            "workspace",
            "project",
            "service",
            "surface",
            "user",
        ]) {
            expect(parseHappyReferenceTag(`<happy-${kind} id="${ID}"/>`)).toEqual({ kind, id: ID });
            expect(isKnownHappyReferenceKind(kind)).toBe(true);
        }
    });

    it("reads version and workspace, in any order and with spaces before the slash", () => {
        expect(parseHappyReferenceTag(`<happy-artifact version="12" id="${ID}" />`)).toEqual({
            kind: "artifact",
            id: ID,
            version: 12,
        });
        expect(parseHappyReferenceTag(`<happy-service\tid="s1"  workspace="w1"/>`)).toEqual({
            kind: "service",
            id: "s1",
            workspaceId: "w1",
        });
    });

    it("parses unknown kinds and ignores unknown attributes", () => {
        expect(parseHappyReferenceTag(`<happy-future-thing id="x" color="red"/>`)).toEqual({
            kind: "future-thing",
            id: "x",
        });
        expect(isKnownHappyReferenceKind("future-thing")).toBe(false);
        expect(isKnownHappyReferenceKind("artifact")).toBe(true);
    });

    it.each([
        ["no id", `<happy-artifact version="1"/>`],
        ["an empty id", `<happy-artifact id=""/>`],
        ["an id with a space", `<happy-artifact id="a b"/>`],
        ["single quotes", `<happy-artifact id='${ID}'/>`],
        ["an unquoted value", `<happy-artifact id=${ID}/>`],
        ["no self-closing slash", `<happy-artifact id="${ID}">`],
        ["the paired form", `<happy-artifact id="${ID}"></happy-artifact>`],
        ["a zero version", `<happy-artifact id="${ID}" version="0"/>`],
        ["a non-numeric version", `<happy-artifact id="${ID}" version="v2"/>`],
        ["a duplicate attribute", `<happy-artifact id="a" id="b"/>`],
        ["attributes without space", `<happy-artifact id="a"version="1"/>`],
        ["an uppercase kind", `<happy-Artifact id="${ID}"/>`],
        ["a newline inside", `<happy-artifact\nid="${ID}"/>`],
        ["surrounding text", ` <happy-artifact id="${ID}"/>`],
        [
            "an oversized tag",
            `<happy-artifact id="${ID}" x="${"y".repeat(250)}" z="${"y".repeat(250)}"/>`,
        ],
    ])("rejects %s", (_name, tag) => {
        expect(parseHappyReferenceTag(tag)).toBeUndefined();
    });
});

describe("parseHappyReferences", () => {
    it("splits inline and standalone references from text", () => {
        const tag = `<happy-artifact id="${ID}"/>`;
        expect(parseHappyReferences(`I published ${tag} for you.\n\n${tag}\n`)).toEqual([
            { type: "text", text: "I published " },
            { type: "reference", reference: { kind: "artifact", id: ID }, source: tag },
            { type: "text", text: " for you.\n\n" },
            { type: "reference", reference: { kind: "artifact", id: ID }, source: tag },
            { type: "text", text: "\n" },
        ]);
    });

    it("leaves code spans, fenced code, escapes, and malformed tags literal", () => {
        const markdown = [
            'Write `<happy-artifact id="a"/>` or ``x <happy-agent id="b"/> y``.',
            '\\<happy-artifact id="c"/> is escaped.',
            "```markdown",
            '<happy-artifact id="d"/>',
            "```",
            "~~~",
            '<happy-artifact id="e"/>',
            "~~~",
            '<happy-artifact id="f">',
            "> ```",
            '> <happy-artifact id="g"/>',
            "> ```",
            '<happy-workspace id="h"/>',
        ].join("\n");
        const references = parseHappyReferences(markdown).flatMap((segment) =>
            segment.type === "reference" ? [segment.reference.id] : [],
        );
        expect(references).toEqual(["h"]);
    });

    it("treats an unclosed fence as code to the end", () => {
        expect(parseHappyReferences('```\n<happy-artifact id="a"/>\n')).toEqual([
            { type: "text", text: '```\n<happy-artifact id="a"/>\n' },
        ]);
    });

    it("keeps unmatched backticks literal so a later tag still parses", () => {
        expect(
            parseHappyReferences('a ` b <happy-artifact id="x"/>').map((segment) => segment.type),
        ).toEqual(["text", "reference"]);
    });

    it("does not let a code span cross a blank line", () => {
        expect(
            parseHappyReferences('`a\n\n<happy-artifact id="x"/> `').map((segment) => segment.type),
        ).toEqual(["text", "reference", "text"]);
    });

    it("leaves an incomplete trailing tag as text once the message is finished", () => {
        expect(parseHappyReferences("See <happy-arti")).toEqual([
            { type: "text", text: "See <happy-arti" },
        ]);
    });
});

describe("streaming", () => {
    it.each([
        "See <",
        "See <h",
        "See <happy",
        "See <happy-",
        "See <happy-arti",
        "See <happy-artifact ",
        'See <happy-artifact id="rg7',
        `See <happy-artifact id="${ID}"`,
        `See <happy-artifact id="${ID}" `,
        `See <happy-artifact id="${ID}"/`,
        `See <happy-artifact id="${ID}" version="`,
    ])("hides the partial tag in %j", (markdown) => {
        expect(happyReferencePartialTagLength(markdown)).toBe(markdown.length - "See ".length);
        expect(parseHappyReferences(markdown, { streaming: true })).toEqual([
            { type: "text", text: "See " },
        ]);
    });

    it.each([
        ["complete text", "Done."],
        ["a complete tag", `See <happy-artifact id="${ID}"/>`],
        ["a closed malformed tag", `See <happy-artifact id="${ID}">`],
        ["a non-tag angle bracket", "a <b"],
        ["a comparison", "x < y"],
        ["a different tag", "<div"],
        ["a newline after the prefix", "See <happy-arti\n"],
        ["an escaped bracket", "See \\<happy-arti"],
        ["code", "Type `<happy-arti"],
        ["a fence", "```\n<happy-arti"],
        ["attributes that cannot be a tag", '<happy-artifact id="a"version'],
        ["an overlong prefix", `<happy-artifact x="${"y".repeat(600)}`],
    ])("hides nothing after %s", (_name, markdown) => {
        expect(happyReferencePartialTagLength(markdown)).toBe(0);
    });

    it("keeps references before a trailing partial", () => {
        const tag = `<happy-artifact id="${ID}"/>`;
        expect(
            replaceHappyReferences(`${tag} and <happy-ag`, () => "[R]", { streaming: true }),
        ).toBe("[R] and ");
    });
});

describe("fallback rendering", () => {
    it("replaces each tag with its escaped label or a placeholder", () => {
        const titles = new Map([[ID, "Q3 *revenue* [draft]"]]);
        expect(
            renderHappyReferencesAsMarkdown(
                `Read <happy-artifact id="${ID}"/>, not <happy-artifact id="gone"/> or <happy-x id="y"/>.`,
                (reference) => titles.get(reference.id),
            ),
        ).toBe(
            "Read Q3 \\*revenue\\* \\[draft\\], not an unavailable artifact or an unavailable reference.",
        );
    });

    it("drops a trailing partial tag while streaming", () => {
        expect(
            renderHappyReferencesAsMarkdown("Read <happy-art", () => "T", { streaming: true }),
        ).toBe("Read ");
    });

    it("escapes labels onto one line", () => {
        expect(escapeMarkdownText("a\n\n b_c")).toBe("a b\\_c");
        expect(happyReferencePlaceholder({ kind: "service", id: "s" })).toBe(
            "an unavailable service",
        );
        expect(happyReferencePlaceholder({ kind: "surface", id: "s" })).toBe(
            "an unavailable surface",
        );
    });
});

describe("formatHappyReferenceTag", () => {
    it("writes the canonical tag that parses back to the same reference", () => {
        const reference = { kind: "service", id: "s1", version: 3, workspaceId: "w1" };
        const tag = formatHappyReferenceTag(reference);
        expect(tag).toBe('<happy-service id="s1" version="3" workspace="w1"/>');
        expect(parseHappyReferenceTag(tag)).toEqual(reference);
        expect(formatHappyReferenceTag({ kind: "artifact", id: ID })).toBe(
            `<happy-artifact id="${ID}"/>`,
        );
    });

    it("refuses a reference the grammar cannot express", () => {
        expect(() => formatHappyReferenceTag({ kind: "artifact", id: 'a"b' })).toThrow(TypeError);
        expect(() => formatHappyReferenceTag({ kind: "Artifact", id: "a" })).toThrow(TypeError);
    });
});
