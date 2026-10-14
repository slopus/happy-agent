import { describe, expect, it } from "vitest";
import { workspaceId as rootWorkspaceId } from "../services/support/servicesHarness.js";
import { serviceApiHarness } from "./support/serviceApiHarness.js";

describe("listing a workspace's branches over HTTP", () => {
    it("refuses a malformed query before reading the repository", async () => {
        const f = await serviceApiHarness();
        try {
            const status = async (path: string): Promise<number> =>
                (
                    await fetch(`${f.endpoint}${path}`, {
                        headers: { authorization: `Bearer ${f.token}` },
                    })
                ).status;
            const branches = `/v0/workspaces/${rootWorkspaceId}/git/branches`;

            for (const query of [
                "?limit=0",
                "?limit=201",
                "?limit=ten",
                `?query=${"x".repeat(201)}`,
                "?query=a%0Ab",
                "?branch=main",
            ]) {
                expect(await status(`${branches}${query}`)).toBe(400);
            }
            expect(await status("/v0/workspaces/aamissing/git/branches")).toBe(404);
        } finally {
            await f.close();
        }
    });
});
