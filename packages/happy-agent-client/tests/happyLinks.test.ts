import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    escapeMarkdownText,
    formatHappyFileUrl,
    formatHappyMarkdownLink,
    formatHappyReferenceUrl,
    formatHappyUrl,
    happyFileLinkSchema,
    happyReferencePlaceholder,
    isHappyUrl,
    isKnownHappyReferenceKind,
    MAX_HAPPY_URL_LENGTH,
    parseHappyUrl,
    type HappyFileLink,
    type HappyLink,
    type HappyReference,
} from "../sources/index.js";

const ID = "rg799k2m9q4w1e5t8y3u6i0o";
const AGENT = "a1b2c3d4";
const WORKSPACE = "k2h4j5l6";

describe("entity URLs", () => {
    it.each([
        ["artifact", `happy://artifacts/${ID}`],
        ["agent", `happy://agents/${ID}`],
        ["workspace", `happy://workspaces/${ID}`],
        ["project", `happy://projects/${ID}`],
        ["surface", `happy://surfaces/${ID}`],
        ["user", `happy://users/${ID}`],
    ] as const)("parses and formats a %s", (kind, url) => {
        expect(parseHappyUrl(url)).toEqual({ type: "reference", reference: { kind, id: ID } });
        expect(formatHappyReferenceUrl({ kind, id: ID })).toBe(url);
        expect(isKnownHappyReferenceKind(kind)).toBe(true);
    });

    it("carries an artifact version and a service's workspace", () => {
        const links: [HappyReference, string][] = [
            [{ kind: "artifact", id: ID, version: 12 }, `happy://artifacts/${ID}?version=12`],
            [
                { kind: "service", id: "web", workspaceId: WORKSPACE },
                `happy://workspaces/${WORKSPACE}/services/web`,
            ],
        ];
        for (const [reference, url] of links) {
            expect(formatHappyReferenceUrl(reference)).toBe(url);
            expect(formatHappyUrl({ type: "reference", reference })).toBe(url);
            expect(parseHappyUrl(url)).toEqual({ type: "reference", reference });
        }
    });

    it.each([
        ["a mobile session link", "happy://session/abc"],
        ["a mobile terminal link", "happy://terminal?MDEyMzQ1Njc4OWFiY2RlZg"],
        ["a singular host", `happy://artifact/${ID}`],
        ["an unknown host", `happy://things/${ID}`],
        ["an uppercase scheme", `HAPPY://artifacts/${ID}`],
        ["an uppercase host", `happy://Artifacts/${ID}`],
        ["a missing id", "happy://artifacts/"],
        ["a trailing slash", `happy://artifacts/${ID}/`],
        ["an id with a dot", "happy://artifacts/a.b"],
        ["a long id", `happy://artifacts/${"a".repeat(129)}`],
        ["a version on an agent", `happy://agents/${ID}?version=2`],
        ["a zero version", `happy://artifacts/${ID}?version=0`],
        ["a leading-zero version", `happy://artifacts/${ID}?version=02`],
        ["another query", `happy://artifacts/${ID}?v=2`],
        ["an extra query", `happy://artifacts/${ID}?version=2&x=1`],
        ["a fragment", `happy://artifacts/${ID}#top`],
        ["a service outside a workspace", `happy://services/${ID}`],
        ["a service under an agent", `happy://agents/${AGENT}/services/web`],
        ["a deeper path", `happy://projects/${ID}/settings`],
        ["no slashes", `happy:artifacts/${ID}`],
        ["surrounding space", ` happy://artifacts/${ID}`],
    ])("rejects %s", (_name, url) => {
        expect(parseHappyUrl(url)).toBeUndefined();
    });

    it.each([
        ["a bad id", { kind: "artifact", id: 'a"b' }],
        ["an unknown kind", { kind: "Artifact", id: "a" }],
        ["a version on an agent", { kind: "agent", id: "a", version: 2 }],
        ["a workspace on an artifact", { kind: "artifact", id: "a", workspaceId: "w" }],
        ["a service without its workspace", { kind: "service", id: "s" }],
        ["an extra field", { kind: "artifact", id: "a", title: "x" }],
    ])("refuses to format %s", (_name, reference) => {
        expect(() => formatHappyReferenceUrl(reference as HappyReference)).toThrow(TypeError);
    });
});

describe("file URLs", () => {
    it("parses both targets, with and without lines", () => {
        expect(parseHappyUrl(`happy://agents/${AGENT}/files/packages/app/Foo.tsx#L42-L50`)).toEqual(
            {
                type: "file",
                file: {
                    target: { type: "agent", agentId: AGENT },
                    path: "packages/app/Foo.tsx",
                    lines: { start: 42, end: 50 },
                },
            },
        );
        expect(parseHappyUrl(`happy://workspaces/${WORKSPACE}/files/README.md`)).toEqual({
            type: "file",
            file: { target: { type: "workspace", workspaceId: WORKSPACE }, path: "README.md" },
        });
        expect(filePath(`happy://agents/${AGENT}/files/files/a.ts`)).toBe("files/a.ts");
        expect(fileOf(`happy://agents/${AGENT}/files/a.ts#L7`)?.lines).toEqual({
            start: 7,
            end: 7,
        });
        expect(fileOf(`happy://agents/${AGENT}/files/a.ts#L7-L7`)?.lines).toEqual({
            start: 7,
            end: 7,
        });
    });

    it("decodes each segment as UTF-8, in either hex case", () => {
        expect(filePath(`happy://agents/${AGENT}/files/docs/R%C3%A9sum%c3%a9%20%281%29.md`)).toBe(
            "docs/Résumé (1).md",
        );
        expect(filePath(`happy://agents/${AGENT}/files/a:b@c!$&'*+,;=~.ts`)).toBe(
            "a:b@c!$&'*+,;=~.ts",
        );
        expect(filePath(`happy://agents/${AGENT}/files/%2E%2E.ts`)).toBe("...ts");
        expect(filePath(`happy://agents/${AGENT}/files/.env`)).toBe(".env");
    });

    it.each([
        ["an unknown target", `happy://projects/${AGENT}/files/a.ts`],
        ["a missing files segment", `happy://agents/${AGENT}/a.ts`],
        ["no path", `happy://agents/${AGENT}/files`],
        ["an empty path", `happy://agents/${AGENT}/files/`],
        ["a leading slash", `happy://agents/${AGENT}/files//a.ts`],
        ["a trailing slash", `happy://agents/${AGENT}/files/src/`],
        ["an empty segment", `happy://agents/${AGENT}/files/src//a.ts`],
        ["a dot segment", `happy://agents/${AGENT}/files/./a.ts`],
        ["a parent segment", `happy://agents/${AGENT}/files/src/../a.ts`],
        ["an encoded parent segment", `happy://agents/${AGENT}/files/%2e%2E/a.ts`],
        ["an encoded slash", `happy://agents/${AGENT}/files/src%2Fa.ts`],
        ["an encoded backslash", `happy://agents/${AGENT}/files/src%5Ca.ts`],
        ["an encoded control character", `happy://agents/${AGENT}/files/a%0A.ts`],
        ["an encoded C1 control character", `happy://agents/${AGENT}/files/a%C2%85.ts`],
        ["an encoded NUL", `happy://agents/${AGENT}/files/a%00.ts`],
        ["a stray percent", `happy://agents/${AGENT}/files/100%.ts`],
        ["a short escape", `happy://agents/${AGENT}/files/a%4.ts`],
        ["invalid UTF-8", `happy://agents/${AGENT}/files/a%C3.ts`],
        ["an encoded surrogate", `happy://agents/${AGENT}/files/a%ED%A0%80.ts`],
        ["a raw space", `happy://agents/${AGENT}/files/a b.ts`],
        ["raw parentheses", `happy://agents/${AGENT}/files/a(1).ts`],
        ["a raw non-ASCII character", `happy://agents/${AGENT}/files/é.ts`],
        ["a raw backslash", `happy://agents/${AGENT}/files/a\\b.ts`],
        ["a query", `happy://agents/${AGENT}/files/a.ts?raw=1`],
        ["an empty fragment", `happy://agents/${AGENT}/files/a.ts#`],
        ["a lowercase line marker", `happy://agents/${AGENT}/files/a.ts#l4`],
        ["a line zero", `happy://agents/${AGENT}/files/a.ts#L0`],
        ["a leading zero", `happy://agents/${AGENT}/files/a.ts#L04`],
        ["ten digits", `happy://agents/${AGENT}/files/a.ts#L1000000000`],
        ["an end before the start", `happy://agents/${AGENT}/files/a.ts#L9-L4`],
        ["a range without the second L", `happy://agents/${AGENT}/files/a.ts#L4-9`],
        ["a column", `happy://agents/${AGENT}/files/a.ts#L4C2`],
        ["another fragment", `happy://agents/${AGENT}/files/a.ts#readme`],
        ["two fragments", `happy://agents/${AGENT}/files/a.ts#L1#L2`],
    ])("rejects %s", (_name, url) => {
        expect(parseHappyUrl(url)).toBeUndefined();
    });

    it("bounds the whole URL", () => {
        const prefix = `happy://agents/${AGENT}/files/`;
        const longest = `${prefix}${"a".repeat(MAX_HAPPY_URL_LENGTH - prefix.length)}`;
        expect(filePath(longest)).toHaveLength(longest.length - prefix.length);
        expect(parseHappyUrl(`${longest}a`)).toBeUndefined();
    });

    it("writes the canonical URL that parses back to the same value", () => {
        const links: [HappyFileLink, string][] = [
            [
                {
                    target: { type: "agent", agentId: AGENT },
                    path: "packages/app/Foo.tsx",
                    lines: { start: 42, end: 50 },
                },
                `happy://agents/${AGENT}/files/packages/app/Foo.tsx#L42-L50`,
            ],
            [
                {
                    target: { type: "workspace", workspaceId: WORKSPACE },
                    path: "README.md",
                    lines: { start: 3, end: 3 },
                },
                `happy://workspaces/${WORKSPACE}/files/README.md#L3`,
            ],
            [
                { target: { type: "agent", agentId: AGENT }, path: "docs/Résumé (1) [old]:#?%.md" },
                `happy://agents/${AGENT}/files/docs/R%C3%A9sum%C3%A9%20%281%29%20%5Bold%5D%3A%23%3F%25.md`,
            ],
            [
                { target: { type: "agent", agentId: AGENT }, path: "it's*!~_-.ts" },
                `happy://agents/${AGENT}/files/it%27s%2A%21~_-.ts`,
            ],
        ];
        for (const [file, url] of links) {
            expect(formatHappyFileUrl(file)).toBe(url);
            expect(formatHappyUrl({ type: "file", file })).toBe(url);
            expect(parseHappyUrl(url)).toEqual({ type: "file", file });
            expect(Value.Check(happyFileLinkSchema, file)).toBe(true);
        }
    });

    it.each([
        ["an absolute path", { target: { type: "agent", agentId: AGENT }, path: "/etc/hosts" }],
        ["an empty path", { target: { type: "agent", agentId: AGENT }, path: "" }],
        ["a parent segment", { target: { type: "agent", agentId: AGENT }, path: "a/../b" }],
        ["a dot segment", { target: { type: "agent", agentId: AGENT }, path: "./b" }],
        ["a backslash", { target: { type: "agent", agentId: AGENT }, path: "a\\b" }],
        ["a newline", { target: { type: "agent", agentId: AGENT }, path: "a\nb" }],
        ["a lone surrogate", { target: { type: "agent", agentId: AGENT }, path: "a\ud800" }],
        ["a bad id", { target: { type: "agent", agentId: "a/b" }, path: "a" }],
        [
            "a reversed range",
            { target: { type: "agent", agentId: AGENT }, path: "a", lines: { start: 2, end: 1 } },
        ],
        [
            "line zero",
            { target: { type: "agent", agentId: AGENT }, path: "a", lines: { start: 0, end: 1 } },
        ],
        [
            "a fractional line",
            { target: { type: "agent", agentId: AGENT }, path: "a", lines: { start: 1.5, end: 2 } },
        ],
        ["an unknown target", { target: { type: "project", projectId: AGENT }, path: "a" }],
        ["an extra field", { target: { type: "agent", agentId: AGENT }, path: "a", title: "x" }],
        [
            "a path too long once encoded",
            { target: { type: "agent", agentId: AGENT }, path: "é".repeat(1000) },
        ],
    ])("refuses to format %s", (_name, file) => {
        expect(() => formatHappyFileUrl(file as HappyFileLink)).toThrow(TypeError);
    });
});

describe("happy-file URLs", () => {
    it("read onto the same model as happy:// file URLs", () => {
        expect(parseHappyUrl(`happy-file://agents/${AGENT}/packages/app/Foo.tsx#L42-L50`)).toEqual(
            parseHappyUrl(`happy://agents/${AGENT}/files/packages/app/Foo.tsx#L42-L50`),
        );
        expect(filePath(`happy-file://workspaces/${WORKSPACE}/docs/R%C3%A9sum%C3%A9.md`)).toBe(
            "docs/Résumé.md",
        );
    });

    it("are written with the happy-file scheme", () => {
        const file: HappyFileLink = {
            target: { type: "agent", agentId: AGENT },
            path: "docs/Résumé (1).md",
            lines: { start: 4, end: 9 },
        };
        const url = `happy-file://agents/${AGENT}/docs/R%C3%A9sum%C3%A9%20%281%29.md#L4-L9`;
        expect(formatHappyFileUrl(file, "happy-file")).toBe(url);
        expect(formatHappyFileUrl(file, "happy")).toBe(formatHappyFileUrl(file));
        expect(parseHappyUrl(url)).toEqual({ type: "file", file });
        const prefix = `happy-file://agents/${AGENT}/`;
        const longest = {
            target: file.target,
            path: "a".repeat(MAX_HAPPY_URL_LENGTH - prefix.length),
        };
        expect(formatHappyFileUrl(longest, "happy-file")).toHaveLength(MAX_HAPPY_URL_LENGTH);
        expect(() =>
            formatHappyFileUrl({ ...longest, path: `${longest.path}a` }, "happy-file"),
        ).toThrow(TypeError);
    });

    it.each([
        ["an uppercase scheme", `HAPPY-FILE://agents/${AGENT}/a.ts`],
        ["a singular target", `happy-file://agent/${AGENT}/a.ts`],
        ["an unknown target", `happy-file://projects/${AGENT}/a.ts`],
        ["no path", `happy-file://agents/${AGENT}`],
        ["a trailing slash", `happy-file://agents/${AGENT}/src/`],
        ["a parent segment", `happy-file://agents/${AGENT}/src/../a.ts`],
        ["an encoded slash", `happy-file://agents/${AGENT}/src%2Fa.ts`],
        ["a query", `happy-file://agents/${AGENT}/a.ts?raw=1`],
        ["another fragment", `happy-file://agents/${AGENT}/a.ts#readme`],
        ["an entity", `happy-file://artifacts/${ID}`],
    ])("rejects %s", (_name, url) => {
        expect(parseHappyUrl(url)).toBeUndefined();
    });
});

describe("isHappyUrl", () => {
    it("claims every happy and happy-file URL, well-formed or not, in any case", () => {
        for (const url of [
            `happy://artifacts/${ID}`,
            "happy://session/abc",
            "HAPPY:anything",
            `Happy-File://agents/${AGENT}/a.ts`,
        ]) {
            expect(isHappyUrl(url)).toBe(true);
        }
        for (const url of ["https://happy.engineering", "happyx://a", "mailto:happy@x.y"]) {
            expect(isHappyUrl(url)).toBe(false);
        }
    });
});

describe("formatHappyMarkdownLink", () => {
    it("writes a ready-to-paste link with an escaped label", () => {
        expect(
            formatHappyMarkdownLink(
                { type: "reference", reference: { kind: "artifact", id: ID } },
                "Q3 *revenue* [draft]",
            ),
        ).toBe(`[Q3 \\*revenue\\* \\[draft\\]](happy://artifacts/${ID})`);
        expect(
            formatHappyMarkdownLink({ type: "reference", reference: { kind: "agent", id: ID } }),
        ).toBe(`[](happy://agents/${ID})`);
        expect(
            formatHappyMarkdownLink(
                {
                    type: "file",
                    file: {
                        target: { type: "agent", agentId: AGENT },
                        path: "a b.ts",
                        lines: { start: 4, end: 4 },
                    },
                },
                "a b.ts:4",
            ),
        ).toBe(`[a b.ts:4](happy://agents/${AGENT}/files/a%20b.ts#L4)`);
    });
});

describe("labels", () => {
    it("escapes labels onto one line and names unavailable entities", () => {
        expect(escapeMarkdownText("a\n\n b_c")).toBe("a b\\_c");
        expect(happyReferencePlaceholder({ kind: "service", id: "s" })).toBe(
            "an unavailable service",
        );
        expect(happyReferencePlaceholder({ kind: "surface", id: "s" })).toBe(
            "an unavailable surface",
        );
        expect(isKnownHappyReferenceKind("future-thing")).toBe(false);
    });
});

function fileOf(url: string): HappyFileLink | undefined {
    const link: HappyLink | undefined = parseHappyUrl(url);
    return link?.type === "file" ? link.file : undefined;
}

function filePath(url: string): string | undefined {
    return fileOf(url)?.path;
}
