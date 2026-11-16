import { parseHappyLinks, type HappyLink } from "@slopus/happy-agent-client";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatNamedHappyLink } from "../../sources/utils/formatNamedHappyLink.js";

const SOURCES = fileURLToPath(new URL("../../sources", import.meta.url));
const HELPER = "utils/formatNamedHappyLink.ts";

const LINKS: readonly HappyLink[] = [
    { type: "reference", reference: { kind: "artifact", id: "r7k2m9q4w1e5t8y3u6i0o2p5" } },
    {
        type: "reference",
        reference: { kind: "artifact", id: "r7k2m9q4w1e5t8y3u6i0o2p5", version: 2 },
    },
    { type: "reference", reference: { kind: "agent", id: "t7bgxjt05aexj73frl6ul37e" } },
    { type: "reference", reference: { kind: "workspace", id: "k2h4j5l6" } },
    { type: "reference", reference: { kind: "project", id: "p1q2r3s4" } },
    { type: "reference", reference: { kind: "surface", id: "s1t2u3v4" } },
    { type: "reference", reference: { kind: "user", id: "u1v2w3x4" } },
    {
        type: "file",
        file: {
            target: { type: "agent", agentId: "a1b2c3d4" },
            path: "packages/app/Foo.tsx",
            lines: { start: 42, end: 50 },
        },
    },
    { type: "settings", page: "providers" },
];

const BLANK_NAMES: readonly (string | undefined)[] = [undefined, "", " ", "\n\t ", "\u00a0"];

/** The label of the one link `markdown` holds, as a reader of Happy links sees it. */
function labelOf(markdown: string): string {
    const links = parseHappyLinks(markdown).filter((segment) => segment.type === "link");
    expect(links).toHaveLength(1);
    const [link] = links;
    if (link?.type !== "link") throw new Error("The text holds no Happy link.");
    return link.label;
}

async function sourceFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
        else if (entry.name.endsWith(".ts")) files.push(path);
    }
    return files;
}

describe("formatNamedHappyLink", () => {
    it("writes the name as the link text of a happy:// link", () => {
        expect(
            formatNamedHappyLink(
                {
                    type: "reference",
                    reference: { kind: "artifact", id: "r7k2m9q4w1e5t8y3u6i0o2p5" },
                },
                "Q3 revenue",
            ),
        ).toBe("[Q3 revenue](happy://artifacts/r7k2m9q4w1e5t8y3u6i0o2p5)");
    });

    it("never writes a link with empty link text, whatever name it is given", () => {
        for (const link of LINKS) {
            for (const name of BLANK_NAMES) {
                for (const fallback of BLANK_NAMES) {
                    const written = formatNamedHappyLink(link, name, fallback);
                    expect(written).not.toMatch(/\[\s*\]\(/u);
                    expect(labelOf(written).trim()).not.toBe("");
                }
            }
        }
    });

    it("uses the caller's fallback for a blank name, and plain words without one", () => {
        const subtask: HappyLink = {
            type: "reference",
            reference: { kind: "agent", id: "t7bgxjt05aexj73frl6ul37e" },
        };
        expect(formatNamedHappyLink(subtask, "  ", "this subtask")).toBe(
            "[this subtask](happy://agents/t7bgxjt05aexj73frl6ul37e)",
        );
        expect(formatNamedHappyLink(subtask, undefined)).toBe(
            "[this agent](happy://agents/t7bgxjt05aexj73frl6ul37e)",
        );
        expect(
            formatNamedHappyLink(
                {
                    type: "file",
                    file: {
                        target: { type: "workspace", workspaceId: "k2h4j5l6" },
                        path: "docs/README.md",
                    },
                },
                "",
            ),
        ).toBe("[README.md](happy://workspaces/k2h4j5l6/files/docs/README.md)");
    });

    it("writes only happy:// links, never a share link", () => {
        for (const link of LINKS) {
            const written = formatNamedHappyLink(link, "Name");
            expect(written).toContain("](happy://");
            expect(written).not.toContain("link.happy.page");
        }
    });
});

describe("how modules write Happy links", () => {
    it("goes through formatNamedHappyLink, with no empty link text and no share link written", async () => {
        const offenders: string[] = [];
        for (const file of await sourceFiles(SOURCES)) {
            const name = relative(SOURCES, file).split("\\").join("/");
            const source = await readFile(file, "utf8");
            // The client's formatter leaves the label empty when it is given none.
            if (
                name !== HELPER &&
                /formatHappyMarkdownLink|formatHappyShareMarkdownLink/u.test(source)
            ) {
                offenders.push(`${name}: writes a link without formatNamedHappyLink`);
            }
            if (/(?<!!)\[\]\(/u.test(source)) {
                offenders.push(`${name}: writes a link with empty link text`);
            }
            if (/formatHappyShareUrl|link\.happy\.page/u.test(source)) {
                offenders.push(`${name}: writes a share link`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
