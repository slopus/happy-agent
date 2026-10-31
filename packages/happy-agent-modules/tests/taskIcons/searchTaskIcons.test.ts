import { describe, expect, it } from "vitest";

import { assertTaskIconSlug, searchTaskIcons } from "../../sources/taskIcons/searchTaskIcons.js";
import catalog from "../../sources/taskIcons/assets/index.json" with { type: "json" };

describe("topic icon retrieval", () => {
    it("covers the complete generated catalog with valid, unique stable slugs", () => {
        expect(catalog).toHaveLength(2_000);
        expect(new Set(catalog.map((icon) => icon.slug)).size).toBe(2_000);
        for (const icon of catalog) expect(() => assertTaskIconSlug(icon.slug)).not.toThrow();
    });

    it.each([
        ["pull request review", "code-review"],
        ["mobile crash", "mobile-crash"],
        ["iPhone launch crash", "mobile-crash"],
        ["memory leak profiling", "memory-leaks"],
        ["memory leak profiling", "memory-profiling"],
        ["database migration", "migration"],
        ["kubernetes rollout", "kubernetes-deployments"],
        ["C++", "cpp"],
        ["C#", "csharp"],
        ["pnpm workspace", "pnpm"],
    ])("retrieves %s by its subject and aliases", (query, slug) => {
        const results = searchTaskIcons(query);
        expect(results.map((icon) => icon.slug)).toContain(slug);
        expect(results.length).toBeLessThanOrEqual(10);
        expect(results.every((icon) => icon.score > 0)).toBe(true);
        expect(results).toEqual(searchTaskIcons(query));
    });

    it("leaves empty and unknown searches empty", () => {
        expect(searchTaskIcons("   ")).toEqual([]);
        expect(searchTaskIcons("zzqxvnonexistentword")).toEqual([]);
    });

    it("rejects invalid queries and invented or malformed slugs", () => {
        expect(() => searchTaskIcons("")).toThrow();
        expect(() => searchTaskIcons("a".repeat(1_001))).toThrow();
        for (const slug of ["invented-icon", "../code-review", "CODE-REVIEW", ""]) {
            expect(() => assertTaskIconSlug(slug)).toThrow();
        }
    });
});
