import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import type { HappyAgentClient } from "@slopus/happy-agent-client";
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

/** Posts a new version over the daemon's socket, keeping the status the client hides. */
async function postVersion(
    gym: AgentGym,
    surfaceId: string,
    fileId: string,
    ifMatch: string,
    body: Record<string, unknown>,
) {
    const response = await fetch(
        `http://localhost/v0/surfaces/vault/${surfaceId}/files/${fileId}/versions`,
        {
            method: "POST",
            unix: gym.socketPath,
            headers: {
                authorization: `Bearer ${gym.token}`,
                "content-type": "application/json",
                "if-match": ifMatch,
            },
            body: JSON.stringify(body),
        } as RequestInit,
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("vault versions with an operation ID", () => {
    it("answer a lost response's retry with the version the first attempt made", async () => {
        const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
        running.push(gym);
        const client = gym.client;
        const vault = (await client.createSurface({ type: "vault", name: "Files" })).surface;
        const plan = (
            await client.createVaultFile(vault.id, {
                name: "Plan.md",
                parentId: null,
                uploadId: await upload(client, "first draft of the plan\n"),
            })
        ).file;

        const first = await postVersion(gym, vault.id, plan.id, plan.version, {
            uploadId: await upload(client, "second draft of the plan\n"),
            operationId: "attempt-1",
        });
        expect(first.status).toBe(201);
        expect(first.body.version).toMatchObject({ number: 2 });

        // The retry carries a stale If-Match and another upload; neither is looked at.
        const spare = await upload(client, "a different draft entirely\n");
        const retry = await postVersion(gym, vault.id, plan.id, plan.version, {
            uploadId: spare,
            operationId: "attempt-1",
        });
        expect(retry).toEqual(first);
        expect((await client.getVaultUpload(spare)).upload.status).toBe("complete");
        expect(
            (await client.listVaultVersions(vault.id, plan.id)).versions.map((v) => v.number),
        ).toEqual([2, 1]);

        // An attempt that made no version is repeated as 200 with no version.
        const same = await client.createVaultVersion(
            vault.id,
            plan.id,
            { fromVersion: 2, operationId: "attempt-2" },
            { ifMatch: first.body.file.version },
        );
        expect(same.version).toBeNull();
        const sameAgain = await postVersion(gym, vault.id, plan.id, "stale", {
            fromVersion: 1,
            operationId: "attempt-2",
        });
        expect(sameAgain.status).toBe(200);
        expect(sameAgain.body.version).toBeNull();

        // The answer reflects the version as it is now.
        await client.pinVaultVersion(vault.id, plan.id, 2);
        const pinned = await postVersion(gym, vault.id, plan.id, "stale", {
            fromVersion: 1,
            operationId: "attempt-1",
        });
        expect(pinned.status).toBe(201);
        expect(pinned.body.version).toMatchObject({ number: 2, pinned: true });

        // Without an operation ID the If-Match still applies.
        const stale = await postVersion(gym, vault.id, plan.id, plan.version, { fromVersion: 1 });
        expect(stale.status).toBe(409);

        // A refused attempt records nothing, so its retry with the current If-Match goes through.
        const refused = await postVersion(gym, vault.id, plan.id, plan.version, {
            fromVersion: 1,
            operationId: "attempt-3",
        });
        expect(refused.status).toBe(409);
        const retried = await postVersion(gym, vault.id, plan.id, refused.body.currentVersion, {
            fromVersion: 1,
            operationId: "attempt-3",
        });
        expect(retried.status).toBe(201);
        expect(retried.body.version).toMatchObject({ number: 3, restoredFrom: 1 });
    }, 600_000);
});
