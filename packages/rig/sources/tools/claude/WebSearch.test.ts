import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { createClaudeWebSearchTool } from "../../agent/tools/claude/WebSearch.js";
import { modelAnthropicFable5, modelAnthropicSonnet5 } from "@slopus/rig-execution";
import type { Model } from "@slopus/rig-execution";

describe("Claude Code WebSearch tool", () => {
    it("declares that network access requires Auto or Full access", () => {
        const tool = createClaudeWebSearchTool();

        expect(tool.requiresAutoOrFullAccess).toBe(true);
    });

    it("runs a search and formats links for the model", async () => {
        const search = vi.fn().mockResolvedValue({
            query: "current docs 2026",
            results: [
                {
                    tool_use_id: "search-1",
                    content: [{ title: "Current docs", url: "https://example.com/docs" }],
                },
                "The current documentation is available.",
            ],
            durationSeconds: 0.5,
        });
        const tool = createClaudeWebSearchTool({ search });
        const harness = createJustBashToolHarness();

        const result = await tool.execute(
            {
                query: "current docs 2026",
                allowed_domains: ["example.com"],
            },
            harness.context,
            {
                model: modelAnthropicFable5,
                provider: providerWithModels([modelAnthropicFable5, modelAnthropicSonnet5]),
            },
        );

        expect(search).toHaveBeenCalledWith(
            {
                query: "current docs 2026",
                allowed_domains: ["example.com"],
            },
            expect.objectContaining({ id: "work-claude" }),
            modelAnthropicSonnet5,
            undefined,
        );
        expect(tool.toLLM(result)[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining(
                'Links: [{"title":"Current docs","url":"https://example.com/docs"}]',
            ),
        });
        expect(tool.toLLM(result)[0]).toMatchObject({
            text: expect.stringContaining("MUST include the sources above"),
        });
    });

    it("validates mutually exclusive domain filters", async () => {
        const search = vi.fn();
        const tool = createClaudeWebSearchTool({ search });
        const harness = createJustBashToolHarness();

        await expect(
            harness.runTool(tool, {
                query: "current docs 2026",
                allowed_domains: ["example.com"],
                blocked_domains: ["example.org"],
            }),
        ).rejects.toThrow(/Cannot specify both allowed_domains and blocked_domains/);
        expect(search).not.toHaveBeenCalled();
    });

    it("allows empty domain filters", async () => {
        const search = vi.fn().mockResolvedValue({
            query: "current docs 2026",
            results: [],
            durationSeconds: 0,
        });
        const tool = createClaudeWebSearchTool({ search });
        const harness = createJustBashToolHarness();

        await expect(
            tool.execute(
                {
                    query: "current docs 2026",
                    allowed_domains: [],
                    blocked_domains: [],
                },
                harness.context,
                {
                    model: modelAnthropicFable5,
                    provider: providerWithModels([modelAnthropicFable5]),
                },
            ),
        ).resolves.toMatchObject({ query: "current docs 2026" });
    });

    // Claude Code forces the helper to call its search. This transport is the Agent SDK, which
    // has no way to force a tool choice, so the guarantee is kept at the other end: a helper that
    // answered from memory produced no search, and saying otherwise would cite pages that were
    // never consulted.
    it("refuses to report a search the helper never performed", async () => {
        const tool = createClaudeWebSearchTool();
        const harness = createJustBashToolHarness();

        await expect(
            tool.execute({ query: "current docs 2026" }, harness.context, {
                model: modelAnthropicFable5,
                provider: providerWithModels(
                    [modelAnthropicFable5],
                    vi.fn().mockResolvedValue({
                        content: [{ type: "text", text: "I already know this." }],
                    }),
                ),
            }),
        ).rejects.toThrow(/answered without searching/u);
    });

    // A search that ran and failed is not a search that never ran. Deciding from the results alone
    // could not tell those apart — an error carries no pages either — and reporting the wrong one
    // would send the model looking for a memory answer that never happened, instead of the reason.
    it("reports a failed search as the failure it was, not as one that never ran", async () => {
        const tool = createClaudeWebSearchTool();
        const harness = createJustBashToolHarness();

        await expect(
            tool.execute({ query: "current docs 2026" }, harness.context, {
                model: modelAnthropicFable5,
                provider: providerWithModels(
                    [modelAnthropicFable5],
                    vi.fn().mockResolvedValue({
                        content: [
                            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
                            {
                                type: "web_search_tool_result",
                                tool_use_id: "srvtoolu_1",
                                content: {
                                    type: "web_search_tool_result_error",
                                    error_code: "max_uses_exceeded",
                                },
                            },
                        ],
                    }),
                ),
            }),
        ).resolves.toMatchObject({
            query: "current docs 2026",
            results: ["Web search error: max_uses_exceeded"],
        });
    });

    it("uses the selected provider's auxiliary query with the preferred model", async () => {
        // A real helper response carries the search it performed. Text alone would mean it
        // answered from memory, which is the one thing this tool must not report as a search.
        const runClaudeAuxiliaryQuery = vi.fn().mockResolvedValue({
            content: [
                { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
                {
                    type: "web_search_tool_result",
                    tool_use_id: "srvtoolu_1",
                    content: [{ title: "Docs", url: "https://example.com/docs" }],
                },
                { type: "text", text: "Current docs." },
            ],
        });
        const tool = createClaudeWebSearchTool();
        const harness = createJustBashToolHarness();

        await tool.execute({ query: "current docs 2026" }, harness.context, {
            model: modelAnthropicFable5,
            provider: providerWithModels(
                [modelAnthropicFable5, modelAnthropicSonnet5],
                runClaudeAuxiliaryQuery,
            ),
        });

        expect(runClaudeAuxiliaryQuery).toHaveBeenCalledWith(
            modelAnthropicSonnet5,
            expect.objectContaining({
                prompt: "Perform a web search for the query: current docs 2026",
                tools: ["WebSearch"],
            }),
        );
    });
});

function providerWithModels(
    models: readonly Model[],
    runClaudeAuxiliaryQuery?: NonNullable<
        import("@slopus/rig-execution").Provider["runClaudeAuxiliaryQuery"]
    >,
) {
    return {
        id: "work-claude",
        type: "claude" as const,
        models,
        serviceTiers: undefined,
        extendProfilePromptContext: undefined,
        quota: undefined,
        ...(runClaudeAuxiliaryQuery === undefined ? {} : { runClaudeAuxiliaryQuery }),
        stream: () => {
            throw new Error("Not used");
        },
    };
}
