import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentApiError,
    HappyAgentClient,
    gitCompareQuerySchema,
    gitCompareResponseSchema,
    type GitCompareResponse,
} from "../sources/index.js";

const base = "3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e2b4d6f8a1c";
const head = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";
const compared: GitCompareResponse = {
    files: [
        { path: "sources/main.ts", status: "modified" },
        { path: "sources/renamed.ts", status: "renamed" },
        { path: "sources/gone.ts", status: "deleted" },
    ],
    filesTruncated: false,
};

describe("git compare protocol", () => {
    it("lists the files between two commits with the statuses a commit range can have", () => {
        expect(Value.Check(gitCompareResponseSchema, compared)).toBe(true);
        expect(Value.Check(gitCompareResponseSchema, { files: [], filesTruncated: true })).toBe(
            true,
        );
        // Only the working tree has untracked or conflicted files; two commits never do.
        for (const status of ["untracked", "conflicted"]) {
            expect(
                Value.Check(gitCompareResponseSchema, {
                    files: [{ path: "sources/main.ts", status }],
                    filesTruncated: false,
                }),
            ).toBe(false);
        }
        expect(Value.Check(gitCompareResponseSchema, { files: [] })).toBe(false);
        expect(Value.Check(gitCompareQuerySchema, { base, head })).toBe(true);
        expect(Value.Check(gitCompareQuerySchema, { base: "", head })).toBe(false);
        expect(Value.Check(gitCompareQuerySchema, { base })).toBe(false);
    });

    it("asks the workspace's compare route with both commits", async () => {
        const requests: URL[] = [];
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "token",
            fetch: async (input, init) => {
                requests.push(new URL(input.toString()));
                expect(init?.method).toBe("GET");
                expect(init?.signal).toBe(controller.signal);
                return Response.json(compared);
            },
        });
        await expect(
            client.compareWorkspaceGit("w9x8y7z6", { base, head }, { signal: controller.signal }),
        ).resolves.toEqual(compared);
        expect(requests.map((url) => url.pathname)).toEqual([
            "/prefix/v0/workspaces/w9x8y7z6/git/compare",
        ]);
        expect(requests[0]?.searchParams.get("base")).toBe(base);
        expect(requests[0]?.searchParams.get("head")).toBe(head);
    });

    it("surfaces an older daemon's 404 as an API error the caller reads as unavailable", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "token",
            fetch: async () =>
                Response.json(
                    { error: { code: "not_found", message: "Not found." } },
                    { status: 404 },
                ),
        });
        const error = await client
            .compareWorkspaceGit("w9x8y7z6", { base, head })
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect((error as HappyAgentApiError).status).toBe(404);
    });
});
