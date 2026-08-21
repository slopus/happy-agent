import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import type { CodexMcpToolCall } from "./CodexMcpToolCall.js";
import { renderCodexMcpToolCall } from "./renderCodexMcpToolCall.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderCodexMcpToolCall", () => {
    it("renders a short successful invocation inline with compact arguments and Codex styles", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: {
                    server: "node_repl",
                    tool: "js",
                    arguments: { title: "List tabs", timeout_ms: 30_000 },
                },
                result: "{ ready: true }",
                status: "success",
            },
            { width: 100 },
        );

        expect(rendered.map(stripAnsi)).toEqual([
            '• Called node_repl.js({"title":"List tabs","timeout_ms":30000})',
            "  └ { ready: true }",
        ]);
        expect(rendered[0]).toContain("\x1b[32m\x1b[1m•\x1b[22m\x1b[39m");
        expect(rendered[0]).toContain("\x1b[1mCalled\x1b[22m");
        expect(rendered[0]).toContain("\x1b[36mnode_repl\x1b[39m.\x1b[36mjs\x1b[39m(");
        expect(rendered[0]).toContain('\x1b[2m{"title":"List tabs","timeout_ms":30000}\x1b[22m');
        expect(rendered[1]).toBe("  \x1b[2m└\x1b[22m \x1b[2m{ ready: true }\x1b[22m");
    });

    it("renders one child marker for a successful empty result", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: { server: "service", tool: "fast_empty", arguments: {} },
                result: "(empty result)",
                status: "success",
            },
            { width: 80 },
        ).map(stripAnsi);

        expect(rendered).toEqual(["• Called service.fast_empty({})", "  └ (empty result)"]);
        expect(rendered.filter((line) => line.includes("└"))).toHaveLength(1);
    });

    it("moves a long invocation below the header and bounds multiline structured output", () => {
        const call: CodexMcpToolCall = {
            invocation: {
                server: "node_repl",
                tool: "js",
                arguments: {
                    title: "Final one-click agent creation",
                    timeout_ms: 60_000,
                    code: "nodeRepl.write({ dialogs: [0, 0], agent: 1 })",
                },
            },
            result: "{\n  dialogs: [ 0, 0 ],\n  topic: 'workspace',\n  agent: 1\n}",
            status: "success",
        };
        const rendered = renderCodexMcpToolCall(call, { width: 48 });
        const plain = rendered.map(stripAnsi);
        const resultStart = plain.indexOf("    {");

        expect(plain[0]).toBe("• Called");
        expect(plain[1]).toMatch(/^  └ node_repl\.js\(/u);
        expect(plain.slice(2, resultStart).every((line) => line.startsWith("    "))).toBe(true);
        expect(plain.slice(resultStart)).toEqual([
            "    {",
            "      dialogs: [ 0, 0 ],",
            "      topic: 'workspace',",
            "      agent: 1...",
        ]);
        expect(rendered.every((line) => visibleWidth(line) <= 48)).toBe(true);
        expect(plain.filter((line) => line.includes("└"))).toHaveLength(1);
        expect(plain.join("\n")).not.toMatch(/[│├↳]/u);
    });

    it("uses a red completed bullet for failures without changing Called to Failed", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: { server: "search", tool: "find_docs", arguments: { query: "TUI" } },
                result: "Error: network timeout",
                status: "error",
            },
            { width: 80 },
        );

        expect(rendered.map(stripAnsi)).toEqual([
            '• Called search.find_docs({"query":"TUI"})',
            "  └ Error: network timeout",
        ]);
        expect(rendered[0]).toContain("\x1b[31m\x1b[1m•\x1b[22m\x1b[39m");
        expect(rendered.join("\n")).not.toContain("Failed");
    });

    it("renders active calls as Calling and accepts a theme palette", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: { server: "metrics", tool: "summary", arguments: {} },
                status: "active",
            },
            {
                width: 80,
                palette: {
                    accent: "\x1b[38;5;81m",
                    error: "\x1b[38;5;196m",
                    primary: "\x1b[38;5;252m",
                    success: "\x1b[38;5;82m",
                },
            },
        );

        expect(rendered.map(stripAnsi)).toEqual(["◦ Calling metrics.summary({})"]);
        expect(rendered[0]?.startsWith("\x1b[38;5;252m\x1b[2m◦")).toBe(true);
        expect(rendered[0]).toContain("\x1b[38;5;81mmetrics\x1b[38;5;252m");
    });

    it("restores a configured primary color and never exceeds tiny widths", () => {
        const call: CodexMcpToolCall = {
            invocation: { server: "tiny", tool: "echo", arguments: { value: "\u0085unsafe" } },
            result: "done",
            status: "success",
        };
        const palette = {
            accent: "\x1b[38;5;81m",
            error: "\x1b[38;5;196m",
            primary: "\x1b[38;5;252m",
            success: "\x1b[38;5;82m",
        };

        const wide = renderCodexMcpToolCall(call, { palette, width: 80 });
        expect(wide[0]).toContain("\x1b[38;5;81mtiny\x1b[38;5;252m");
        expect(wide.join("\n")).not.toContain("\u0085");
        for (let width = 1; width < 9; width += 1) {
            const narrow = renderCodexMcpToolCall(call, { palette, width });
            expect(narrow.every((line) => visibleWidth(line) <= width)).toBe(true);
            expect(narrow.length).toBeLessThanOrEqual(width < 5 ? 1 : 7);
            expect(narrow.every((line) => stripAnsi(line).trim().length > 0)).toBe(true);
        }
    });

    it("budgets approval review separately so it cannot hide the actual result", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: { server: "issues", tool: "close_ticket", arguments: { issue: 42 } },
                review: "Needs approval because this mutates an external issue and must remain visible without consuming the result budget.",
                result: "ACTUAL_RESULT",
                status: "success",
            },
            { maxReviewRows: 2, maxResultRows: 1, width: 40 },
        ).map(stripAnsi);

        expect(rendered).toContain("    ACTUAL_RESULT");
        expect(
            rendered.filter((line) => line.includes("approval") || line.includes("because")).length,
        ).toBeLessThanOrEqual(2);
        expect(rendered.filter((line) => line.includes("└"))).toHaveLength(1);
        expect(rendered.join("\n")).not.toMatch(/[│├↳]/u);
    });

    it("sanitizes tool-controlled text and bounds wrapped result rows", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: {
                    server: "unsafe\x1b]8;;https://example.com\x07",
                    tool: "echo",
                    arguments: {},
                },
                result: [
                    "first\nsecond\nthird\nfourth\nfifth",
                    "\x1b]8;;https://example.com\x07forged link\x1b]8;;\x07",
                ],
                status: "success",
            },
            { maxResultRows: 3, width: 40 },
        );
        const plain = rendered.map(stripAnsi);

        expect(plain).toEqual([
            "• Called unsafe.echo({})",
            "  └ first",
            "    second",
            "    third...",
        ]);
        expect(rendered.join("\n")).not.toContain("]8;;");
    });

    it("shows at most four result rows by default", () => {
        const rendered = renderCodexMcpToolCall(
            {
                invocation: { server: "search", tool: "find_docs", arguments: {} },
                result: "first\nsecond\nthird\nfourth\nfifth",
                status: "success",
            },
            { width: 40 },
        ).map(stripAnsi);

        expect(rendered.slice(1)).toEqual([
            "  └ first",
            "    second",
            "    third",
            "    fourth...",
        ]);
    });

    it("bounds large invocation and result payloads before serialization and wrapping", async () => {
        const payloadCharacters = 5_000_000;
        const maximumElapsedMilliseconds = 500;
        const largeArguments = `ARGUMENT_START_${"a".repeat(payloadCharacters)}_ARGUMENT_END`;
        const largeResult = `RESULT_START_${"r".repeat(payloadCharacters)}_RESULT_END`;
        const startedAt = performance.now();
        const rendered = renderCodexMcpToolCall(
            {
                invocation: {
                    server: "large_payload",
                    tool: "echo",
                    arguments: { payload: largeArguments },
                },
                result: largeResult,
                status: "success",
            },
            { width: 80 },
        );
        const elapsedMilliseconds = performance.now() - startedAt;
        const plain = rendered.map(stripAnsi);

        expect(elapsedMilliseconds).toBeLessThan(maximumElapsedMilliseconds);
        expect(rendered.length).toBeLessThanOrEqual(20);
        expect(plain.join("\n")).toContain("ARGUMENT_START_");
        expect(plain.join("\n")).toContain("RESULT_START_");
        expect(plain.join("\n")).toContain("[truncated]");
        expect(plain.join("\n")).not.toContain("ARGUMENT_END");
        expect(plain.join("\n")).not.toContain("RESULT_END");

        const proofPath = process.env.HAPPY_TERMINAL_MCP_RENDER_PROOF_PATH;
        if (proofPath !== undefined) {
            await mkdir(dirname(proofPath), { recursive: true });
            await writeFile(
                proofPath,
                `${JSON.stringify(
                    {
                        argumentCharacters: largeArguments.length,
                        elapsedMilliseconds: Math.round(elapsedMilliseconds * 100) / 100,
                        maximumElapsedMilliseconds,
                        renderedRows: rendered.length,
                        resultCharacters: largeResult.length,
                        rows: plain,
                    },
                    null,
                    2,
                )}\n`,
            );
        }
    });
});
