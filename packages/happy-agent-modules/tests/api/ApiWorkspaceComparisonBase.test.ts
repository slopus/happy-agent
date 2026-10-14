import { describe, expect, it } from "vitest";
import { workspaceId as rootWorkspaceId } from "../services/support/servicesHarness.js";
import { serviceApiHarness } from "./support/serviceApiHarness.js";

describe("choosing a workspace's comparison branch over HTTP", () => {
    it("sets, shows, and clears the branch under the workspace's version", async () => {
        const f = await serviceApiHarness();
        try {
            const call = async (
                method: "GET" | "PATCH",
                id: string,
                body?: unknown,
                ifMatch?: string,
            ): Promise<{ status: number; body: Record<string, any> }> => {
                const response = await fetch(`${f.endpoint}/v0/workspaces/${id}`, {
                    method,
                    headers: {
                        authorization: `Bearer ${f.token}`,
                        "content-type": "application/json",
                        ...(ifMatch === undefined ? {} : { "if-match": ifMatch }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
                return { status: response.status, body: (await response.json()) as never };
            };
            const { workspace: reserved } = await f.workspaces.reserve(f.ctx, {
                id: "aacompare",
                projectRef: rootWorkspaceId,
                name: "Compare",
            });
            const before = (await call("GET", reserved.id)).body["workspace"];
            expect(before).toMatchObject({ comparisonBase: null });

            expect((await call("PATCH", reserved.id, {}, before.version)).status).toBe(400);
            expect(
                (await call("PATCH", reserved.id, { comparisonBase: "-main" }, before.version))
                    .status,
            ).toBe(400);
            expect(await call("PATCH", rootWorkspaceId, { comparisonBase: "main" })).toMatchObject({
                status: 409,
                body: { error: "A project's own folder has no comparison branch to choose." },
            });

            const chosen = await call(
                "PATCH",
                reserved.id,
                { comparisonBase: "release-v8.8" },
                before.version,
            );
            expect(chosen).toMatchObject({
                status: 200,
                body: { workspace: { comparisonBase: "release-v8.8", name: "Compare" } },
            });
            expect((await call("GET", reserved.id)).body["workspace"]).toMatchObject({
                comparisonBase: "release-v8.8",
                version: chosen.body["workspace"].version,
            });
            // A choice made against an older version is refused rather than overwriting a newer one.
            expect(
                (await call("PATCH", reserved.id, { comparisonBase: "main" }, before.version))
                    .status,
            ).toBe(409);

            const cleared = await call(
                "PATCH",
                reserved.id,
                { comparisonBase: null, name: "Renamed" },
                chosen.body["workspace"].version,
            );
            expect(cleared).toMatchObject({
                status: 200,
                body: { workspace: { comparisonBase: null, name: "Renamed" } },
            });
        } finally {
            await f.close();
        }
    });
});
