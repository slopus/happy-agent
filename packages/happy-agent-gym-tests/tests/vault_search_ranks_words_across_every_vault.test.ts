import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import type { HappyAgentClient, VaultSearchResponse } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function upload(client: HappyAgentClient, text: string) {
    const bytes = new TextEncoder().encode(text);
    const created = (await client.createVaultUpload({ size: bytes.length })).upload;
    await client.uploadVaultChunk(created.id, { data: bytes, start: 0, size: bytes.length });
    return created.id;
}

const listed = (response: VaultSearchResponse) =>
    response.results.map((result) =>
        [result.item.surfaceId, result.match, result.path, result.line, result.snippet].join(" "),
    );

describe("vault search through the real daemon", () => {
    it("ranks words in tiers within one vault and across every vault", async () => {
        const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
        running.push(gym);
        const client = gym.client;
        expect((await client.getHealth()).capabilities?.vaultSearch).toBe(true);
        const studio = (await client.createSurface({ type: "vault", name: "Studio" })).surface;
        const archive = (await client.createSurface({ type: "vault", name: "Archive" })).surface;
        const docs = (await client.createVaultFolder(studio.id, { name: "Docs", parentId: null }))
            .folder;
        const plans = (
            await client.createVaultFolder(studio.id, {
                name: "Rocket plans for spring",
                parentId: docs.id,
            })
        ).folder;
        await client.createVaultFile(studio.id, {
            name: "budget.md",
            parentId: plans.id,
            uploadId: await upload(client, "Fuel\nThe rocket needs more fuel than we thought\n"),
        });
        await client.createVaultFile(studio.id, {
            name: "Rocket.txt",
            parentId: null,
            uploadId: await upload(client, "a name only"),
        });
        await client.createVaultFile(archive.id, {
            name: "rockets of 1969.md",
            parentId: null,
            uploadId: await upload(client, "Saturn V"),
        });

        // Own names, then content, then paths; type-ahead prefixes find the same.
        const studioHits = [
            `${studio.id} name /Rocket.txt  `,
            `${studio.id} name /Docs/Rocket plans for spring  `,
            `${studio.id} content /Docs/Rocket plans for spring/budget.md 2 The rocket needs more fuel than we thought`,
            `${studio.id} name /Docs/Rocket plans for spring/budget.md  `,
        ];
        expect(listed(await client.searchVault(studio.id, { q: "rocket" }))).toEqual(studioHits);
        expect(listed(await client.searchVault(studio.id, { q: "ROCK" }))).toEqual(studioHits);

        // Every vault at once, the other vault's own-name match among the names.
        const everywhere = await client.searchVaults({ q: "rocket", kind: "name" });
        expect(everywhere.results.map((result) => result.item.surfaceId)).toContain(archive.id);
        expect(everywhere.results.every((result) => result.match === "name")).toBe(true);
        expect(listed(await client.searchVaults({ q: "saturn" }))).toEqual([
            `${archive.id} content /rockets of 1969.md 1 Saturn V`,
        ]);
        expect((await client.searchVaults({ q: "fuel", limit: 1 })).truncated).toBe(false);

        // Renaming a folder moves the path matches with it at once.
        await client.updateVaultFolder(
            studio.id,
            plans.id,
            { name: "Lander" },
            {
                ifMatch: plans.version,
            },
        );
        expect(listed(await client.searchVaults({ q: "lander budget" }))).toEqual([
            `${studio.id} name /Docs/Lander/budget.md  `,
        ]);
        await expect(client.searchVaults({ q: "" })).rejects.toMatchObject({ status: 400 });
        await expect(
            client.searchVaults({ q: "x", parentId: docs.id } as never),
        ).rejects.toMatchObject({ status: 400 });
    }, 600_000);
});
