import { describe, expect, it } from "vitest";

import {
    formatClaudeContextBudget,
    readClaudeContextBudget,
} from "@/vendors/claudeAgent/impl/claudeContextBudget.js";

const report = (categories: unknown[], overrides = {}) => ({
    categories,
    totalTokens: 0,
    rawMaxTokens: 1_000_000,
    maxTokens: 1_000_000,
    ...overrides,
});
const used = (id: string, tokens: number) => ({ id, tokens, kind: "used" });

describe("native assembled context budget", () => {
    it("rejects history that fits alone when instructions and tools fill the request", () => {
        const budget = readClaudeContextBudget(
            report(
                [
                    used("messages", 611_394),
                    used("system_prompt", 100_000),
                    used("system_tools", 400_363),
                    { id: "compact_buffer", tokens: 20_000, kind: "buffer" },
                ],
                { totalTokens: 1_111_757 },
            ),
        );
        expect(budget).toMatchObject({
            inputTokens: 1_111_757,
            messageTokens: 611_394,
            fixedTokens: 500_363,
            reserveTokens: 20_000,
            usableTokens: 980_000,
            fits: false,
            fixedFits: true,
        });
    });

    it("distinguishes fixed context that no conversation summary can repair", () => {
        expect(
            readClaudeContextBudget(
                report([used("messages", 100), used("system_tools", 1_010_000)]),
            ),
        ).toMatchObject({ fits: false, fixedFits: false });
    });

    it("excludes deferred schemas and free space, and reserves native output/compaction space once", () => {
        expect(
            readClaudeContextBudget(
                report(
                    [
                        used("messages", 900),
                        used("system_prompt", 40),
                        { id: "mcp_tools_deferred", tokens: 999_999, kind: "deferred" },
                        { id: "free_space", tokens: 10_000, kind: "free" },
                        { id: "compact_buffer", tokens: 60, kind: "buffer" },
                    ],
                    { maxTokens: 1_000, rawMaxTokens: 1_060, totalTokens: 940 },
                ),
            ),
        ).toMatchObject({
            inputTokens: 940,
            reserveTokens: 60,
            usableTokens: 1_000,
            fits: true,
        });
    });

    it("retains an unexplained native total instead of subtracting reserve from real input", () => {
        expect(
            readClaudeContextBudget(
                report(
                    [used("messages", 700), { id: "compact_buffer", tokens: 100, kind: "buffer" }],
                    { totalTokens: 900 },
                ),
            ),
        ).toMatchObject({ inputTokens: 900, reserveTokens: 100 });
    });

    it("keeps message attachment and tool subtotals redacted without counting them twice", () => {
        const budget = readClaudeContextBudget({
            ...report([used("messages", 100)]),
            messageBreakdown: {
                toolCallTokens: 20,
                toolResultTokens: 30,
                attachmentTokens: 40,
                assistantMessageTokens: 5,
                userMessageTokens: 5,
                redirectedContextTokens: 0,
                unattributedTokens: 0,
                attachmentsByType: [{ name: "/private/file", tokens: 40 }],
            },
        });
        expect(budget.inputTokens).toBe(100);
        expect(formatClaudeContextBudget(budget)).toContain("attachmentTokens=40");
        expect(JSON.stringify(budget)).not.toContain("/private/file");
    });

    it("uses numeric categories only, and never logs paths, tool names or prompt text", () => {
        const budget = readClaudeContextBudget({
            ...report([
                { ...used("messages", 100), name: "secret prompt" },
                { ...used("future_category", 25), name: "private account" },
            ]),
            memoryFiles: [{ path: "/secret/project", tokens: 999 }],
            mcpTools: [{ name: "secret_tool", serverName: "private", tokens: 999 }],
        });
        const formatted = formatClaudeContextBudget(budget);
        expect(formatted).toContain("messages=100");
        expect(formatted).toContain("other=25");
        expect(formatted).not.toMatch(/secret|private|project/);
    });

    it.each([NaN, Infinity, -1, 1.5])("refuses invalid native counts (%s)", (tokens) => {
        expect(() => readClaudeContextBudget(report([used("messages", tokens)]))).toThrow(
            "valid context budget",
        );
    });

    it("does not mistake an unlabeled legacy used category for known fixed context", () => {
        expect(readClaudeContextBudget(report([{ tokens: 100, kind: "used" }]))).toMatchObject({
            inputTokens: 100,
            messageTokens: 0,
            fixedTokens: 0,
            unattributedTokens: 100,
        });
    });
});
