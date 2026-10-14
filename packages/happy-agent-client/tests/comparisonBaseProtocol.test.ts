import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import type { GitState } from "../sources/protocol/git.js";
import { updateWorkspaceRequestSchema } from "../sources/protocol/workspaces.js";

describe("comparison branches", () => {
    it("chooses and clears a workspace's comparison branch through the workspace route", async () => {
        const requests: { body: unknown; ifMatch: string | null; method: string; url: string }[] =
            [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
                ifMatch: new Headers(init?.headers).get("if-match"),
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            return new Response(JSON.stringify({ workspace: {} }), {
                headers: { "content-type": "application/json" },
                status: 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await client.updateWorkspace(
            "w9x8y7z6",
            { comparisonBase: "release-v8.8", mutationId: "choose-1" },
            { ifMatch: "v1" },
        );
        await client.updateWorkspace("w9x8y7z6", { comparisonBase: null }, { ifMatch: "v2" });

        expect(requests).toEqual([
            {
                body: { comparisonBase: "release-v8.8", mutationId: "choose-1" },
                ifMatch: "v1",
                method: "PATCH",
                url: "http://agent.local/v0/workspaces/w9x8y7z6",
            },
            {
                body: { comparisonBase: null },
                ifMatch: "v2",
                method: "PATCH",
                url: "http://agent.local/v0/workspaces/w9x8y7z6",
            },
        ]);
    });

    it("lists a workspace's branches with the query and limit", async () => {
        const urls: string[] = [];
        const response = {
            branches: [{ committedAt: 1755400000000, ref: "origin/release-v8.8", remote: true }],
            truncated: false,
        };
        const fetch: typeof globalThis.fetch = async (input) => {
            urls.push(input.toString());
            return new Response(JSON.stringify(response), {
                headers: { "content-type": "application/json" },
                status: 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const filtered = await client.listWorkspaceBranches("w9x8y7z6", {
            limit: 20,
            query: "release",
        });
        const unfiltered = await client.listWorkspaceBranches("w9x8y7z6");

        expect(filtered).toEqual(response);
        expect(unfiltered).toEqual(response);
        expect(urls).toEqual([
            "http://agent.local/v0/workspaces/w9x8y7z6/git/branches?query=release&limit=20",
            "http://agent.local/v0/workspaces/w9x8y7z6/git/branches",
        ]);
    });

    it("accepts branch names and rejects ones Git would read as options", () => {
        for (const comparisonBase of ["release-v8.8", "origin/release-v8.8", "feature/x", null]) {
            expect(Value.Check(updateWorkspaceRequestSchema, { comparisonBase })).toBe(true);
        }
        for (const comparisonBase of ["", "-delete", "release v8", "a".repeat(201)]) {
            expect(Value.Check(updateWorkspaceRequestSchema, { comparisonBase })).toBe(false);
        }
    });

    it("reads git state from daemons with and without comparison branches", () => {
        const older: GitState = {
            base: "4f2a1c93b7e0d5a6c8f1e2d3b4a5968778695a4b",
            changedFiles: 0,
            comparison: "ready",
            conflicted: false,
            countsExact: true,
            deletions: 0,
            facts: {
                ahead: 0,
                behind: 0,
                branch: "fix",
                detached: false,
                head: "9c2f1e7",
                upstream: null,
            },
            files: [],
            filesTruncated: false,
            insertions: 0,
            scannedAt: 1,
        };
        const current: GitState = {
            ...older,
            baseNotice: null,
            baseRef: "origin/release-v8.8",
            baseSource: "inferred",
        };
        expect(older.baseRef ?? null).toBeNull();
        expect(current.baseSource).toBe("inferred");
    });
});
