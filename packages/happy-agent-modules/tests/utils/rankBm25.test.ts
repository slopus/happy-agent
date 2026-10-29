import { describe, expect, it } from "vitest";

import { rankBm25 } from "../../sources/utils/rankBm25.js";

describe("rankBm25", () => {
    it("ranks rarer and more frequent matches higher and leaves out non-matches", () => {
        const documents = [
            "task\nFix login redirect\nfix_login",
            "bot\nResearcher",
            "workspace\nlogin page\nworktree/login-page\nlogin",
            "project\nPayments",
        ];
        const ranked = rankBm25(documents, "login");
        expect(ranked.map((match) => match.index)).toEqual([2, 0]);
        expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    });

    it("folds case and accents, splits identifiers, and matches word prefixes", () => {
        const documents = ["Café Rewrite", "deep_dive", "/home/me/happy/Bots/chief", "cleanup"];
        expect(rankBm25(documents, "CAFE").map((match) => match.index)).toEqual([0]);
        expect(rankBm25(documents, "dive").map((match) => match.index)).toEqual([1]);
        expect(rankBm25(documents, "bots").map((match) => match.index)).toEqual([2]);
        expect(rankBm25(documents, "clean").map((match) => match.index)).toEqual([3]);
        // Short words match only whole words, so "cl" does not find "cleanup".
        expect(rankBm25(documents, "cl")).toEqual([]);
    });

    it("matches nothing for an empty query or an empty corpus", () => {
        expect(rankBm25(["anything"], "  ")).toEqual([]);
        expect(rankBm25([], "anything")).toEqual([]);
    });
});
