import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { AgentProviders, type AgentModel, type AgentModuleScope } from "@slopus/happy-agent-base";
import {
    AnthropicProvider,
    ClaudeApiKeyCredential,
    CodexApiKeyCredential,
    CodexProvider,
} from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import {
    MAX_FETCH_URL_LENGTH,
    searchAnswerSchema,
    searchProviderRequestSchema,
    type FetchResult,
    type SearchAnswer,
} from "../../sources/search/Search.js";
import { MAX_SEARCH_OUTPUT_CHARACTERS, SearchModule } from "../../sources/search/SearchModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-agent-modules-search");
const AGENT_ID = "agent-one";

/**
 * The accounts a person configured, as real provider registrations.
 *
 * Nothing here is ever resolved — every test stops before a vendor is called — but the registry,
 * the catalog and the configuration around them are the product's own, so the module reads the
 * same accounts it would read in a running agent.
 */
async function configWith(accounts: readonly (readonly [string, "claude" | "codex"])[]) {
    const providers = new AgentProviders();
    const models: AgentModel[] = [];
    for (const [id, vendor] of accounts) {
        providers.add(id, await account(vendor), vendor);
        models.push({
            providerId: id,
            id: `${id}-model`,
            name: `${id} model`,
            effortLevels: ["medium"],
            defaultEffort: "medium",
        });
    }
    return await ConfigModule.load(await mkdtemp(join(tmpdir(), "rig-search-")), {
        inference: { models, providers },
    });
}

async function account(vendor: "claude" | "codex") {
    if (vendor === "codex") {
        const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "test-key" });
        return new CodexProvider({ credential: credential! });
    }
    const credential = await ClaudeApiKeyCredential.tryLoad({ apiKey: "test-key" });
    return new AnthropicProvider({ credential: credential! });
}

/** The module as an agent gets it: the first model's account is the one this chat runs on. */
async function module(): Promise<SearchModule> {
    return new SearchModule(
        await configWith([
            ["codex", "codex"],
            ["claude", "claude"],
        ]),
    );
}

function scope(agentId: string): AgentModuleScope {
    return { agent: { id: agentId } } as AgentModuleScope;
}

function answer(overrides: Partial<SearchAnswer> = {}): SearchAnswer {
    return {
        provider: "codex",
        query: "rig",
        answer: "Happy Agent is a coding agent.",
        sources: [{ title: "Happy Agent", url: "https://example.test/rig" }],
        durationMs: 12,
        ...overrides,
    };
}

async function toolsFor(search: SearchModule) {
    const hooks = await resolveModuleHooks(ctx, search);
    return await hooks.tools!(ctx, scope(AGENT_ID));
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("SearchModule", () => {
    it("exposes every vendor tool with explicit Auto network permissions", async () => {
        vi.stubEnv("GEMINI_API_KEY", "secret-key");
        const tools = await toolsFor(await module());
        expect(tools.map((tool) => tool.name)).toEqual([
            "web_fetch",
            "gemini_web_search",
            "claude_web_search",
            "codex_web_search",
            "bedrock_web_search",
            "grok_web_search",
            "grok_x_search",
        ]);
        expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
        for (const tool of tools) {
            expect(tool.durable).toBe(false);
            expect(tool.transactional).not.toBe(true);
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode({}, ctx)).toBe(true);
            expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
            expect(tool.description).toBeTruthy();
            expect(tool.describeAutoPermissionAction?.({ query: "rig" } as never, ctx)).toContain(
                "external",
            );
            expect(tool.returnType).toBeDefined();
        }
    });

    it("does not expose Gemini web search when no Gemini key is configured", async () => {
        vi.stubEnv("GEMINI_API_KEY", "");

        const tools = await toolsFor(await module());

        expect(tools.map((tool) => tool.name)).not.toContain("gemini_web_search");
    });

    it("says which vendor has no configured account instead of searching nowhere", async () => {
        const tools = await toolsFor(await module());
        const byName = new Map(tools.map((tool) => [tool.name, tool]));

        await expect(
            byName.get("grok_web_search")!.execute(ctx, { query: "rig" }, undefined as never),
        ).rejects.toThrow("No Grok account is configured");
        await expect(
            byName.get("bedrock_web_search")!.execute(ctx, { query: "rig" }, undefined as never),
        ).rejects.toThrow("No Bedrock account is configured");
    });

    it("names the account a vendor search was asked for when that account does not exist", async () => {
        const tools = await toolsFor(await module());
        const codex = tools.find((tool) => tool.name === "codex_web_search")!;

        await expect(
            codex.execute(ctx, { query: "rig", provider_id: "not-configured" }, undefined as never),
        ).rejects.toThrow('Unknown Codex account "not-configured"');
    });

    it("rejects a routed request before it reaches a vendor", async () => {
        const search = await module();

        await expect(
            search.providerSearch(ctx, AGENT_ID, {
                provider: "codex",
                query: "rig",
                allowedDomains: ["allowed.test"],
                blockedDomains: ["blocked.test"],
            }),
        ).rejects.toThrow("cannot allow and block domains");
        await expect(
            search.providerSearch(ctx, AGENT_ID, { provider: "codex", query: "   " }),
        ).rejects.toThrow("cannot be empty");
        await expect(
            search.providerSearch(ctx, AGENT_ID, {
                provider: "nowhere",
                query: "rig",
            } as never),
        ).rejects.toThrow("Invalid provider search request");
        await expect(
            search.providerSearch(ctx, " spaced ", { provider: "codex", query: "rig" }),
        ).rejects.toThrow("agent identity is invalid");
    });

    it("rejects a fetch destination that is not a plain web address", async () => {
        const search = await module();
        for (const url of [
            "file:///tmp/example",
            "javascript:alert(1)",
            "ftp://example.test/rig",
        ]) {
            await expect(
                search.fetch(ctx, AGENT_ID, { url }),
                `unsupported destination ${url}`,
            ).rejects.toThrow();
        }
    });

    it("rejects a fetch URL that is malformed or past the documented length bound", async () => {
        const search = await module();
        const prefix = "https://example.test/";
        const tooLong = `${prefix}${"x".repeat(MAX_FETCH_URL_LENGTH)}`;

        await expect(search.fetch(ctx, AGENT_ID, { url: tooLong })).rejects.toThrow();
        await expect(search.fetch(ctx, AGENT_ID, { url: "not a url" })).rejects.toThrow();
    });

    it("renders a vendor answer with its sources, and keeps every URL whole under pressure", async () => {
        const search = await module();
        const output = search.formatSearchAnswerForModel(
            answer({
                answer: "x".repeat(MAX_SEARCH_OUTPUT_CHARACTERS * 2),
                sources: [
                    { title: "First", url: "https://example.test/one" },
                    { title: "Second", url: "https://example.test/two" },
                ],
            }),
        );

        expect(output.length).toBeLessThanOrEqual(MAX_SEARCH_OUTPUT_CHARACTERS);
        expect(output).toContain("[Answer truncated.]");
        expect(output).toContain("https://example.test/one");
        expect(output).toContain("https://example.test/two");
    });

    it("counts the sources that did not fit rather than writing half of one", async () => {
        const search = await module();
        // The answer schema allows a hundred sources, and a hundred long URLs is more than the
        // half of the output budget the sources block is allowed to take.
        const many = Array.from({ length: 100 }, (_unused, index) => ({
            title: `Source ${String(index)}`,
            url: `https://example.test/${"path".repeat(40)}/${String(index)}`,
        }));

        const output = search.formatSearchAnswerForModel(answer({ sources: many }));
        expect(output.length).toBeLessThanOrEqual(MAX_SEARCH_OUTPUT_CHARACTERS);
        expect(output).toMatch(/\[\d+ more sources? omitted\.\]/u);
        for (const line of output.split("\n")) {
            if (!line.startsWith("https://")) continue;
            expect(many.some((source) => line.startsWith(source.url))).toBe(true);
        }
    });

    it("refuses to format an answer it cannot stand behind", async () => {
        const search = await module();
        expect(() => search.formatSearchAnswerForModel({ ...answer(), answer: "" })).toThrow(
            "invalid search answer",
        );
        expect(() =>
            search.formatSearchAnswerForModel({ ...answer(), unknown: true } as never),
        ).toThrow("invalid search answer");
    });

    it("bounds fetch output and marks what was cut", async () => {
        const search = await module();
        const result: FetchResult = {
            url: "https://example.test/",
            title: "Title",
            content: "x".repeat(MAX_SEARCH_OUTPUT_CHARACTERS * 2),
            truncated: true,
        };

        const output = search.formatFetchForModel(result);
        expect(output.length).toBeLessThanOrEqual(MAX_SEARCH_OUTPUT_CHARACTERS);
        expect(output.startsWith("https://example.test/")).toBe(true);
        expect(output).toContain("[Content truncated.]");
    });

    it("lets every vendor search tool render its answer and cited sources", async () => {
        const search = await module();
        const tools = await toolsFor(search);
        const result = answer();
        for (const tool of tools.filter((candidate) => candidate.name !== "web_fetch")) {
            expect(Value.Check(tool.returnType, result)).toBe(true);
            const blocks = tool.toLLM(result);
            expect(blocks).toHaveLength(1);
            expect(blocks[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("https://example.test/rig"),
            });
            expect((blocks[0] as { text: string }).text).toContain(
                "Happy Agent is a coding agent.",
            );
        }

        const fetch = tools.find((tool) => tool.name === "web_fetch")!;
        const fetched: FetchResult = {
            url: "https://example.test/rig",
            content: "content",
            truncated: false,
        };
        expect(Value.Check(fetch.returnType, fetched)).toBe(true);
        expect(fetch.toLLM(fetched)[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("https://example.test/rig"),
        });
    });

    it("allows only legal routed request and answer shapes", () => {
        expect(
            Value.Check(searchProviderRequestSchema, {
                provider: "codex",
                query: "rig",
                providerId: "account",
                latest: true,
            }),
        ).toBe(true);
        // A vendor search is not paginated, so a page-shaped request is not a request at all.
        expect(
            Value.Check(searchProviderRequestSchema, { provider: "codex", query: "rig", limit: 1 }),
        ).toBe(false);
        expect(
            Value.Check(searchProviderRequestSchema, { provider: "not-a-provider", query: "rig" }),
        ).toBe(false);
        expect(Value.Check(searchAnswerSchema, answer())).toBe(true);
        expect(Value.Check(searchAnswerSchema, { ...answer(), unknown: true })).toBe(false);
        expect(Value.Check(searchAnswerSchema, { ...answer(), durationMs: -1 })).toBe(false);
    });

    it("has no accounts to search on when the configuration enables none", async () => {
        const search = new SearchModule(await configWith([]));
        const tools = await toolsFor(search);

        await expect(
            tools
                .find((tool) => tool.name === "codex_web_search")!
                .execute(ctx, { query: "rig" }, undefined as never),
        ).rejects.toThrow("No Codex account is configured");
    });
});
