import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { fuseQuickSearchResults } from "../sources/fuseQuickSearchResults.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    QUICK_SEARCH_TYPES,
    quickSearchRequestSchema,
    quickSearchResultSchema,
} from "../sources/protocol/quickSearch.js";

interface FusionCase {
    name: string;
    remote: { key: string; rank: number }[];
    local: { key: string }[];
    expected: { key: string; from: "remote" | "local" }[];
}

const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/quickSearchFusion.fixtures.json", import.meta.url), "utf8"),
) as { k: number; cases: FusionCase[] };

const todo = {
    type: "todo",
    key: "todo:t1o2d3o4i5d6t7o8d9o0i1d2",
    rank: 2,
    surfaceId: "s1u2r3f4a5c6e7i8d9t0o1d2",
    todoId: "t1o2d3o4i5d6t7o8d9o0i1d2",
    text: "Book the launch venue",
    status: "active",
};
const vaultFile = {
    type: "vault_file",
    key: "vault_file:f1a2b3c4d5e6f7g8h9i0j1k2",
    rank: 1,
    surfaceId: "v1a2u3l4t5s6u7r8f9a0c1e2",
    fileId: "f1a2b3c4d5e6f7g8h9i0j1k2",
    name: "Launch plan.md",
    path: "/Docs/Launch plan.md",
    kind: "file",
    match: "content",
    innerPath: null,
    line: 4,
    snippet: "The launch moves to Friday",
};

describe("quick search", () => {
    it.each(fixtures.cases.map((fusion) => [fusion.name, fusion] as const))(
        "fuses the shared vector: %s",
        (_name, fusion) => {
            const fused = fuseQuickSearchResults(fusion.remote, fusion.local);
            expect(
                fused.map((result) => ({
                    key: result.key,
                    from: fusion.remote.includes(result as never) ? "remote" : "local",
                })),
            ).toEqual(fusion.expected);
        },
    );

    it("uses k = 60 in its vectors and keeps the remote fields on a shared key", () => {
        expect(fixtures.k).toBe(60);
        const remote = [{ ...todo, rank: 1 }];
        const local = [{ key: todo.key, text: "Stale local text" }];
        expect(fuseQuickSearchResults(remote, local)).toEqual(remote);
    });

    it("validates every result variant and the request", () => {
        expect(Value.Check(quickSearchResultSchema, todo)).toBe(true);
        expect(Value.Check(quickSearchResultSchema, vaultFile)).toBe(true);
        expect(Value.Check(quickSearchResultSchema, { ...todo, status: "deleted" })).toBe(false);
        expect(Value.Check(quickSearchResultSchema, { ...todo, rank: 0 })).toBe(false);
        // A newer daemon's extra fields never cost a client the result.
        expect(Value.Check(quickSearchResultSchema, { ...todo, extra: 1 })).toBe(true);
        const agent = {
            type: "agent",
            key: "agent:a1",
            rank: 4,
            agentId: "a1",
            title: "Launch chat",
            kind: "chat",
            archived: false,
            workspaceId: "w1",
            projectId: "p1",
        };
        expect(Value.Check(quickSearchResultSchema, agent)).toBe(true);
        expect(
            Value.Check(quickSearchResultSchema, { ...agent, workspaceId: null, projectId: null }),
        ).toBe(true);
        const { workspaceId: _workspaceId, ...withoutWorkspace } = agent;
        expect(Value.Check(quickSearchResultSchema, withoutWorkspace)).toBe(false);
        expect(
            Value.Check(quickSearchResultSchema, {
                type: "calendar_event",
                key: "calendar_event:e1",
                rank: 3,
                surfaceId: "s1",
                eventId: "e1",
                title: "Team sync",
                allDay: false,
                start: 1_755_300_000_000,
            }),
        ).toBe(true);
        expect(QUICK_SEARCH_TYPES).toHaveLength(10);
        expect(Value.Check(quickSearchRequestSchema, { q: "plan" })).toBe(true);
        expect(
            Value.Check(quickSearchRequestSchema, { q: "plan", types: ["todo", "future_type"] }),
        ).toBe(true);
        expect(Value.Check(quickSearchRequestSchema, { q: "" })).toBe(false);
        expect(Value.Check(quickSearchRequestSchema, { q: "x", types: [] })).toBe(false);
        expect(Value.Check(quickSearchRequestSchema, { q: "x", limit: 101 })).toBe(false);
        expect(
            Value.Check(healthResponseSchema.properties.capabilities, { quickSearch: true }),
        ).toBe(true);
    });

    it("asks the route with comma-separated types and drops results it does not know", async () => {
        const urls: string[] = [];
        const fetch: typeof globalThis.fetch = async (input) => {
            urls.push(input.toString());
            return new Response(
                JSON.stringify({
                    results: [
                        vaultFile,
                        { type: "future_type", key: "future_type:1", rank: 2 },
                        todo,
                    ],
                    truncated: false,
                    partial: true,
                }),
                { status: 200 },
            );
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const response = await client.quickSearch({
            q: "launch day",
            types: ["vault_file", "todo"],
            limit: 5,
        });
        expect(urls).toEqual([
            "http://agent.local/v0/quick-search?q=launch+day&types=vault_file%2Ctodo&limit=5",
        ]);
        expect(response).toEqual({ results: [vaultFile, todo], truncated: false, partial: true });
    });
});
