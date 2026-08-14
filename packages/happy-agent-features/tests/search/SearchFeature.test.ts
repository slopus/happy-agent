import { Value } from "@sinclair/typebox/value";
import type { AgentFeatureScope } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MAX_FETCH_URL_LENGTH,
    MAX_SEARCH_RESULT_URL_LENGTH,
    fetchResultSchema,
    searchCursorSchema,
    type FetchResult,
    type SearchPage,
    type SearchQuery,
} from "../../sources/search/Search.js";
import type { SearchBackend } from "../../sources/search/SearchBackend.js";
import { SearchFeature } from "../../sources/search/SearchFeature.js";

const ctx = createRootContext().named("happy-agent-features-search");
const AGENT_ID = "agent-one";

class ClassBackedSearchBackend implements SearchBackend {
    readonly #searchCalls: Array<{
        readonly ctx: Context;
        readonly agentId: string;
        readonly query: SearchQuery;
    }> = [];
    readonly #fetchCalls: Array<{
        readonly ctx: Context;
        readonly agentId: string;
        readonly url: string;
        readonly maxCharacters: number | undefined;
    }> = [];
    #searchPage: SearchPage = {
        query: "rig",
        results: [
            {
                id: "one",
                title: "One",
                url: "https://example.test/one",
                snippet: "First result",
            },
        ],
    };
    #fetchResult: FetchResult = {
        url: "https://example.test/one",
        content: "Fetched content",
        truncated: false,
    };

    get searchCalls() {
        return this.#searchCalls;
    }

    get fetchCalls() {
        return this.#fetchCalls;
    }

    get searchPage(): SearchPage {
        return this.#searchPage;
    }

    set searchPage(value: SearchPage) {
        this.#searchPage = value;
    }

    get fetchResult(): FetchResult {
        return this.#fetchResult;
    }

    set fetchResult(value: FetchResult) {
        this.#fetchResult = value;
    }

    async search(callCtx: Context, agentId: string, query: SearchQuery): Promise<SearchPage> {
        this.#searchCalls.push({ ctx: callCtx, agentId, query });
        return this.#searchPage;
    }

    async fetch(
        callCtx: Context,
        agentId: string,
        input: {
            readonly url: string;
            readonly maxCharacters?: number;
        },
    ): Promise<FetchResult> {
        this.#fetchCalls.push({
            ctx: callCtx,
            agentId,
            url: input.url,
            maxCharacters: input.maxCharacters,
        });
        return this.#fetchResult;
    }
}

function feature(
    backend: SearchBackend = new ClassBackedSearchBackend(),
    overrides: Partial<{
        maxResults: number;
        maxCharacters: number;
        maxOutputCharacters: number;
    }> = {},
): SearchFeature {
    return new SearchFeature({
        backend,
        ...overrides,
    });
}

function scope(agentId: string): AgentFeatureScope {
    return { agent: { id: agentId } } as AgentFeatureScope;
}

describe("SearchFeature", () => {
    it("keeps public APIs and common tools on one class-backed scoped backend", async () => {
        const backend = new ClassBackedSearchBackend();
        const search = feature(backend);

        const page = await search.search(ctx, AGENT_ID, {
            query: "  rig  ",
            limit: 10,
        });
        expect(page.query).toBe("rig");
        expect(backend.searchCalls).toEqual([
            {
                ctx,
                agentId: AGENT_ID,
                query: { query: "rig", limit: 10 },
            },
        ]);

        const tools = search.tools(ctx, scope(AGENT_ID));
        expect(tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
        await tools[0]!.execute(ctx, { query: "rig" });
        await tools[1]!.execute(ctx, { url: "https://example.test/one" });
        expect(backend.searchCalls.at(-1)?.agentId).toBe(AGENT_ID);
        expect(backend.fetchCalls.at(-1)?.agentId).toBe(AGENT_ID);
    });

    it("normalizes fetch URLs and requires exact backend identity", async () => {
        const backend = new ClassBackedSearchBackend();
        const search = feature(backend);
        backend.fetchResult = {
            url: "https://example.test/path",
            content: "Fetched content",
            truncated: false,
        };

        const fetched = await search.fetch(ctx, AGENT_ID, {
            url: "  HTTPS://EXAMPLE.TEST/path  ",
        });
        expect(fetched.url).toBe("https://example.test/path");
        expect(backend.fetchCalls.at(-1)).toMatchObject({
            ctx,
            agentId: AGENT_ID,
            url: "https://example.test/path",
        });

        backend.fetchResult = {
            ...backend.fetchResult,
            url: "https://example.test/other",
        };
        await expect(
            search.fetch(ctx, AGENT_ID, { url: "https://example.test/path" }),
        ).rejects.toThrow("different normalized URL");
        await expect(search.fetch(ctx, AGENT_ID, { url: "file:///tmp/example" })).rejects.toThrow(
            "http or https",
        );
    });

    it("bounds backend pages, fetch content, and model output", async () => {
        const backend = new ClassBackedSearchBackend();
        backend.searchPage = {
            query: "rig",
            results: [
                {
                    id: "one",
                    title: "Result one",
                    url: "https://example.test/one",
                },
                {
                    id: "two",
                    title: "Result two",
                    url: "https://example.test/two",
                },
                {
                    id: "three",
                    title: "Result three",
                    url: "https://example.test/three",
                },
            ],
        };
        backend.fetchResult = {
            url: "https://example.test/",
            content: "x".repeat(5_000),
            truncated: false,
        };
        const search = feature(backend, {
            maxResults: 2,
            maxCharacters: 1_000,
            maxOutputCharacters: 256,
        });

        await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "more results",
        );
        const fetched = await search.fetch(ctx, AGENT_ID, {
            url: "https://example.test",
            maxCharacters: 1_000,
        });
        expect(fetched.content).toHaveLength(1_000);
        expect(fetched.truncated).toBe(true);
        expect(Value.Check(fetchResultSchema, fetched)).toBe(true);

        const output = search.formatFetchForModel(fetched);
        expect(output.length).toBeLessThanOrEqual(256);
    });

    it("uses output-aware page size and keeps every returned identity visible", async () => {
        const backend = new ClassBackedSearchBackend();
        backend.searchPage = {
            query: "rig",
            results: [
                {
                    id: "identity-one",
                    title: "x".repeat(2_000),
                    url: "https://example.test/one",
                    snippet: "y".repeat(10_000),
                },
            ],
            nextCursor: 1,
        };
        const search = feature(backend, {
            maxResults: 50,
            maxOutputCharacters: 256,
        });

        const page = await search.search(ctx, AGENT_ID, {
            query: "rig",
            limit: 50,
        });
        expect(backend.searchCalls.at(-1)?.query.limit).toBe(1);
        const output = search.formatSearchForModel(page);
        expect(output.length).toBeLessThanOrEqual(256);
        expect(output).toContain("https://example.test/one");
        expect(output).toContain("next_cursor=1");
    });

    it("keeps a legal maximum URL actionable at the minimum search output budget", async () => {
        const backend = new ClassBackedSearchBackend();
        const prefix = "https://example.test/";
        const url = `${prefix}${"x".repeat(MAX_SEARCH_RESULT_URL_LENGTH - prefix.length)}`;
        backend.searchPage = {
            query: "rig",
            results: [
                {
                    title: "Result",
                    url,
                },
            ],
            nextCursor: 1,
        };
        const search = feature(backend, {
            maxResults: 50,
            maxOutputCharacters: 256,
        });

        const page = await search.search(ctx, AGENT_ID, { query: "rig", limit: 50 });
        expect(backend.searchCalls.at(-1)?.query.limit).toBe(1);
        const output = search.formatSearchForModel(page);
        expect(output.length).toBeLessThanOrEqual(256);
        expect(output.startsWith(url)).toBe(true);
        expect(output).toContain(url);
        expect(output).toContain("next_cursor=1");
    });

    it("puts the exact fetch URL first while bounding title, content, and truncation", () => {
        const backend = new ClassBackedSearchBackend();
        const prefix = "https://example.test/";
        const url = `${prefix}${"x".repeat(MAX_FETCH_URL_LENGTH - prefix.length)}`;
        const search = feature(backend, { maxOutputCharacters: 256 });

        const output = search.formatFetchForModel({
            url,
            title: "A page title",
            content: "content ".repeat(500),
            truncated: true,
        });
        expect(output.slice(0, url.length)).toBe(url);
        expect(output.startsWith(`${url}\n`)).toBe(true);
        expect(output).toContain("A page title");
        expect(output).toContain("[Content truncated.]");
        expect(output.length).toBeLessThanOrEqual(256);
    });

    it("rejects malformed and semantically invalid backend responses", async () => {
        const backend = new ClassBackedSearchBackend();
        const search = feature(backend);

        backend.searchPage = {
            query: "other",
            results: [],
        };
        await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "different query",
        );

        backend.searchPage = {
            query: "rig",
            results: [
                {
                    id: "same",
                    title: "One",
                    url: "https://example.test/one",
                },
                {
                    id: "same",
                    title: "Two",
                    url: "https://example.test/two",
                },
            ],
        };
        await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "duplicate result identities",
        );

        backend.searchPage = {
            query: "rig",
            results: [{ bad: true }],
        } as never;
        await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "invalid result page",
        );

        backend.fetchResult = {
            url: "https://example.test",
            content: "ok",
            truncated: false,
            unexpected: true,
        } as never;
        await expect(search.fetch(ctx, AGENT_ID, { url: "https://example.test" })).rejects.toThrow(
            "invalid fetch result",
        );
    });

    it("requires canonical HTTP(S) result URLs and rejects canonical duplicates", async () => {
        const backend = new ClassBackedSearchBackend();
        const search = feature(backend);
        const invalidUrls = ["not-a-url", "javascript:alert(1)", "file:///tmp/example"];
        for (const url of invalidUrls) {
            backend.searchPage = {
                query: "rig",
                results: [{ title: "Invalid", url }],
                nextCursor: 1,
            };
            await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
                "invalid result URL",
            );
        }

        const nonCanonicalUrls = [
            " https://example.test/path ",
            "HTTPS://EXAMPLE.TEST/path",
            "https://example.test:443/path",
            "https://example.test/./path",
        ];
        for (const url of nonCanonicalUrls) {
            backend.searchPage = {
                query: "rig",
                results: [{ title: "Non-canonical", url }],
                nextCursor: 1,
            };
            await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
                "non-canonical result URL",
            );
        }

        backend.searchPage = {
            query: "rig",
            results: [
                {
                    id: "one",
                    title: "One",
                    url: "https://example.test/path",
                },
                {
                    id: "two",
                    title: "Two",
                    url: "https://example.test/path",
                },
            ],
            nextCursor: 2,
        };
        await expect(search.search(ctx, AGENT_ID, { query: "rig" })).rejects.toThrow(
            "duplicate result identities",
        );
    });

    it("uses bounded numeric offsets and requires exact cursor progress", async () => {
        expect(Value.Check(searchCursorSchema, 0)).toBe(true);
        expect(Value.Check(searchCursorSchema, -1)).toBe(false);
        expect(Value.Check(searchCursorSchema, "0")).toBe(false);

        const backend = new ClassBackedSearchBackend();
        backend.searchPage = {
            query: "rig",
            results: [
                {
                    title: "One",
                    url: "https://example.test/one",
                },
            ],
            nextCursor: 5,
        };
        const search = feature(backend);
        await expect(searchWithCursor(search, 4)).resolves.toMatchObject({
            nextCursor: 5,
        });

        backend.searchPage = {
            ...backend.searchPage,
            nextCursor: 6,
        };
        await expect(searchWithCursor(search, 4)).rejects.toThrow("returned result count");
    });

    it("rejects invalid bounds, stalls, skips, and non-terminal empty continuations", async () => {
        const backend = new ClassBackedSearchBackend();
        expect(() => feature(backend, { maxResults: 0 })).toThrow("options are invalid");
        expect(() => feature(backend, { maxResults: 51 })).toThrow("options are invalid");
        expect(() => feature(backend, { maxCharacters: 999 })).toThrow("options are invalid");
        expect(() => feature(backend, { maxOutputCharacters: 255 })).toThrow("options are invalid");

        backend.searchPage = {
            query: "rig",
            results: [
                {
                    id: "one",
                    title: "One",
                    url: "https://example.test/one",
                },
            ],
            nextCursor: 4,
        };
        await expect(searchWithCursor(feature(backend), 4)).rejects.toThrow("non-advancing cursor");

        backend.searchPage = {
            ...backend.searchPage,
            nextCursor: 3,
        };
        await expect(searchWithCursor(feature(backend), 4)).rejects.toThrow("non-advancing cursor");

        backend.searchPage = {
            ...backend.searchPage,
            nextCursor: 6,
        };
        await expect(searchWithCursor(feature(backend), 4)).rejects.toThrow(
            "returned result count",
        );

        backend.searchPage = {
            query: "rig",
            results: [],
            nextCursor: 5,
        };
        await expect(searchWithCursor(feature(backend), 4)).rejects.toThrow(
            "without returning a result",
        );

        backend.searchPage = {
            query: "rig",
            results: [],
        };
        await expect(searchWithCursor(feature(backend), 4)).resolves.toMatchObject({
            results: [],
        });
    });
});

async function searchWithCursor(search: SearchFeature, cursor: number): Promise<SearchPage> {
    return await search.search(ctx, AGENT_ID, { query: "rig", cursor });
}
