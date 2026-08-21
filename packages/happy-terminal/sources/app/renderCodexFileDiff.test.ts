import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { CodexFileDiff } from "./CodexFileDiff.js";
import { renderCodexFileDiff } from "./renderCodexFileDiff.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderCodexFileDiff", () => {
    it("renders an edited JavaScript file with Codex line layout and syntax colors", () => {
        const diff: CodexFileDiff = {
            path: "src/greet.js",
            kind: "update",
            hunks: [
                {
                    oldStart: 1,
                    newStart: 1,
                    lines: [
                        { kind: "context", text: "export function greet(name) {" },
                        { kind: "delete", text: "  return `goodbye, ${name}`;" },
                        { kind: "add", text: "  return `hello, ${name}`;" },
                        { kind: "context", text: "}" },
                    ],
                },
            ],
        };

        const rendered = renderCodexFileDiff(diff);

        expect(rendered.map(stripAnsi)).toEqual([
            "• Edited src/greet.js (+1 -1)",
            "    1  export function greet(name) {",
            "    2 -  return `goodbye, ${name}`;",
            "    2 +  return `hello, ${name}`;",
            "    3  }",
        ]);
        expect(rendered[0]).toBe(
            "\x1b[2m• \x1b[22m\x1b[1mEdited\x1b[22m src/greet.js (\x1b[32m+1\x1b[39m \x1b[31m-1\x1b[39m)\x1b[0m",
        );

        const context = rendered[1] ?? "";
        expect(context).toContain("\x1b[38;2;148;226;213mexport\x1b[39m");
        expect(context).toContain("\x1b[38;2;137;180;250mgreet\x1b[39m");
        expect(context).toContain("\x1b[38;2;235;160;172mname\x1b[39m");
        expect(context).toContain("\x1b[38;2;147;153;178m(\x1b[39m");
        expect(context).toContain("\x1b[38;2;205;214;244m{\x1b[39m");

        const deleted = rendered[2] ?? "";
        expect(
            deleted.startsWith("\x1b[48;5;52m    \x1b[2m2 \x1b[22m\x1b[31m-\x1b[39m\x1b[2m"),
        ).toBe(true);
        expect(deleted).toContain("\x1b[38;2;166;227;161mgoodbye, \x1b[39m");
        expect(deleted).toContain("\x1b[38;2;203;166;247m${\x1b[39m");
        expect(deleted.endsWith("\x1b[0m")).toBe(true);

        const added = rendered[3] ?? "";
        expect(added.startsWith("\x1b[48;5;22m    \x1b[2m2 \x1b[22m\x1b[32m+\x1b[39m")).toBe(true);
        expect(added).toContain("\x1b[38;2;166;227;161mhello, \x1b[39m");
        expect(added).not.toContain("\x1b[39m\x1b[2m\x1b[38;2;205;214;244m  return");
        expect(added.endsWith("\x1b[0m")).toBe(true);
    });

    it("renders a whole-file addition with new line numbers and green backgrounds", () => {
        const diff: CodexFileDiff = {
            path: "src/new.ts",
            kind: "add",
            hunks: [
                {
                    oldStart: 0,
                    newStart: 1,
                    lines: [
                        { kind: "add", text: "const answer = 42;" },
                        { kind: "add", text: "export { answer };" },
                    ],
                },
            ],
        };

        const rendered = renderCodexFileDiff(diff);

        expect(rendered.map(stripAnsi)).toEqual([
            "• Added src/new.ts (+2 -0)",
            "    1 +const answer = 42;",
            "    2 +export { answer };",
        ]);
        expect(rendered.slice(1).every((line) => line.startsWith("\x1b[48;5;22m"))).toBe(true);
        expect(rendered.slice(1).every((line) => !line.includes("\x1b[48;5;52m"))).toBe(true);
    });

    it("renders a whole-file deletion with old line numbers and dimmed red rows", () => {
        const diff: CodexFileDiff = {
            path: "src/old.js",
            kind: "delete",
            hunks: [
                {
                    oldStart: 1,
                    newStart: 0,
                    lines: [
                        { kind: "delete", text: "const stale = true;" },
                        { kind: "delete", text: "export { stale };" },
                    ],
                },
            ],
        };

        const rendered = renderCodexFileDiff(diff);

        expect(rendered.map(stripAnsi)).toEqual([
            "• Deleted src/old.js (+0 -2)",
            "    1 -const stale = true;",
            "    2 -export { stale };",
        ]);
        expect(rendered.slice(1).every((line) => line.startsWith("\x1b[48;5;52m"))).toBe(true);
        expect(rendered.slice(1).every((line) => line.includes("\x1b[31m-\x1b[39m\x1b[2m"))).toBe(
            true,
        );
    });

    it("separates multiple hunks with a dim vertical ellipsis and keeps their line numbers", () => {
        const diff: CodexFileDiff = {
            path: "src/many.js",
            kind: "update",
            hunks: [
                {
                    oldStart: 2,
                    newStart: 2,
                    lines: [
                        { kind: "delete", text: "old();" },
                        { kind: "add", text: "first();" },
                    ],
                },
                {
                    oldStart: 20,
                    newStart: 20,
                    lines: [
                        { kind: "context", text: "if (ready) {" },
                        { kind: "add", text: "  second();" },
                    ],
                },
            ],
        };

        const rendered = renderCodexFileDiff(diff);

        expect(rendered.map(stripAnsi)).toEqual([
            "• Edited src/many.js (+2 -1)",
            "     2 -old();",
            "     2 +first();",
            "       ⋮",
            "    20  if (ready) {",
            "    21 +  second();",
        ]);
        expect(rendered[3]).toBe("       \x1b[2m⋮\x1b[22m\x1b[0m");
    });

    it("accepts a different ANSI-256 background palette", () => {
        const rendered = renderCodexFileDiff(
            {
                path: "theme.js",
                kind: "update",
                hunks: [
                    {
                        oldStart: 1,
                        newStart: 1,
                        lines: [
                            { kind: "delete", text: "dark();" },
                            { kind: "add", text: "light();" },
                        ],
                    },
                ],
            },
            {
                palette: {
                    addedBackground: 194,
                    argument: "\x1b[35m",
                    comment: "\x1b[90m",
                    deletedBackground: 224,
                    function: "\x1b[34m",
                    keyword: "\x1b[35m",
                    primary: "\x1b[39m",
                    punctuation: "\x1b[90m",
                    storage: "\x1b[36m",
                    string: "\x1b[32m",
                },
            },
        );

        expect(rendered[1]).toContain("\x1b[48;5;224m");
        expect(rendered[2]).toContain("\x1b[48;5;194m");
        expect(rendered.join("\n")).not.toContain("\x1b[48;5;22m");
        expect(rendered.join("\n")).not.toContain("\x1b[48;5;52m");
    });

    it("sanitizes tool-controlled paths and lines, respects width, and caps large diffs", () => {
        const rendered = renderCodexFileDiff(
            {
                path: "src/unsafe\x1b]8;;https://example.com\x07.ts\nforged",
                kind: "add",
                hunks: [
                    {
                        oldStart: 0,
                        newStart: 1,
                        lines: Array.from({ length: 12 }, (_, index) => ({
                            kind: "add" as const,
                            text: `const unsafe${index} = "value";\x1b]8;;https://example.com\x07`,
                        })),
                    },
                ],
            },
            { maxRows: 4, width: 32 },
        );

        expect(rendered.map(stripAnsi)).toHaveLength(5);
        expect(rendered.map(stripAnsi).at(-1)).toContain("9 more lines");
        expect(rendered.join("\n")).not.toContain("]8;;");
        expect(rendered.every((line) => stripAnsi(line).length <= 32)).toBe(true);
    });

    it("keeps every tiny-width row visible instead of emitting whitespace-only diff bodies", () => {
        const diff: CodexFileDiff = {
            path: "src/tiny.ts",
            kind: "update",
            hunks: [
                {
                    oldStart: 1,
                    newStart: 1,
                    lines: [
                        { kind: "delete", text: "old();" },
                        { kind: "add", text: "next();" },
                    ],
                },
            ],
        };

        for (const width of [1, 2, 3, 4]) {
            const rendered = renderCodexFileDiff(diff, { width });
            expect(rendered).toHaveLength(1);
            expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(rendered.every((line) => stripAnsi(line).trim().length > 0)).toBe(true);
        }
    });

    it("reads and renders text only for rows inside the large-diff budget", () => {
        let textReads = 0;
        const lines = Array.from({ length: 300_000 }, (_, index) => ({
            kind: "add" as const,
            get text() {
                textReads += 1;
                return `const value${index} = ${index};`;
            },
        }));

        const rendered = renderCodexFileDiff(
            {
                path: "generated/large.ts",
                kind: "add",
                hunks: [{ oldStart: 0, newStart: 1, lines }],
            },
            { maxRows: 8, width: 80 },
        );

        expect(rendered).toHaveLength(9);
        expect(rendered.map(stripAnsi).at(-1)).toContain("299993 more lines");
        expect(textReads).toBe(7);
    });

    it("renders exact totals and persisted omission counts from a bounded diff", () => {
        const rendered = renderCodexFileDiff(
            {
                added: 0,
                deleted: 750,
                hunks: [
                    {
                        oldStart: 1,
                        newStart: 0,
                        lines: Array.from({ length: 500 }, (_, index) => ({
                            kind: "delete" as const,
                            text: `deleted ${index + 1}`,
                        })),
                    },
                ],
                kind: "delete",
                omittedLines: 250,
                path: "generated.txt",
            },
            { maxRows: 501 },
        );

        expect(stripAnsi(rendered[0] ?? "")).toBe("• Deleted generated.txt (+0 -750)");
        expect(rendered).toHaveLength(502);
        expect(stripAnsi(rendered.at(-1) ?? "")).toContain("250 more lines");
    });

    it("keeps embedded line separators inside one sanitized diff row", () => {
        const rendered = renderCodexFileDiff({
            path: "src/injected.ts",
            kind: "add",
            hunks: [
                {
                    oldStart: 0,
                    newStart: 1,
                    lines: [
                        {
                            kind: "add",
                            text: "const first = 1;\nforged row\u2028another row\u2029last row",
                        },
                    ],
                },
            ],
        });

        expect(rendered).toHaveLength(2);
        expect(stripAnsi(rendered[1] ?? "")).toBe(
            "    1 +const first = 1; forged row another row last row",
        );
        expect(rendered[1]).not.toMatch(/[\n\u2028\u2029]/u);
    });
});
