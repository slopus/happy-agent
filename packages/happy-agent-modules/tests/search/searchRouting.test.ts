import type { AgentModel, AgentProviders } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { boundedSources } from "../../sources/search/impl/boundedSources.js";
import { resolveSearchRoutes, selectSearchRoute } from "../../sources/search/impl/SearchRoute.js";
import { isBinaryContentType } from "../../sources/search/impl/webFetch/isBinaryContentType.js";
import { isPermittedWebFetchRedirect } from "../../sources/search/impl/webFetch/isPermittedWebFetchRedirect.js";
import { validateWebFetchUrl } from "../../sources/search/impl/webFetch/validateWebFetchUrl.js";

function providers(accounts: Readonly<Record<string, string>>): AgentProviders {
    return {
        ids: Object.keys(accounts),
        typeOf: (id: string) => accounts[id] ?? null,
    } as unknown as AgentProviders;
}

function model(providerId: string, id: string): AgentModel {
    return {
        providerId,
        id,
        name: id,
        effortLevels: ["medium"],
        defaultEffort: "medium",
    } as AgentModel;
}

describe("search routing", () => {
    it("groups every configured account under the vendor it belongs to", () => {
        const routes = resolveSearchRoutes({
            providers: providers({
                work: "codex",
                personal: "codex",
                anthropic: "claude",
                aws: "bedrock",
                xai: "grok",
                nothing: "codex",
            }),
            models: [
                model("work", "gpt-work"),
                model("personal", "gpt-personal"),
                model("anthropic", "claude-model"),
                model("aws", "bedrock-default"),
                model("aws", "bedrock-search"),
                model("xai", "grok-model"),
            ],
            currentProviderId: "personal",
            bedrockSearchModels: { aws: "bedrock-search" },
        });

        expect(routes.codex.map((route) => route.providerId)).toEqual(["work", "personal"]);
        expect(routes.claude.map((route) => route.model)).toEqual(["claude-model"]);
        expect(routes.grok.map((route) => route.providerId)).toEqual(["xai"]);
        expect(routes.currentProviderId).toBe("personal");
        // Bedrock serves its index from a particular model, so a named search model wins.
        expect(routes.bedrock).toEqual([
            { providerId: "aws", model: "bedrock-search", effort: "medium" },
        ]);
    });

    it("leaves out an account the catalog has no model for", () => {
        const routes = resolveSearchRoutes({
            providers: providers({ empty: "codex" }),
            models: [],
        });
        expect(routes.codex).toEqual([]);
    });

    it("runs a search on the account this chat already uses", () => {
        const routes = [
            { providerId: "work", model: "a", effort: "medium" as const },
            { providerId: "personal", model: "b", effort: "medium" as const },
        ];

        expect(selectSearchRoute("codex", routes, "personal", undefined).providerId).toBe(
            "personal",
        );
        expect(selectSearchRoute("codex", routes, "personal", "work").providerId).toBe("work");
        expect(selectSearchRoute("codex", [routes[0]!], undefined, undefined).providerId).toBe(
            "work",
        );
    });

    it("asks rather than guesses when several accounts could serve the search", () => {
        const routes = [
            { providerId: "work", model: "a", effort: "medium" as const },
            { providerId: "personal", model: "b", effort: "medium" as const },
        ];

        expect(() => selectSearchRoute("codex", routes, "anthropic", undefined)).toThrow(
            "needs an account",
        );
        expect(() => selectSearchRoute("codex", routes, undefined, "missing")).toThrow(
            'Unknown codex account "missing"',
        );
        expect(() => selectSearchRoute("codex", [], undefined, undefined)).toThrow(
            "No codex account is configured",
        );
    });
});

describe("cited sources", () => {
    it("keeps followable citations and drops the rest", () => {
        const sources = boundedSources([
            { title: "Happy Agent", url: "https://example.test/rig" },
            { title: "Duplicate", url: "https://example.test/rig" },
            { title: "Relative", url: "/rig" },
            { title: "Not a URL", url: "see the docs" },
            { title: "  ", url: "https://example.test/blank-title" },
        ]);

        expect(sources.map((source) => source.url)).toEqual([
            "https://example.test/rig",
            "https://example.test/blank-title",
        ]);
        // A citation always has something to show; the URL stands in for a missing title.
        expect(sources[1]!.title).toBe("https://example.test/blank-title");
    });

    it("stops at the documented source count", () => {
        const many = Array.from({ length: 250 }, (_unused, index) => ({
            title: `Source ${String(index)}`,
            url: `https://example.test/${String(index)}`,
        }));
        expect(boundedSources(many)).toHaveLength(100);
    });
});

describe("web fetch addresses", () => {
    it("accepts a plain web address and refuses anything else", () => {
        expect(validateWebFetchUrl("https://example.test/rig")).toBe(true);
        expect(validateWebFetchUrl("http://example.test:8080/rig")).toBe(true);

        for (const url of [
            // A URL is never a way to hand a secret to whatever answers.
            "https://user:secret@example.test/",
            "ftp://example.test/rig",
            "javascript:alert(1)",
            "not a url",
            `https://example.test/${"x".repeat(2_000)}`,
        ]) {
            expect(validateWebFetchUrl(url), `unsupported destination ${url}`).toBe(false);
        }
    });

    it("follows a redirect only when it stays on the same site", () => {
        const from = "https://example.test/rig";
        expect(isPermittedWebFetchRedirect(from, "https://example.test/rig/latest")).toBe(true);
        expect(isPermittedWebFetchRedirect(from, "https://www.example.test/rig")).toBe(true);
        expect(isPermittedWebFetchRedirect(from, "https://elsewhere.test/rig")).toBe(false);
        expect(isPermittedWebFetchRedirect(from, "http://example.test/rig")).toBe(false);
        expect(isPermittedWebFetchRedirect(from, "https://user:secret@example.test/rig")).toBe(
            false,
        );
    });

    it("treats markup and data as text, and everything else as bytes", () => {
        expect(isBinaryContentType("text/html; charset=utf-8")).toBe(false);
        expect(isBinaryContentType("application/json")).toBe(false);
        expect(isBinaryContentType("application/atom+xml")).toBe(false);
        expect(isBinaryContentType("")).toBe(false);
        expect(isBinaryContentType("application/octet-stream")).toBe(true);
        expect(isBinaryContentType("image/png")).toBe(true);
    });
});
