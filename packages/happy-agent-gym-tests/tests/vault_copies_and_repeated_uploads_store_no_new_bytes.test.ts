import { createHash, randomBytes } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** The file size; set `VAULT_PROOF_BYTES=209715200` to prove it on a 200 MB file. */
const SIZE = Number(process.env.VAULT_PROOF_BYTES ?? 3 * 1024 * 1024);
const CHUNK = 64 * 1024 * 1024;

/** The bytes and file count below a folder, or zero when it does not exist. */
async function usage(path: string): Promise<{ bytes: number; files: number }> {
    const names = await readdir(path, { recursive: true }).catch(() => []);
    let bytes = 0;
    let files = 0;
    for (const name of names) {
        const facts = await stat(join(path, name));
        if (!facts.isFile()) continue;
        bytes += facts.size;
        files += 1;
    }
    return { bytes, files };
}

async function upload(client: HappyAgentClient, data: Uint8Array, sha256: string) {
    let current = (await client.createVaultUpload({ size: data.byteLength, sha256 })).upload;
    for (let start = 0; start < data.byteLength; start += CHUNK)
        current = (
            await client.uploadVaultChunk(current.id, {
                data: data.subarray(start, Math.min(start + CHUNK, data.byteLength)),
                start,
                size: data.byteLength,
            })
        ).upload;
    expect(current).toMatchObject({ status: "complete", sha256 });
    return current.id;
}

describe("vault copies and repeated uploads", () => {
    it("reuse the stored bytes through the API and the agent's copy tool", async () => {
        let agentId = "";
        const turns: GymTurn[] = [];
        const gym = await createAgentGym({
            timeoutMs: 120_000,
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Copies</title>" }] };
                if (request.sessionId !== agentId)
                    return {
                        content: [
                            { type: "text", text: "<review><outcome>deny</outcome></review>" },
                        ],
                    };
                return turns.shift() ?? { content: [{ type: "text", text: "Copied." }] };
            },
        });
        running.push(gym);
        agentId = gym.defaultSessionId;
        const client = gym.client;
        const vaults = join(gym.happyHome, "agent", "vaults");
        const content = join(vaults, "content");
        const uploads = join(vaults, "uploads");

        const data = new Uint8Array(SIZE);
        for (let at = 0; at < SIZE; at += 65_536)
            data.set(randomBytes(Math.min(65_536, SIZE - at)), at);
        const sha256 = createHash("sha256").update(data).digest("hex");
        const studio = (await client.createSurface({ type: "vault", name: "Studio" })).surface;
        const archive = (await client.createSurface({ type: "vault", name: "Archive" })).surface;
        const original = (
            await client.createVaultEntry(studio.id, {
                kind: "file",
                name: "big.bin",
                parentId: null,
                uploadId: await upload(client, data, sha256),
            })
        ).entry;
        const before = { content: await usage(content), uploads: await usage(uploads) };
        expect(before.content.bytes).toBeGreaterThanOrEqual(SIZE);
        expect(before.uploads.files).toBe(0);

        const copies = [
            await client.createVaultEntry(studio.id, {
                kind: "file",
                name: "big copy.bin",
                parentId: null,
                fromEntryId: original.id,
            }),
            await client.createVaultEntry(archive.id, {
                kind: "file",
                name: "big.bin",
                parentId: null,
                fromEntryId: original.id,
            }),
        ].map((response) => response.entry);
        const call = (args: Record<string, unknown>): GymTurn => ({
            content: [
                {
                    type: "tool_call",
                    name: "copy_vault_entry",
                    arguments: { surfaceId: studio.id, path: "/big.bin", ...args },
                },
            ],
        });
        turns.push(
            call({ toPath: "/Tool copies/big.bin" }),
            call({ toPath: "/From the tool/big.bin", toSurfaceId: archive.id }),
        );
        await gym.send("Copy big.bin within the studio and into the archive.");
        expect(turns).toEqual([]);
        for (const [vault, path] of [
            [studio.id, "/Tool copies/big.bin"],
            [archive.id, "/From the tool/big.bin"],
        ] as const)
            copies.push((await client.resolveVaultPath(vault, path)).entry);
        for (const copy of copies)
            expect(copy).toMatchObject({ sha256, size: SIZE, latestVersion: 1 });
        const afterCopies = { content: await usage(content), uploads: await usage(uploads) };
        expect(afterCopies).toEqual(before);

        // The same bytes uploaded again are recognized when the last byte arrives.
        const again = await upload(client, data, sha256);
        const afterUpload = { content: await usage(content), uploads: await usage(uploads) };
        expect(afterUpload).toEqual(before);
        expect(
            (
                await client.createVaultVersion(
                    studio.id,
                    original.id,
                    { uploadId: again },
                    { ifMatch: original.version },
                )
            ).version,
        ).toBeNull();

        console.log(
            JSON.stringify({ size: SIZE, before, afterCopies, afterUpload, copies: copies.length }),
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
