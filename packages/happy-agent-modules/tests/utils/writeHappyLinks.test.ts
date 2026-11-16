import {
    parseHappyLinks,
    parseHappyShareUrl,
    parseHappyUrl,
    type HappyLink,
} from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import {
    happyUrlPattern,
    isHappyLinkHere,
    writeHappyMarkdownLink,
    writeHappyUrl,
} from "../../sources/utils/writeHappyLinks.js";

const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const OTHER = "m1n2b3v4c5x6z7l8k9j0h1g2";
const ID = "t7bgxjt05aexj73frl6ul37e";
const PAGE = `https://link.happy.page/#1/${INSTANCE}`;

const agent: HappyLink = { type: "reference", reference: { kind: "agent", id: ID } };
const file: HappyLink = {
    type: "file",
    file: { target: { type: "workspace", workspaceId: ID }, path: "docs/My Notes.md" },
};

describe("writing Happy links", () => {
    it("writes an empty-label share link naming this installation", () => {
        expect(writeHappyMarkdownLink(INSTANCE, agent, { as: "task" })).toBe(
            `[](${PAGE}/agents/${ID}?as=task)`,
        );
        expect(
            writeHappyMarkdownLink(INSTANCE, {
                type: "reference",
                reference: { kind: "artifact", id: ID, version: 3 },
            }),
        ).toBe(`[](${PAGE}/artifacts/${ID}?version=3)`);
        expect(writeHappyUrl(INSTANCE, file)).toBe(
            `${PAGE}/workspaces/${ID}/files/docs/My%20Notes.md`,
        );
    });

    it("writes the plain happy:// link without an instance", () => {
        expect(writeHappyMarkdownLink(undefined, agent, { as: "task" })).toBe(
            `[](happy://agents/${ID})`,
        );
        expect(writeHappyUrl(undefined, file)).toBe(
            `happy://workspaces/${ID}/files/docs/My%20Notes.md`,
        );
    });

    it("writes the pattern an agent is told to fill in, in either form", () => {
        expect(happyUrlPattern(INSTANCE, "agents/<agentId>", { as: "bot" })).toBe(
            `${PAGE}/agents/<agentId>?as=bot`,
        );
        expect(happyUrlPattern(INSTANCE, `agents/${ID}/files/<path>`, { lines: "42-50" })).toBe(
            `${PAGE}/agents/${ID}/files/<path>?lines=42-50`,
        );
        expect(happyUrlPattern(undefined, `agents/${ID}/files/<path>`, { lines: "42-50" })).toBe(
            `happy://agents/${ID}/files/<path>#L42-L50`,
        );
        expect(happyUrlPattern(undefined, "agents/<agentId>", { as: "bot" })).toBe(
            "happy://agents/<agentId>",
        );
        // Filled in, the pattern is the link the writer writes.
        const filled = happyUrlPattern(INSTANCE, `agents/${ID}/files/src/a.ts`, { lines: "4" });
        expect(parseHappyShareUrl(filled)?.link).toEqual({
            type: "file",
            file: {
                target: { type: "agent", agentId: ID },
                path: "src/a.ts",
                lines: { start: 4, end: 4 },
            },
            instanceId: INSTANCE,
        });
    });
});

describe("reading share links", () => {
    it("tells this installation's links from another's", () => {
        const links = parseHappyLinks(
            `[a](${PAGE}/users/${ID}) [b](https://link.happy.page/#1/${OTHER}/users/${ID}) [c](happy://users/${ID})`,
        ).flatMap((segment) => (segment.type === "link" && segment.link ? [segment.link] : []));
        expect(links.map((link) => isHappyLinkHere(INSTANCE, link))).toEqual([true, false, true]);
        expect(isHappyLinkHere(undefined, parseHappyUrl(`happy://${INSTANCE}/users/${ID}`)!)).toBe(
            false,
        );
    });
});
