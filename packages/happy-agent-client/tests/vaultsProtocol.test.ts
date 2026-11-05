import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    vaultEntryCreatedPayloadSchema,
    vaultEntryRemovedPayloadSchema,
    vaultEntryUpdatedPayloadSchema,
    vaultSettingsUpdatedPayloadSchema,
    vaultVersionUpdatedPayloadSchema,
} from "../sources/protocol/events.js";
import { createSurfaceRequestSchema } from "../sources/protocol/surfaces.js";
import {
    DEFAULT_VAULT_RETENTION,
    vaultRetentionSchema,
} from "../sources/protocol/vaultRetention.js";
import {
    createVaultEntryRequestSchema,
    createVaultUploadRequestSchema,
    createVaultVersionRequestSchema,
    restoreVaultEntryRequestSchema,
    updateVaultEntryRequestSchema,
    updateVaultSettingsRequestSchema,
    vaultActivitySchema,
    vaultEntryLocationResponseSchema,
    vaultEntryNameSchema,
    vaultEntrySchema,
    vaultResolveResponseSchema,
    vaultSearchResponseSchema,
    vaultUploadSchema,
    vaultVersionDetailSchema,
    vaultVersionSchema,
    type VaultEntry,
    type VaultVersion,
} from "../sources/protocol/vaults.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const now = 1_755_400_000_000;
const surfaceId = "s12345678901234567890123";
const sha256 = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
const person = { userId: "u1x2y3z4a5b6c7d8e9f0g1h2", agentId: null };
const agent = { userId: null, agentId: "a9b8c7d6e5f4g3h2i1j0k9l8" };

const common = {
    id: "e4k8m2q9w1e5r7y3u6i0o2p4",
    surfaceId,
    parentId: "f7k2m9q4w1e5t8y3u6i0o2p5",
    createdAt: now,
    createdBy: person,
    updatedAt: now,
    updatedBy: agent,
    deletedAt: null,
    version,
};
const file: VaultEntry = {
    ...common,
    name: "summary.pdf",
    kind: "file",
    latestVersion: 3,
    size: 48_213,
    sha256,
    mediaType: "application/pdf",
    artifact: null,
};
const folder: VaultEntry = {
    ...common,
    id: "f7k2m9q4w1e5t8y3u6i0o2p5",
    parentId: null,
    name: "Reports",
    kind: "folder",
    latestVersion: null,
    size: null,
    sha256: null,
    mediaType: null,
    artifact: null,
};
const site: VaultEntry = {
    ...common,
    name: "launch",
    kind: "artifact",
    latestVersion: 1,
    size: 4096,
    sha256: null,
    mediaType: null,
    artifact: { type: "html", entry: "index.html", fileCount: 2 },
};
const fileVersion: VaultVersion = {
    entryId: file.id,
    surfaceId,
    number: 3,
    size: 48_213,
    sha256,
    artifact: null,
    pinned: false,
    restoredFrom: 1,
    createdAt: now,
    actor: agent,
    source: "tool",
};

describe("vault Surface protocol", () => {
    it("creates vaults with an optional retention policy and advertises them in health", () => {
        expect(Value.Check(createSurfaceRequestSchema, { type: "vault", name: "Studio" })).toBe(
            true,
        );
        expect(
            Value.Check(createSurfaceRequestSchema, {
                type: "vault",
                name: "Studio",
                id: surfaceId,
                image: { data: "AAAA" },
                retention: DEFAULT_VAULT_RETENTION,
                mutationId: "create",
            }),
        ).toBe(true);
        expect(
            Value.Check(createSurfaceRequestSchema, { type: "todo", name: "x", retention: {} }),
        ).toBe(false);
        expect(Value.Check(healthResponseSchema.properties.capabilities, { vaults: true })).toBe(
            true,
        );
    });

    it("bounds retention policies", () => {
        expect(Value.Check(vaultRetentionSchema, DEFAULT_VAULT_RETENTION)).toBe(true);
        const keepEverything = {
            maxVersions: null,
            maxAgeDays: null,
            keepAllDays: 0,
            thinning: [],
            trashDays: null,
        };
        expect(Value.Check(vaultRetentionSchema, keepEverything)).toBe(true);
        expect(Value.Check(vaultRetentionSchema, { ...keepEverything, maxVersions: 10 })).toBe(
            true,
        );
        for (const invalid of [
            { maxVersions: 0 },
            { maxAgeDays: 0 },
            { keepAllDays: -1 },
            { trashDays: 0 },
            { thinning: [{ afterDays: 1, everyDays: 0 }] },
            { thinning: Array.from({ length: 9 }, (_, i) => ({ afterDays: i, everyDays: 1 })) },
            { unknown: true },
        ])
            expect(Value.Check(vaultRetentionSchema, { ...keepEverything, ...invalid })).toBe(
                false,
            );
        const { trashDays: _trashDays, ...withoutTrash } = keepEverything;
        expect(Value.Check(vaultRetentionSchema, withoutTrash)).toBe(false);
        expect(Value.Check(updateVaultSettingsRequestSchema, { retention: keepEverything })).toBe(
            true,
        );
        expect(Value.Check(updateVaultSettingsRequestSchema, { mutationId: "m" })).toBe(false);
    });

    it("refuses names that cannot be one path segment", () => {
        for (const name of ["summary.pdf", "Q3", "Résumé", ".hidden", "..a", "a b"])
            expect(Value.Check(vaultEntryNameSchema, name)).toBe(true);
        for (const name of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\nb", "x".repeat(256)])
            expect(Value.Check(vaultEntryNameSchema, name)).toBe(false);
    });

    it("ties each entry kind to the fields it carries", () => {
        for (const entry of [file, folder, site])
            expect(Value.Check(vaultEntrySchema, entry)).toBe(true);
        expect(Value.Check(vaultEntrySchema, { ...file, size: 0 })).toBe(true);
        expect(Value.Check(vaultEntrySchema, { ...file, deletedAt: now })).toBe(true);
        expect(Value.Check(vaultEntrySchema, { ...folder, latestVersion: 1 })).toBe(false);
        expect(Value.Check(vaultEntrySchema, { ...file, sha256: null })).toBe(false);
        expect(Value.Check(vaultEntrySchema, { ...file, artifact: site.artifact })).toBe(false);
        expect(Value.Check(vaultEntrySchema, { ...site, mediaType: "text/html" })).toBe(false);
        expect(Value.Check(vaultEntrySchema, { ...site, artifact: null })).toBe(false);
        expect(
            Value.Check(vaultEntrySchema, {
                ...site,
                artifact: { type: "html", entry: "main.html", fileCount: 1 },
            }),
        ).toBe(false);
        expect(
            Value.Check(vaultEntryLocationResponseSchema, {
                entry: file,
                path: "/Reports/summary.pdf",
                ancestors: [{ id: folder.id, name: "Reports" }],
                inTrash: false,
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultResolveResponseSchema, {
                entry: site,
                path: "/Reports/launch",
                ancestors: [{ id: folder.id, name: "Reports" }],
                inTrash: false,
                innerPath: "img/hero.png",
            }),
        ).toBe(true);
    });

    it("models versions, manifests, activity, and search results", () => {
        expect(Value.Check(vaultVersionSchema, fileVersion)).toBe(true);
        const siteVersion = {
            ...fileVersion,
            entryId: site.id,
            number: 1,
            size: 4096,
            sha256: null,
            restoredFrom: null,
            artifact: { type: "html", entry: "index.html", fileCount: 2 },
        };
        expect(Value.Check(vaultVersionSchema, siteVersion)).toBe(true);
        expect(Value.Check(vaultVersionDetailSchema, siteVersion)).toBe(false);
        expect(
            Value.Check(vaultVersionDetailSchema, {
                ...siteVersion,
                artifact: {
                    ...siteVersion.artifact,
                    files: [
                        { path: "index.html", mimeType: "text/html", size: 4000, sha256 },
                        { path: "img/hero.png", mimeType: "image/png", size: 96, sha256 },
                    ],
                },
            }),
        ).toBe(true);
        expect(Value.Check(vaultVersionDetailSchema, fileVersion)).toBe(true);
        expect(Value.Check(vaultVersionSchema, { ...fileVersion, number: 0 })).toBe(false);

        const activity = { id: version, entryId: file.id, at: now, actor: person, source: "api" };
        for (const item of [
            { ...activity, kind: "created", name: "a.txt", parentId: null, copiedFrom: null },
            {
                ...activity,
                kind: "moved",
                fromParentId: null,
                toParentId: folder.id,
                fromName: "draft.pdf",
                toName: "summary.pdf",
            },
            { ...activity, kind: "deleted" },
            { ...activity, kind: "restored", name: "a.txt", parentId: null },
            { ...activity, kind: "version_created", number: 2, restoredFrom: null },
            { ...activity, kind: "pinned", number: 2 },
            { ...activity, kind: "unpinned", number: 2 },
        ])
            expect(Value.Check(vaultActivitySchema, item)).toBe(true);
        expect(Value.Check(vaultActivitySchema, { ...activity, kind: "pinned" })).toBe(false);

        expect(
            Value.Check(vaultSearchResponseSchema, {
                results: [
                    {
                        entry: file,
                        path: "/Reports/summary.pdf",
                        match: "name",
                        innerPath: null,
                        line: null,
                        snippet: null,
                    },
                    {
                        entry: site,
                        path: "/Reports/launch",
                        match: "content",
                        innerPath: "index.html",
                        line: 12,
                        snippet: "<h1>Launch day</h1>",
                    },
                ],
                truncated: false,
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultSearchResponseSchema.properties.results.items, {
                entry: file,
                path: "/a",
                match: "content",
                innerPath: null,
                line: null,
                snippet: "x",
            }),
        ).toBe(false);
    });

    it("accepts exactly one content source and never a client-supplied author", () => {
        const base = { parentId: null, name: "Q3" };
        expect(Value.Check(createVaultEntryRequestSchema, { ...base, kind: "folder" })).toBe(true);
        expect(
            Value.Check(createVaultEntryRequestSchema, {
                ...base,
                kind: "file",
                uploadId: "u8p2l4o6a1d3e5f7g9h0j2k4",
                id: file.id,
                mutationId: "m",
            }),
        ).toBe(true);
        expect(
            Value.Check(createVaultEntryRequestSchema, {
                ...base,
                kind: "artifact",
                fromEntryId: site.id,
                fromVersion: 1,
            }),
        ).toBe(true);
        for (const invalid of [
            { ...base, kind: "folder", uploadId: "u8p2" },
            { ...base, kind: "file" },
            { ...base, kind: "file", uploadId: "u", fromEntryId: "e" },
            { ...base, kind: "file", uploadId: "u", createdBy: person },
            { name: "Q3", kind: "folder" },
        ])
            expect(Value.Check(createVaultEntryRequestSchema, invalid)).toBe(false);

        expect(Value.Check(updateVaultEntryRequestSchema, { name: "b" })).toBe(true);
        expect(Value.Check(updateVaultEntryRequestSchema, { parentId: null })).toBe(true);
        expect(Value.Check(updateVaultEntryRequestSchema, { mutationId: "m" })).toBe(false);
        expect(Value.Check(restoreVaultEntryRequestSchema, {})).toBe(true);
        expect(Value.Check(createVaultVersionRequestSchema, { uploadId: "u" })).toBe(true);
        expect(Value.Check(createVaultVersionRequestSchema, { fromVersion: 2 })).toBe(true);
        expect(
            Value.Check(createVaultVersionRequestSchema, { uploadId: "u", fromVersion: 2 }),
        ).toBe(false);
        expect(Value.Check(createVaultVersionRequestSchema, {})).toBe(false);
    });

    it("models resumable uploads", () => {
        const upload = {
            id: "u8p2l4o6a1d3e5f7g9h0j2k4",
            size: 734_003_200,
            received: 268_435_456,
            sha256: null,
            status: "receiving",
            createdAt: now,
            expiresAt: now + 86_400_000,
        };
        expect(Value.Check(vaultUploadSchema, upload)).toBe(true);
        expect(
            Value.Check(vaultUploadSchema, {
                ...upload,
                received: upload.size,
                status: "complete",
                sha256,
            }),
        ).toBe(true);
        expect(Value.Check(vaultUploadSchema, { ...upload, status: "complete" })).toBe(false);
        expect(Value.Check(createVaultUploadRequestSchema, { size: 0 })).toBe(true);
        expect(Value.Check(createVaultUploadRequestSchema, { size: 10, sha256 })).toBe(true);
        expect(Value.Check(createVaultUploadRequestSchema, { size: 68_719_476_737 })).toBe(false);
        expect(Value.Check(createVaultUploadRequestSchema, { size: 1, sha256: "ABC" })).toBe(false);
    });

    it("carries shared entry, version, removal, and settings events", () => {
        expect(Value.Check(vaultEntryCreatedPayloadSchema, { entry: file, mutationId: "m" })).toBe(
            true,
        );
        const updated = {
            surfaceId,
            entryId: file.id,
            previousVersion: version,
            version: nextVersion,
        };
        expect(
            Value.Check(vaultEntryUpdatedPayloadSchema, {
                ...updated,
                changes: {
                    name: "b.pdf",
                    mediaType: "application/pdf",
                    updatedAt: now,
                    updatedBy: person,
                },
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultEntryUpdatedPayloadSchema, {
                ...updated,
                changes: { latestVersion: 4, size: 1, sha256, updatedAt: now, updatedBy: agent },
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultEntryUpdatedPayloadSchema, {
                ...updated,
                changes: { deletedAt: now, updatedAt: now },
            }),
        ).toBe(false);
        expect(Value.Check(vaultEntryRemovedPayloadSchema, { surfaceId, entryId: file.id })).toBe(
            true,
        );
        expect(
            Value.Check(vaultVersionUpdatedPayloadSchema, {
                surfaceId,
                entryId: file.id,
                number: 2,
                pinned: true,
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultSettingsUpdatedPayloadSchema, {
                surfaceId,
                previousVersion: version,
                version: nextVersion,
                changes: { retention: DEFAULT_VAULT_RETENTION, updatedAt: now },
            }),
        ).toBe(true);
    });

    it("uses the vault prefix, encodes identities, and sends version guards", async () => {
        const requests: {
            method: string;
            url: string;
            body: unknown;
            ifMatch: string | null;
            contentRange: string | null;
        }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            const headers = new Headers(init?.headers);
            requests.push({
                method: init?.method ?? "GET",
                url: input.toString(),
                body:
                    typeof init?.body === "string"
                        ? JSON.parse(init.body)
                        : init?.body instanceof Uint8Array
                          ? Array.from(init.body)
                          : null,
                ifMatch: headers.get("if-match"),
                contentRange: headers.get("content-range"),
            });
            return new Response(JSON.stringify({ entry: file }), { status: 200 });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const entryId = file.id;
        await client.getVaultSettings(surfaceId);
        await client.updateVaultSettings(surfaceId, { retention: DEFAULT_VAULT_RETENTION });
        await client.listVaultEntries(surfaceId, { parentId: folder.id, sort: "size", limit: 2 });
        await client.getVaultEntry(surfaceId, "entry/1");
        await client.resolveVaultPath(surfaceId, "/Reports/Q3 & co/summary.pdf");
        await client.listVaultTree(surfaceId, { pageCursor: "p1" });
        await client.searchVault(surfaceId, { q: "launch day", kind: "content" });
        await client.listVaultTrash(surfaceId);
        await client.createVaultEntry(surfaceId, { parentId: null, name: "Q3", kind: "folder" });
        await client.updateVaultEntry(surfaceId, entryId, { name: "b.pdf" }, { ifMatch: version });
        await client.deleteVaultEntry(surfaceId, entryId, { ifMatch: version, mutationId: "d" });
        await client.restoreVaultEntry(surfaceId, entryId, {}, { ifMatch: nextVersion });
        await client.listVaultVersions(surfaceId, entryId, { limit: 5 });
        await client.getVaultVersion(surfaceId, entryId, "latest");
        await client.createVaultVersion(
            surfaceId,
            entryId,
            { fromVersion: 1 },
            { ifMatch: version },
        );
        await client.pinVaultVersion(surfaceId, entryId, 2);
        await client.unpinVaultVersion(surfaceId, entryId, 2, { mutationId: "u" });
        await client.listVaultActivity(surfaceId, entryId);
        await client.createVaultUpload({ size: 3 });
        await client.uploadVaultChunk("upload1", {
            data: new Uint8Array([1, 2]),
            start: 4,
            size: 6,
        });
        await client.uploadVaultChunk("upload1", { data: new Uint8Array([7]) });
        await client.getVaultUpload("upload1");
        await client.cancelVaultUpload("upload1");

        const base = `http://agent.local/v0/surfaces/vault/${surfaceId}`;
        const entry = `${base}/entries/${entryId}`;
        const get = (url: string) => ({
            method: "GET",
            url,
            body: null,
            ifMatch: null,
            contentRange: null,
        });
        expect(requests).toEqual([
            get(`${base}/settings`),
            {
                method: "PATCH",
                url: `${base}/settings`,
                body: { retention: DEFAULT_VAULT_RETENTION },
                ifMatch: null,
                contentRange: null,
            },
            get(`${base}/entries?parentId=${folder.id}&sort=size&limit=2`),
            get(`${base}/entries/entry%2F1`),
            get(`${base}/resolve?path=%2FReports%2FQ3+%26+co%2Fsummary.pdf`),
            get(`${base}/tree?pageCursor=p1`),
            get(`${base}/search?q=launch+day&kind=content`),
            get(`${base}/trash`),
            {
                method: "POST",
                url: `${base}/entries`,
                body: { parentId: null, name: "Q3", kind: "folder" },
                ifMatch: null,
                contentRange: null,
            },
            {
                method: "PATCH",
                url: entry,
                body: { name: "b.pdf" },
                ifMatch: version,
                contentRange: null,
            },
            {
                method: "POST",
                url: `${entry}/delete`,
                body: { mutationId: "d" },
                ifMatch: version,
                contentRange: null,
            },
            {
                method: "POST",
                url: `${entry}/restore`,
                body: {},
                ifMatch: nextVersion,
                contentRange: null,
            },
            get(`${entry}/versions?limit=5`),
            get(`${entry}/versions/latest`),
            {
                method: "POST",
                url: `${entry}/versions`,
                body: { fromVersion: 1 },
                ifMatch: version,
                contentRange: null,
            },
            {
                method: "POST",
                url: `${entry}/versions/2/pin`,
                body: {},
                ifMatch: null,
                contentRange: null,
            },
            {
                method: "POST",
                url: `${entry}/versions/2/unpin`,
                body: { mutationId: "u" },
                ifMatch: null,
                contentRange: null,
            },
            get(`${entry}/activity`),
            {
                method: "POST",
                url: "http://agent.local/v0/vault-uploads",
                body: { size: 3 },
                ifMatch: null,
                contentRange: null,
            },
            {
                method: "PUT",
                url: "http://agent.local/v0/vault-uploads/upload1",
                body: [1, 2],
                ifMatch: null,
                contentRange: "bytes 4-5/6",
            },
            {
                method: "PUT",
                url: "http://agent.local/v0/vault-uploads/upload1",
                body: [7],
                ifMatch: null,
                contentRange: null,
            },
            get("http://agent.local/v0/vault-uploads/upload1"),
            {
                method: "DELETE",
                url: "http://agent.local/v0/vault-uploads/upload1",
                body: null,
                ifMatch: null,
                contentRange: null,
            },
        ]);
    });

    it("builds content, site, and zip URLs and reads bytes by range", async () => {
        const requests: Request[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            const request = new Request(input, init);
            requests.push(request);
            if (request.headers.get("if-none-match") === `"${sha256}"`)
                return new Response(null, { status: 304 });
            if (request.headers.get("range") !== null)
                return new Response(new Uint8Array([2, 3]), {
                    status: 206,
                    headers: { "content-type": "video/mp4", "content-range": "bytes 1-2/3" },
                });
            return new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "video/mp4", etag: `"${sha256}"` },
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local/", token: "t", fetch });
        const entry = `http://agent.local/v0/surfaces/vault/${surfaceId}/entries/${file.id}`;

        expect(client.vaultFileContentUrl(surfaceId, file.id, 3)).toBe(
            `${entry}/versions/3/content`,
        );
        expect(client.vaultFileContentUrl(surfaceId, file.id, "latest", { download: true })).toBe(
            `${entry}/versions/latest/content?download=true`,
        );
        expect(client.vaultArtifactFileUrl(surfaceId, site.id, 1, "img/hero #1.png")).toBe(
            `http://agent.local/v0/surfaces/vault/${surfaceId}/entries/${site.id}/versions/1/files/img/hero%20%231.png`,
        );
        expect(client.vaultArtifactZipUrl(surfaceId, file.id, 2)).toBe(`${entry}/versions/2/zip`);
        expect(client.vaultFolderZipUrl(surfaceId, file.id)).toBe(`${entry}/zip`);
        expect(client.vaultFolderZipUrl(surfaceId)).toBe(
            `http://agent.local/v0/surfaces/vault/${surfaceId}/zip`,
        );

        const whole = await client.getVaultFileContent(surfaceId, file.id, 3);
        expect(whole?.etag).toBe(`"${sha256}"`);
        expect(new Uint8Array(whole!.data)).toEqual(new Uint8Array([1, 2, 3]));
        expect(whole?.contentRange).toBeNull();
        const range = await client.getVaultFileContent(surfaceId, file.id, 3, {
            range: { start: 1, end: 2 },
        });
        expect(range?.contentRange).toBe("bytes 1-2/3");
        expect(requests[1]?.headers.get("range")).toBe("bytes=1-2");
        expect(
            await client.getVaultArtifactFile(surfaceId, site.id, 1, "index.html", {
                ifNoneMatch: `"${sha256}"`,
            }),
        ).toBeNull();
        expect(requests[2]?.url).toBe(
            `http://agent.local/v0/surfaces/vault/${surfaceId}/entries/${site.id}/versions/1/files/index.html`,
        );
    });

    it("surfaces name and version conflicts with the entry they concern", async () => {
        const replies = [
            {
                status: 409,
                body: {
                    error: "A file with this name already exists.",
                    code: "name_taken",
                    entry: file,
                },
            },
            {
                status: 409,
                body: {
                    error: "The upload is behind.",
                    code: "conflict",
                    upload: {
                        id: "upload1",
                        size: 6,
                        received: 2,
                        sha256: null,
                        status: "receiving",
                        createdAt: now,
                        expiresAt: now,
                    },
                },
            },
        ];
        let calls = 0;
        const fetch: typeof globalThis.fetch = async () => {
            const reply = replies[calls]!;
            calls += 1;
            return new Response(JSON.stringify(reply.body), { status: reply.status });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const taken = await client
            .updateVaultEntry(surfaceId, site.id, { name: "summary.pdf" }, { ifMatch: version })
            .catch((error: unknown) => error);
        expect(taken).toBeInstanceOf(HappyAgentApiError);
        expect((taken as HappyAgentApiError).code).toBe("name_taken");
        expect((taken as HappyAgentApiError).body).toMatchObject({ entry: { id: file.id } });
        const behind = await client
            .uploadVaultChunk("upload1", { data: new Uint8Array([1]), start: 4, size: 6 })
            .catch((error: unknown) => error);
        expect((behind as HappyAgentApiError).body).toMatchObject({ upload: { received: 2 } });
        expect(calls).toBe(2);
    });
});
