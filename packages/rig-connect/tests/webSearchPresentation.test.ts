import { describe, expect, it } from "vitest";

import { projectToolPresentation } from "@/ToolPresentation.js";
import { describeProviderToolCall } from "@/describeProviderToolCall.js";

/**
 * Rig runs some searches itself and the provider runs others on its own backend. Those are not the
 * same kind of work — one has a tool result Rig produced, the other has none and never can — and
 * the two lifecycles are deliberately left apart.
 *
 * A reader is looking at one act either way. These pin the place where the two converge, so a
 * search cannot start reading differently depending on who happened to execute it.
 */
describe("a search, whoever ran it", () => {
    it("reaches the interface as the same value from a client tool and from the provider", () => {
        const client = projectToolPresentation(undefined, {
            query: "Node.js current stable version",
            sources: [
                { url: "https://nodejs.org/en/about/previous-releases" },
                { url: "https://nodejs.org/en" },
            ],
            target: "web",
            type: "search",
        });
        const hosted = describeProviderToolCall(
            "web_search",
            JSON.stringify({
                query: "Node.js current stable version",
                sources: [
                    { type: "url", url: "https://nodejs.org/en/about/previous-releases" },
                    { type: "url", url: "https://nodejs.org/en" },
                ],
                type: "search",
            }),
        );

        expect(client).toEqual({
            kind: "search",
            query: "Node.js current stable version",
            sources: [
                { url: "https://nodejs.org/en/about/previous-releases" },
                { url: "https://nodejs.org/en" },
            ],
            target: "web",
        });
        expect(hosted).toMatchObject({
            kind: "search",
            query: "Node.js current stable version",
            sources: [
                { url: "https://nodejs.org/en/about/previous-releases" },
                { url: "https://nodejs.org/en" },
            ],
            target: "web",
        });
    });

    // The row a reader is watching must not change kind when the search finishes, so the call
    // half already says it is a search and simply has nothing to cite yet.
    it("is a search from the moment it starts, before it has consulted anything", () => {
        expect(
            projectToolPresentation(
                { query: "rust async traits", target: "web", type: "search" },
                undefined,
            ),
        ).toEqual({ kind: "search", query: "rust async traits", sources: [], target: "web" });
    });

    // The result is the later and more complete account of the same act.
    it("takes the finished search over the one that was announced", () => {
        expect(
            projectToolPresentation(
                { query: "announced", target: "web", type: "search" },
                {
                    query: "what actually ran",
                    sources: [{ title: "Node", url: "https://nodejs.org/en" }],
                    target: "web",
                    type: "search",
                },
            ),
        ).toEqual({
            kind: "search",
            query: "what actually ran",
            sources: [{ title: "Node", url: "https://nodejs.org/en" }],
            target: "web",
        });
    });
});
