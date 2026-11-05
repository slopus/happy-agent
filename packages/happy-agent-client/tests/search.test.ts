import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { fuseSearchResults } from "../sources/fuseSearchResults.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    SEARCH_TYPES,
    searchRequestSchema,
    searchResultSchema,
} from "../sources/protocol/search.js";

interface FusionCase {
    name: string;
    remote: { key: string; rank: number }[];
    local: { key: string }[];
    expected: { key: string; from: "remote" | "local" }[];
}

const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/searchFusion.fixtures.json", import.meta.url), "utf8"),
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

describe("search", () => {
    it.each(fixtures.cases.map((fusion) => [fusion.name, fusion] as const))(
        "fuses the shared vector: %s",
        (_name, fusion) => {
            const fused = fuseSearchResults(fusion.remote, fusion.local);
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
        expect(fuseSearchResults(remote, local)).toEqual(remote);
    });

    it("validates every result variant and the request", () => {
        expect(Value.Check(searchResultSchema, todo)).toBe(true);
        expect(Value.Check(searchResultSchema, vaultFile)).toBe(true);
        expect(Value.Check(searchResultSchema, { ...todo, status: "deleted" })).toBe(false);
        expect(Value.Check(searchResultSchema, { ...todo, rank: 0 })).toBe(false);
        // A newer daemon's extra fields never cost a client the result.
        expect(Value.Check(searchResultSchema, { ...todo, extra: 1 })).toBe(true);
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
        expect(Value.Check(searchResultSchema, agent)).toBe(true);
        expect(
            Value.Check(searchResultSchema, { ...agent, workspaceId: null, projectId: null }),
        ).toBe(true);
        const { workspaceId: _workspaceId, ...withoutWorkspace } = agent;
        expect(Value.Check(searchResultSchema, withoutWorkspace)).toBe(false);
        const event = {
            type: "calendar_event",
            key: "calendar_event:e1",
            rank: 3,
            surfaceId: "s1",
            eventId: "e1",
            title: "Team sync",
            allDay: false,
            start: 1_755_300_000_000,
            match: "content",
            snippet: "Room 4, second floor",
        };
        expect(Value.Check(searchResultSchema, event)).toBe(true);
        expect(Value.Check(searchResultSchema, { ...event, match: "name", snippet: null })).toBe(
            true,
        );
        const { match: _match, ...withoutMatch } = event;
        expect(Value.Check(searchResultSchema, withoutMatch)).toBe(false);
        const message = {
            type: "message",
            key: "message:m1",
            rank: 2,
            agentId: "a1",
            messageId: "m1",
            role: "agent",
            snippet: "The launch moves to Friday",
            createdAt: 1_755_300_000_000,
            workspaceId: "w1",
            projectId: null,
        };
        expect(Value.Check(searchResultSchema, message)).toBe(true);
        expect(Value.Check(searchResultSchema, { ...message, role: "system" })).toBe(false);
        expect(Value.Check(searchResultSchema, { ...message, snippet: null })).toBe(false);
        expect(
            Value.Check(searchResultSchema, {
                type: "user",
                key: "user:u1",
                rank: 5,
                userId: "u1",
                name: "Dana",
            }),
        ).toBe(true);
        expect(
            Value.Check(searchResultSchema, {
                type: "skill",
                key: "skill:k1",
                rank: 6,
                skillId: "k1",
                name: "release-agent",
                description: "Release Happy Agent",
            }),
        ).toBe(true);
        expect(SEARCH_TYPES).toEqual([
            "vault_file",
            "vault_folder",
            "document",
            "message",
            "todo",
            "calendar_event",
            "artifact",
            "surface",
            "agent",
            "project",
            "workspace",
            "user",
            "skill",
        ]);
        expect(Value.Check(searchRequestSchema, { q: "plan" })).toBe(true);
        expect(
            Value.Check(searchRequestSchema, { q: "plan", types: ["todo", "future_type"] }),
        ).toBe(true);
        expect(Value.Check(searchRequestSchema, { q: "" })).toBe(false);
        expect(Value.Check(searchRequestSchema, { q: "x", types: [] })).toBe(false);
        expect(Value.Check(searchRequestSchema, { q: "x", limit: 101 })).toBe(false);
        expect(Value.Check(healthResponseSchema.properties.capabilities, { search: true })).toBe(
            true,
        );
    });

    it("posts the query as JSON and drops results it does not know", async () => {
        const requests: {
            url: string;
            method: string | undefined;
            type: string | null;
            body: unknown;
        }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                url: input.toString(),
                method: init?.method,
                type: new Headers(init?.headers).get("content-type"),
                body: JSON.parse(String(init?.body)) as unknown,
            });
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
        const response = await client.search({
            q: "launch day",
            types: ["vault_file", "todo"],
            limit: 5,
        });
        expect(requests).toEqual([
            {
                url: "http://agent.local/v0/search",
                method: "POST",
                type: expect.stringContaining("application/json"),
                body: { q: "launch day", types: ["vault_file", "todo"], limit: 5 },
            },
        ]);
        expect(response).toEqual({ results: [vaultFile, todo], truncated: false, partial: true });
    });
});
