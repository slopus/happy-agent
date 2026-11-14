import { describe, expect, it } from "vitest";

import {
    formatHappyShareMarkdownLink,
    formatHappyShareUrl,
    formatHappyUrl,
    happyLinkPartialLength,
    parseHappyLinks,
    parseHappyShareUrl,
    parseHappyUrl,
    renderHappyLinksAsText,
    type HappyLink,
    type HappyShareLinkRole,
} from "../sources/index.js";

/*
 * The vectors are link.happy.page's own (`link.happy.page/src/link.test.ts` in slopus/happy-link),
 * so the daemon and every client write and read exactly what the page does.
 */

const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const OTHER = "m1n2b3v4c5x6z7l8k9j0h1g2";
const ID = "t7bgxjt05aexj73frl6ul37e";
const PAGE = "https://link.happy.page/#";

function instanceLink(url: string): HappyLink {
    const link = parseHappyUrl(url);
    if (link === undefined) throw new Error(`Not a Happy link: ${url}`);
    return link;
}

describe("round trip", () => {
    const cases: [string, string, HappyShareLinkRole?][] = [
        [`happy://${INSTANCE}/agents/${ID}`, `1/${INSTANCE}/agents/${ID}`],
        [`happy://${INSTANCE}/agents/${ID}`, `1/${INSTANCE}/agents/${ID}?as=task`, "task"],
        [`happy://${INSTANCE}/agents/${ID}`, `1/${INSTANCE}/agents/${ID}?as=bot`, "bot"],
        [`happy://${INSTANCE}/agents/${ID}`, `1/${INSTANCE}/agents/${ID}?as=subtask`, "subtask"],
        [`happy://${INSTANCE}/agents/${ID}`, `1/${INSTANCE}/agents/${ID}?as=subagent`, "subagent"],
        [`happy://${INSTANCE}/agents/${ID}`, `1/${INSTANCE}/agents/${ID}?as=session`, "session"],
        [`happy://${INSTANCE}/artifacts/${ID}`, `1/${INSTANCE}/artifacts/${ID}`],
        [
            `happy://${INSTANCE}/artifacts/${ID}?version=12`,
            `1/${INSTANCE}/artifacts/${ID}?version=12`,
        ],
        [`happy://${INSTANCE}/workspaces/${ID}`, `1/${INSTANCE}/workspaces/${ID}`],
        [`happy://${INSTANCE}/projects/${ID}`, `1/${INSTANCE}/projects/${ID}`],
        [`happy://${INSTANCE}/surfaces/${ID}`, `1/${INSTANCE}/surfaces/${ID}`],
        [`happy://${INSTANCE}/users/${ID}`, `1/${INSTANCE}/users/${ID}`],
        [
            `happy://${INSTANCE}/workspaces/ws_1/services/web-2`,
            `1/${INSTANCE}/workspaces/ws_1/services/web-2`,
        ],
        [
            `happy://${INSTANCE}/agents/${ID}/files/src/main.ts#L42`,
            `1/${INSTANCE}/agents/${ID}/files/src/main.ts?lines=42`,
        ],
        [
            `happy://${INSTANCE}/workspaces/${ID}/files/docs/My%20Notes.md#L3-L9`,
            `1/${INSTANCE}/workspaces/${ID}/files/docs/My%20Notes.md?lines=3-9`,
        ],
    ];
    for (const [url, payload, as] of cases)
        it(payload, () => {
            const link = instanceLink(url);
            expect(formatHappyShareUrl(link, as === undefined ? {} : { as })).toBe(
                `${PAGE}${payload}`,
            );
            const parsed = parseHappyShareUrl(`${PAGE}${payload}`);
            expect(parsed).toEqual({ link, ...(as === undefined ? {} : { as }) });
            // It opens the canonical instance link, and the role never reaches it.
            expect(parsed === undefined ? undefined : formatHappyUrl(parsed.link)).toBe(url);
        });
});

describe("refuses whatever is not exactly a share link", () => {
    const fragments = [
        "",
        `2/${INSTANCE}/agents/${ID}`,
        `10/${INSTANCE}/agents/${ID}`,
        `1/${INSTANCE}/agents/${"a".repeat(4100)}`,
        // link.happy.engineering's v1: names something, but no installation.
        `1/agents/${ID}`,
        `1/artifacts/${ID}?version=2`,
        "hello",
        "1/",
        `1/${INSTANCE}`,
        `1/${INSTANCE}/`,
        `1/${INSTANCE.toUpperCase()}/agents/${ID}`,
        `1/${INSTANCE}x/agents/${ID}`,
        `1/9${INSTANCE.slice(1)}/agents/${ID}`,
        `1/${INSTANCE}/agent/${ID}`,
        `1/${INSTANCE}/agents/${ID}/`,
        `1/${INSTANCE}/agents/a.b`,
        `1/${INSTANCE}/sessions/${ID}`,
        `1/${INSTANCE}/agents/${ID}?title=Plan`,
        `1/${INSTANCE}/chief-of-staff?text=hi`,
        `1/${INSTANCE}/organizations/org_1/join`,
        `1/${INSTANCE}/agents/${ID}?as=task&as=bot`,
        `1/${INSTANCE}/agents/${ID}?as=Task`,
        `1/${INSTANCE}/agents/${ID}?as=admin`,
        `1/${INSTANCE}/agents/${ID}?as=`,
        `1/${INSTANCE}/agents/${ID}?`,
        `1/${INSTANCE}/artifacts/${ID}?as=task`,
        `1/${INSTANCE}/agents/${ID}?version=2`,
        `1/${INSTANCE}/artifacts/${ID}?version=0`,
        `1/${INSTANCE}/artifacts/${ID}?version=01`,
        `1/${INSTANCE}/artifacts/${ID}?version=1000000000`,
        `1/${INSTANCE}/agents/${ID}/files/a/../b`,
        `1/${INSTANCE}/agents/${ID}/files/a%2Fb`,
        `1/${INSTANCE}/agents/${ID}/files/a%5Cb`,
        `1/${INSTANCE}/agents/${ID}/files/a%00b`,
        `1/${INSTANCE}/agents/${ID}/files/a%zz`,
        `1/${INSTANCE}/agents/${ID}/files/a//b`,
        `1/${INSTANCE}/agents/${ID}/files/a.ts?lines=9-3`,
        `1/${INSTANCE}/agents/${ID}/files/a.ts?lines=L9`,
        `1/${INSTANCE}/agents/${ID}#x`,
        `1/${INSTANCE}/agents/${ID}?as=task#x`,
        "1/javascript:alert(1)",
        // Beyond the page's vectors: forms only the Happy URL grammar has.
        `1/${INSTANCE}/settings/providers`,
        `1/${INSTANCE}/server?url=https%3A%2F%2Fexample.com%2F`,
        `1/${INSTANCE}/agents/${ID}/files/a.ts#L3`,
        `1/${INSTANCE}/artifacts/${ID}?lines=3`,
        `1/${INSTANCE}/agents/${ID}/files/a.ts?version=2`,
    ];
    for (const fragment of fragments)
        it(JSON.stringify(fragment.slice(0, 80)), () => {
            expect(parseHappyShareUrl(`${PAGE}${fragment}`)).toBeUndefined();
        });

    it("another host or scheme", () => {
        for (const url of [
            `https://link.happy.engineering/#1/${INSTANCE}/agents/${ID}`,
            `http://link.happy.page/#1/${INSTANCE}/agents/${ID}`,
            `https://link.happy.page.evil.com/#1/${INSTANCE}/agents/${ID}`,
            `https://evil.com/?https://link.happy.page/#1/${INSTANCE}/agents/${ID}`,
            `happy://${INSTANCE}/agents/${ID}`,
        ])
            expect(parseHappyShareUrl(url), url).toBeUndefined();
    });
});

describe("formatting", () => {
    it("writes a share link only for an instance link to an entity or a file", () => {
        for (const url of [`happy://agents/${ID}`, `happy://${INSTANCE}/settings/providers`])
            expect(() => formatHappyShareUrl(instanceLink(url)), url).toThrow(TypeError);
        // The role is said of agents only.
        expect(() =>
            formatHappyShareUrl(instanceLink(`happy://${INSTANCE}/artifacts/${ID}`), {
                as: "task",
            }),
        ).toThrow(TypeError);
    });

    it("refuses links the grammar cannot express", () => {
        const bad: HappyLink[] = [
            { type: "reference", reference: { kind: "agent", id: ID }, instanceId: "short" },
            { type: "reference", reference: { kind: "agent", id: "a b" }, instanceId: INSTANCE },
            {
                type: "reference",
                reference: { kind: "artifact", id: ID, version: 0 },
                instanceId: INSTANCE,
            },
            {
                type: "file",
                file: { target: { type: "agent", agentId: ID }, path: "../etc" },
                instanceId: INSTANCE,
            },
            {
                type: "file",
                file: {
                    target: { type: "agent", agentId: ID },
                    path: "a",
                    lines: { start: 5, end: 2 },
                },
                instanceId: INSTANCE,
            },
        ];
        for (const link of bad) expect(() => formatHappyShareUrl(link)).toThrow(TypeError);
    });

    it("percent-encodes a file path canonically and writes one line once", () => {
        const link: HappyLink = {
            type: "file",
            file: {
                target: { type: "agent", agentId: ID },
                path: "src/My (draft)#1.ts",
                lines: { start: 7, end: 7 },
            },
            instanceId: INSTANCE,
        };
        const url = formatHappyShareUrl(link);
        expect(url).toBe(
            `${PAGE}1/${INSTANCE}/agents/${ID}/files/src/My%20%28draft%29%231.ts?lines=7`,
        );
        expect(parseHappyShareUrl(url)?.link).toEqual(link);
    });

    it("writes a Markdown link with an empty label, which clients fill with the live name", () => {
        expect(
            formatHappyShareMarkdownLink(
                { type: "reference", reference: { kind: "agent", id: ID }, instanceId: INSTANCE },
                { as: "subtask" },
            ),
        ).toBe(`[](${PAGE}1/${INSTANCE}/agents/${ID}?as=subtask)`);
    });
});

describe("in Markdown", () => {
    const share = `${PAGE}1/${INSTANCE}/agents/${ID}?as=task`;

    it("reads a share link as the instance link it carries", () => {
        expect(parseHappyLinks(`See [the plan](${share}) now`)).toEqual([
            { type: "text", text: "See " },
            {
                type: "link",
                link: {
                    type: "reference",
                    reference: { kind: "agent", id: ID },
                    instanceId: INSTANCE,
                },
                label: "the plan",
                image: false,
                source: `[the plan](${share})`,
                syntax: "link",
                display: "link",
            },
            { type: "text", text: " now" },
        ]);
        const foreign = parseHappyLinks(`[theirs](${PAGE}1/${OTHER}/users/${ID})`)[0];
        expect(foreign?.type === "link" && foreign.link?.instanceId).toBe(OTHER);
    });

    it("leaves other web links, malformed share links, and code alone", () => {
        for (const markdown of [
            `[docs](https://example.com/#1/${INSTANCE}/agents/${ID})`,
            `[broken](${PAGE}1/${INSTANCE}/agents/${ID}?title=Plan)`,
            `\`[the plan](${share})\``,
            `See ${share} bare`,
        ])
            expect(parseHappyLinks(markdown), markdown).toEqual([{ type: "text", text: markdown }]);
    });

    it("falls back to the label or the live name", () => {
        expect(renderHappyLinksAsText(`See [the plan](${share}).`)).toBe("See the plan.");
        expect(renderHappyLinksAsText(`See [the plan](${share}).`, () => "Fix the build")).toBe(
            "See Fix the build.",
        );
    });

    it("hides a share link while it streams", () => {
        const text = "Done: ";
        for (const partial of [
            "[the plan](https://link.ha",
            `[the plan](${PAGE}1/${INSTANCE.slice(0, 6)}`,
            `[the plan](${share.slice(0, -3)}`,
        ])
            expect(happyLinkPartialLength(`${text}${partial}`), partial).toBe(partial.length);
        expect(happyLinkPartialLength(`${text}[docs](https://example.com/a`)).toBe(0);
    });
});
