import { describe, expect, it } from "vitest";

import {
    happyLinkPartialLength,
    parseHappyLinks,
    renderHappyLinksAsText,
    replaceHappyLinks,
    rewriteLegacyHappyReferenceTags,
    type HappyLinkMatch,
} from "../sources/index.js";

const ID = "rg799k2m9q4w1e5t8y3u6i0o";
const AGENT = "a1b2c3d4";
const WORKSPACE = "k2h4j5l6";
const ARTIFACT_URL = `happy://artifacts/${ID}`;
const FILE_URL = `happy://agents/${AGENT}/files/packages/app/Foo.tsx#L42`;

function linkIds(markdown: string): string[] {
    return parseHappyLinks(markdown).flatMap((segment) =>
        segment.type === "link" && segment.link?.type === "reference"
            ? [segment.link.reference.id]
            : [],
    );
}

describe("parseHappyLinks", () => {
    it("splits links, images, and legacy tags from text", () => {
        const link = `[Q3 report](${ARTIFACT_URL})`;
        const tag = `<happy-agent id="${AGENT}"/>`;
        const fileLink = `[README](happy-file://workspaces/${WORKSPACE}/README.md)`;
        expect(
            parseHappyLinks(`See ${link}, ${tag},\n\n${fileLink} and ![](${FILE_URL}).`),
        ).toEqual([
            { type: "text", text: "See " },
            {
                type: "link",
                link: { type: "reference", reference: { kind: "artifact", id: ID } },
                label: "Q3 report",
                image: false,
                source: link,
                syntax: "link",
            },
            { type: "text", text: ", " },
            {
                type: "link",
                link: { type: "reference", reference: { kind: "agent", id: AGENT } },
                label: "",
                image: false,
                source: tag,
                syntax: "legacyTag",
            },
            { type: "text", text: ",\n\n" },
            {
                type: "link",
                link: {
                    type: "file",
                    file: {
                        target: { type: "workspace", workspaceId: WORKSPACE },
                        path: "README.md",
                    },
                },
                label: "README",
                image: false,
                source: fileLink,
                syntax: "link",
            },
            { type: "text", text: " and " },
            {
                type: "link",
                link: {
                    type: "file",
                    file: {
                        target: { type: "agent", agentId: AGENT },
                        path: "packages/app/Foo.tsx",
                        lines: { start: 42, end: 42 },
                    },
                },
                label: "",
                image: true,
                source: `![](${FILE_URL})`,
                syntax: "link",
            },
            { type: "text", text: "." },
        ]);
    });

    it("reports malformed happy URLs and unknown legacy kinds without a link", () => {
        const segments = parseHappyLinks(
            `[open](happy://session/x) [old](happy-file://agents/${AGENT}/../a) <happy-thing id="x"/>`,
        ).filter((segment) => segment.type === "link");
        expect(segments.map((segment) => [segment.link, segment.label, segment.syntax])).toEqual([
            [undefined, "open", "link"],
            [undefined, "old", "link"],
            [undefined, "", "legacyTag"],
        ]);
    });

    it("reads every inline link form and any letter case of the scheme", () => {
        expect(
            linkIds(
                [
                    `[a](<happy://artifacts/a>)`,
                    `[b]( happy://artifacts/b "Title" )`,
                    `[c](happy://artifacts/c 'Title')`,
                    `[d](happy://artifacts/d (Title))`,
                    `[e](\nhappy://artifacts/e)`,
                    `[**bold** \`a]b\` [x]](happy://artifacts/f)`,
                ].join("\n"),
            ),
        ).toEqual(["a", "b", "c", "d", "e", "f"]);
        expect(parseHappyLinks(`[x](HAPPY://artifacts/${ID})`)[0]).toMatchObject({
            type: "link",
            link: undefined,
            syntax: "link",
        });
    });

    it("leaves code, escapes, other links, and incomplete links literal", () => {
        const untouched = [
            `\`[Foo](${ARTIFACT_URL})\` and \`\`x <happy-agent id="b"/> y\`\``,
            `\\[Foo](${ARTIFACT_URL})`,
            `[Foo]\\(${ARTIFACT_URL})`,
            '\\<happy-artifact id="c"/> is escaped.',
            `[docs](https://example.com/a.ts)`,
            `[Foo](${ARTIFACT_URL}`,
            `[Foo] (${ARTIFACT_URL})`,
            `[Foo](${ARTIFACT_URL} "unterminated)`,
            `<happy-artifact id="${ID}">`,
            ARTIFACT_URL,
            "",
            "```markdown",
            `[Foo](${ARTIFACT_URL}) <happy-artifact id="d"/>`,
            "```",
            "> ```",
            `> [Foo](${ARTIFACT_URL})`,
            "> ```",
            "",
            `[Foo\n\n](${ARTIFACT_URL})`,
        ].join("\n");
        expect(parseHappyLinks(untouched)).toEqual([{ type: "text", text: untouched }]);
    });

    it("treats an unclosed fence as code to the end", () => {
        const markdown = `\`\`\`\n[a](${ARTIFACT_URL})\n`;
        expect(parseHappyLinks(markdown)).toEqual([{ type: "text", text: markdown }]);
    });

    it("finds a link inside the label of an ordinary one", () => {
        expect(linkIds(`[see [Foo](${ARTIFACT_URL})](https://example.com)`)).toEqual([ID]);
    });

    it("leaves an incomplete trailing link as text once the message is finished", () => {
        expect(parseHappyLinks("See [Q3](happy://arti")).toEqual([
            { type: "text", text: "See [Q3](happy://arti" },
        ]);
    });
});

describe("streaming", () => {
    it.each([
        "See [Q3]",
        "See [Q3](",
        "See [Q3](h",
        "See [Q3](happy",
        "See [Q3](happy:",
        "See [Q3](happy://arti",
        `See [Q3](${ARTIFACT_URL}`,
        `See [Q3](${ARTIFACT_URL} `,
        `See [Q3](${ARTIFACT_URL} "Title`,
        `See [Q3](<${ARTIFACT_URL}`,
        `See [Q3](<${ARTIFACT_URL}>`,
        `See ![](${FILE_URL}`,
        "See [README](happy-fi",
        "See <",
        "See <happy-arti",
        `See <happy-artifact id="${ID}" `,
    ])("hides the partial link in %j", (markdown) => {
        expect(happyLinkPartialLength(markdown)).toBe(markdown.length - "See ".length);
        expect(parseHappyLinks(markdown, { streaming: true })).toEqual([
            { type: "text", text: "See " },
        ]);
    });

    it.each([
        ["complete text", "Done."],
        // Until its `]` arrives, a label may be any bracketed text, so it stays visible.
        ["a bare bracket", "See ["],
        ["an open label", "See [Q3"],
        ["a complete link", `See [Q3](${ARTIFACT_URL})`],
        ["another scheme", "See [docs](https"],
        ["another scheme's prefix", "See [docs](ht"],
        ["a different tag", "<div"],
        ["a newline after a tag prefix", "See <happy-arti\n"],
        ["an escaped bracket", "See \\[Q3](happy://arti"],
        ["code", "Type `[Q3](happy://arti"],
        ["a fence", "```\n[Q3](happy://arti"],
        ["a space between label and destination", "See [Q3] (happy://arti"],
        ["an overlong partial", `See [Q3](happy://${"a".repeat(6000)}`],
    ])("hides nothing after %s", (_name, markdown) => {
        expect(happyLinkPartialLength(markdown)).toBe(0);
    });

    it("keeps links before a trailing partial", () => {
        expect(
            replaceHappyLinks(`[Q3](${ARTIFACT_URL}) and [b](happy://ag`, () => "@", {
                streaming: true,
            }),
        ).toBe("@ and ");
    });
});

describe("replaceHappyLinks", () => {
    it("passes each match and keeps the text around it", () => {
        const seen: HappyLinkMatch[] = [];
        expect(
            replaceHappyLinks(`a [x](${ARTIFACT_URL}) b`, (match) => {
                seen.push(match);
                return "@";
            }),
        ).toBe("a @ b");
        expect(seen.map((match) => match.source)).toEqual([`[x](${ARTIFACT_URL})`]);
    });

    it("returns text with no Happy links unchanged", () => {
        const markdown = "[docs](https://example.com) `code` <div>";
        expect(replaceHappyLinks(markdown, () => "@")).toBe(markdown);
    });
});

describe("renderHappyLinksAsText", () => {
    it("prefers the resolved name, then the label, then a placeholder", () => {
        const titles = new Map([[ID, "Q3 *revenue* [draft]"]]);
        expect(
            renderHappyLinksAsText(
                [
                    `[old title](${ARTIFACT_URL})`,
                    `[Kept **label**](happy://artifacts/gone)`,
                    `[](happy://artifacts/gone)`,
                    `[](happy://workspaces/${WORKSPACE}/services/web)`,
                ].join(", "),
                (reference) => titles.get(reference.id),
            ),
        ).toBe(
            "Q3 \\*revenue\\* \\[draft\\], Kept **label**, an unavailable artifact, an unavailable service",
        );
    });

    it("shows labels as written without a resolver", () => {
        expect(renderHappyLinksAsText(`Read [the report](${ARTIFACT_URL}).`)).toBe(
            "Read the report.",
        );
    });

    it("replaces file links and images with their labels, or the decoded path", () => {
        expect(
            renderHappyLinksAsText(
                `See [Foo.tsx:42](${FILE_URL}), ![diagram](${FILE_URL}), and [](happy://agents/${AGENT}/files/my_file%20*1*.md).`,
            ),
        ).toBe("See Foo.tsx:42, diagram, and my\\_file \\*1\\*.md.");
    });

    it("shows a malformed link as its label, or nothing when the label is blank", () => {
        expect(renderHappyLinksAsText("[open the app](happy://session/x) [ ](happy://nope)!")).toBe(
            "open the app !",
        );
    });

    it("renders legacy tags and happy-file links like happy:// links", () => {
        expect(
            renderHappyLinksAsText(
                `Read <happy-artifact id="${ID}"/>, not <happy-artifact id="gone"/> or <happy-x id="y"/>, in [a.ts](happy-file://agents/${AGENT}/a.ts).`,
                (reference) => (reference.id === ID ? "Q3" : undefined),
            ),
        ).toBe("Read Q3, not an unavailable artifact or an unavailable reference, in a.ts.");
    });

    it("drops a trailing partial link while streaming", () => {
        expect(
            renderHappyLinksAsText("Read [Q3](happy://art", () => "T", { streaming: true }),
        ).toBe("Read ");
    });
});

describe("rewriteLegacyHappyReferenceTags", () => {
    it("turns legacy tags into canonical happy:// links", () => {
        expect(
            rewriteLegacyHappyReferenceTags(
                [
                    `<happy-artifact id="${ID}" version="3"/>`,
                    `<happy-service id="web" workspace="${WORKSPACE}"/>`,
                    `<happy-agent id="${AGENT}" version="3"/>`,
                ].join("\n"),
            ),
        ).toBe(
            [
                `[](happy://artifacts/${ID}?version=3)`,
                `[](happy://workspaces/${WORKSPACE}/services/web)`,
                `[](happy://agents/${AGENT})`,
            ].join("\n"),
        );
    });

    it("writes a placeholder for a tag no happy:// URL can express, and keeps every link", () => {
        const kept = [
            `[a](${ARTIFACT_URL})`,
            "[b](happy://session/x)",
            `[c](happy-file://agents/${AGENT}/packages/app/Foo.tsx#L42)`,
            `[d](happy-file://agents/${AGENT}/..)`,
        ].join(" ");
        expect(
            rewriteLegacyHappyReferenceTags(`<happy-service id="web"/> <happy-x id="y"/> ${kept}`),
        ).toBe(`an unavailable service an unavailable reference ${kept}`);
    });
});
