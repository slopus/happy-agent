import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import {
    vaultFileCreatedPayloadSchema,
    vaultFileRemovedPayloadSchema,
    vaultFileUpdatedPayloadSchema,
    vaultFolderCreatedPayloadSchema,
    vaultFolderRemovedPayloadSchema,
    vaultFolderUpdatedPayloadSchema,
    vaultSettingsUpdatedPayloadSchema,
    vaultVersionUpdatedPayloadSchema,
} from "../sources/protocol/events.js";
import { createSurfaceRequestSchema } from "../sources/protocol/surfaces.js";
import {
    DEFAULT_VAULT_RETENTION,
    vaultRetentionSchema,
} from "../sources/protocol/vaultRetention.js";
import {
    VAULT_ARTIFACT_MANIFEST_PATH,
    VAULT_ARTIFACT_SUFFIX,
    createVaultFileRequestSchema,
    createVaultFolderRequestSchema,
    createVaultUploadRequestSchema,
    createVaultVersionRequestSchema,
    isVaultArtifactName,
    restoreVaultItemRequestSchema,
    updateVaultItemRequestSchema,
    updateVaultSettingsRequestSchema,
    vaultActivitySchema,
    vaultArtifactDownloadName,
    vaultArtifactManifestSchema,
    vaultFileLocationResponseSchema,
    vaultFileSchema,
    vaultFolderLocationResponseSchema,
    vaultFolderSchema,
    vaultItemPageResponseSchema,
    vaultItemSchema,
    vaultNameSchema,
    vaultResolveResponseSchema,
    vaultTrashPageResponseSchema,
    vaultUploadSchema,
    vaultVersionDetailSchema,
    vaultVersionSchema,
    type VaultFile,
    type VaultFolder,
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
const file: VaultFile = {
    ...common,
    name: "summary.pdf",
    kind: "file",
    latestVersion: 3,
    size: 48_213,
    sha256,
    mediaType: "application/pdf",
    artifact: null,
};
const folder: VaultFolder = {
    ...common,
    id: "f7k2m9q4w1e5t8y3u6i0o2p5",
    parentId: null,
    name: "Reports",
    kind: "folder",
};
const site: VaultFile = {
    ...common,
    name: "launch.artifact",
    kind: "artifact",
    latestVersion: 1,
    size: 4096,
    sha256: null,
    mediaType: null,
    artifact: { type: "html", entry: "index.html", fileCount: 2 },
};
const fileVersion: VaultVersion = {
    fileId: file.id,
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
        expect(
            Value.Check(healthResponseSchema.properties.capabilities, {
                vaults: true,
            }),
        ).toBe(true);
    });

    it("bounds retention policies", () => {
        expect(Value.Check(vaultRetentionSchema, DEFAULT_VAULT_RETENTION)).toBe(true);
        // The default is the Time Machine schedule.
        expect(DEFAULT_VAULT_RETENTION).toEqual({
            maxVersions: null,
            maxAgeDays: null,
            keepAllDays: 1,
            thinning: [
                { afterDays: 1, everyDays: 1 },
                { afterDays: 30, everyDays: 7 },
            ],
            trashDays: 30,
        });
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
            expect(Value.Check(vaultNameSchema, name)).toBe(true);
        for (const name of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\nb", "x".repeat(256)])
            expect(Value.Check(vaultNameSchema, name)).toBe(false);
    });

    it("tells folders and files apart and ties each kind to its fields", () => {
        expect(Value.Check(vaultFolderSchema, folder)).toBe(true);
        expect(Value.Check(vaultFolderSchema, file)).toBe(false);
        for (const each of [file, site]) expect(Value.Check(vaultFileSchema, each)).toBe(true);
        expect(Value.Check(vaultFileSchema, folder)).toBe(false);
        for (const each of [folder, file, site])
            expect(Value.Check(vaultItemSchema, each)).toBe(true);
        expect(Value.Check(vaultFileSchema, { ...file, size: 0 })).toBe(true);
        expect(Value.Check(vaultFileSchema, { ...file, deletedAt: now })).toBe(true);
        expect(Value.Check(vaultFileSchema, { ...file, sha256: null })).toBe(false);
        expect(Value.Check(vaultFileSchema, { ...file, artifact: site.artifact })).toBe(false);
        expect(Value.Check(vaultFileSchema, { ...site, mediaType: "text/html" })).toBe(false);
        expect(Value.Check(vaultFileSchema, { ...site, artifact: null })).toBe(false);
        expect(
            Value.Check(vaultFileSchema, {
                ...site,
                artifact: { type: "html", entry: "main.html", fileCount: 1 },
            }),
        ).toBe(false);
        const where = { ancestors: [{ id: folder.id, name: "Reports" }], inTrash: false };
        expect(
            Value.Check(vaultFileLocationResponseSchema, {
                ...where,
                file,
                path: "/Reports/summary.pdf",
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultFolderLocationResponseSchema, {
                ancestors: [],
                inTrash: false,
                folder,
                path: "/Reports",
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultFolderLocationResponseSchema, { ...where, folder: file, path: "/a" }),
        ).toBe(false);
        expect(
            Value.Check(vaultResolveResponseSchema, {
                ...where,
                item: site,
                path: "/Reports/launch.artifact",
                innerPath: "img/hero.png",
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultItemPageResponseSchema, {
                items: [folder, file, site],
                nextPageCursor: null,
                cursor: "c",
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultTrashPageResponseSchema, {
                items: [
                    { item: folder, path: "/Reports" },
                    { item: file, path: "/Reports/summary.pdf" },
                ],
                nextPageCursor: null,
                cursor: "c",
            }),
        ).toBe(true);
    });

    it("recognizes artifacts by their suffix and reads their manifest", () => {
        expect(VAULT_ARTIFACT_SUFFIX).toBe(".artifact");
        expect(VAULT_ARTIFACT_MANIFEST_PATH).toBe("artifact.json");
        for (const name of ["launch.artifact", "Launch.ARTIFACT", ".artifact"])
            expect(isVaultArtifactName(name)).toBe(true);
        for (const name of ["launch.zip", "launch.artifact.zip", "artifact", "launch.artifacts"])
            expect(isVaultArtifactName(name)).toBe(false);
        expect(vaultArtifactDownloadName(site)).toBe("launch.artifact");
        const manifest = {
            format: "happy.artifact",
            formatVersion: 1,
            type: "html",
            entry: "index.html",
        };
        expect(Value.Check(vaultArtifactManifestSchema, manifest)).toBe(true);
        expect(
            Value.Check(vaultArtifactManifestSchema, { ...manifest, title: "ignored extra" }),
        ).toBe(true);
        for (const invalid of [
            { format: "other" },
            { formatVersion: 2 },
            { type: "pdf" },
            { entry: "main.html" },
        ])
            expect(Value.Check(vaultArtifactManifestSchema, { ...manifest, ...invalid })).toBe(
                false,
            );
    });

    it("models versions, manifests, and activity", () => {
        expect(Value.Check(vaultVersionSchema, fileVersion)).toBe(true);
        const siteVersion = {
            ...fileVersion,
            fileId: site.id,
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

        const activity = { id: version, itemId: file.id, at: now, actor: person, source: "api" };
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
    });

    it("accepts exactly one content source and never a client-supplied author", () => {
        const base = { parentId: null, name: "Q3" };
        expect(Value.Check(createVaultFolderRequestSchema, base)).toBe(true);
        expect(Value.Check(createVaultFolderRequestSchema, { ...base, id: folder.id })).toBe(true);
        expect(Value.Check(createVaultFolderRequestSchema, { ...base, uploadId: "u" })).toBe(false);
        expect(Value.Check(createVaultFolderRequestSchema, { ...base, kind: "folder" })).toBe(
            false,
        );
        expect(
            Value.Check(createVaultFileRequestSchema, {
                ...base,
                uploadId: "u8p2l4o6a1d3e5f7g9h0j2k4",
                id: file.id,
                mutationId: "m",
            }),
        ).toBe(true);
        expect(
            Value.Check(createVaultFileRequestSchema, {
                ...base,
                name: "launch.artifact",
                fromFileId: site.id,
                fromVersion: 1,
            }),
        ).toBe(true);
        for (const invalid of [
            base,
            { ...base, kind: "file", uploadId: "u" },
            { ...base, uploadId: "u", fromFileId: "e" },
            { ...base, uploadId: "u", createdBy: person },
            { name: "Q3", uploadId: "u" },
        ])
            expect(Value.Check(createVaultFileRequestSchema, invalid)).toBe(false);

        expect(Value.Check(updateVaultItemRequestSchema, { name: "b" })).toBe(true);
        expect(Value.Check(updateVaultItemRequestSchema, { parentId: null })).toBe(true);
        expect(Value.Check(updateVaultItemRequestSchema, { mutationId: "m" })).toBe(false);
        expect(Value.Check(restoreVaultItemRequestSchema, {})).toBe(true);
        expect(Value.Check(createVaultVersionRequestSchema, { uploadId: "u" })).toBe(true);
        expect(Value.Check(createVaultVersionRequestSchema, { fromVersion: 2 })).toBe(true);
        expect(
            Value.Check(createVaultVersionRequestSchema, { uploadId: "u", fromVersion: 2 }),
        ).toBe(false);
        expect(Value.Check(createVaultVersionRequestSchema, {})).toBe(false);
        expect(
            Value.Check(createVaultVersionRequestSchema, {
                uploadId: "u",
                operationId: "attempt-1",
            }),
        ).toBe(true);
        expect(
            Value.Check(createVaultVersionRequestSchema, {
                fromVersion: 2,
                operationId: "x".repeat(128),
            }),
        ).toBe(true);
        expect(
            Value.Check(createVaultVersionRequestSchema, { uploadId: "u", operationId: "" }),
        ).toBe(false);
        expect(
            Value.Check(createVaultVersionRequestSchema, {
                uploadId: "u",
                operationId: "x".repeat(129),
            }),
        ).toBe(false);
        expect(
            Value.Check(createVaultVersionRequestSchema, { uploadId: "u", operationId: 7 }),
        ).toBe(false);
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

    it("carries shared folder, file, version, removal, and settings events", () => {
        expect(Value.Check(vaultFileCreatedPayloadSchema, { file, mutationId: "m" })).toBe(true);
        expect(Value.Check(vaultFileCreatedPayloadSchema, { file: folder })).toBe(false);
        expect(Value.Check(vaultFolderCreatedPayloadSchema, { folder })).toBe(true);
        const moved = {
            surfaceId,
            folderId: folder.id,
            previousVersion: version,
            version: nextVersion,
            changes: { name: "Q4", deletedAt: null, updatedAt: now, updatedBy: person },
        };
        expect(Value.Check(vaultFolderUpdatedPayloadSchema, moved)).toBe(true);
        expect(
            Value.Check(vaultFolderRemovedPayloadSchema, { surfaceId, folderId: folder.id }),
        ).toBe(true);
        const updated = {
            surfaceId,
            fileId: file.id,
            previousVersion: version,
            version: nextVersion,
        };
        expect(
            Value.Check(vaultFileUpdatedPayloadSchema, {
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
            Value.Check(vaultFileUpdatedPayloadSchema, {
                ...updated,
                changes: { latestVersion: 4, size: 1, sha256, updatedAt: now, updatedBy: agent },
            }),
        ).toBe(true);
        expect(
            Value.Check(vaultFileUpdatedPayloadSchema, {
                ...updated,
                changes: { deletedAt: now, updatedAt: now },
            }),
        ).toBe(false);
        expect(Value.Check(vaultFileRemovedPayloadSchema, { surfaceId, fileId: file.id })).toBe(
            true,
        );
        expect(
            Value.Check(vaultVersionUpdatedPayloadSchema, {
                surfaceId,
                fileId: file.id,
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
            return new Response(JSON.stringify({ file }), { status: 200 });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const fileId = file.id;
        await client.getVaultSettings(surfaceId);
        await client.updateVaultSettings(surfaceId, { retention: DEFAULT_VAULT_RETENTION });
        await client.listVaultItems(surfaceId, { parentId: folder.id, sort: "size", limit: 2 });
        await client.getVaultFile(surfaceId, "file/1");
        await client.getVaultFolder(surfaceId, folder.id);
        await client.resolveVaultPath(surfaceId, "/Reports/Q3 & co/summary.pdf");
        await client.listVaultTree(surfaceId, { pageCursor: "p1" });
        await client.listVaultTrash(surfaceId);
        await client.createVaultFolder(surfaceId, { parentId: null, name: "Q3" });
        await client.createVaultFile(surfaceId, { parentId: null, name: "a.txt", uploadId: "u1" });
        await client.updateVaultFolder(surfaceId, folder.id, { name: "Q4" }, { ifMatch: version });
        await client.deleteVaultFolder(surfaceId, folder.id, { ifMatch: version });
        await client.restoreVaultFolder(surfaceId, folder.id, {}, { ifMatch: nextVersion });
        await client.updateVaultFile(surfaceId, fileId, { name: "b.pdf" }, { ifMatch: version });
        await client.deleteVaultFile(surfaceId, fileId, { ifMatch: version, mutationId: "d" });
        await client.restoreVaultFile(surfaceId, fileId, {}, { ifMatch: nextVersion });
        await client.listVaultVersions(surfaceId, fileId, { limit: 5 });
        await client.getVaultVersion(surfaceId, fileId, "latest");
        await client.createVaultVersion(
            surfaceId,
            fileId,
            { fromVersion: 1 },
            { ifMatch: version },
        );
        await client.pinVaultVersion(surfaceId, fileId, 2);
        await client.unpinVaultVersion(surfaceId, fileId, 2, { mutationId: "u" });
        await client.listVaultFileActivity(surfaceId, fileId);
        await client.listVaultFolderActivity(surfaceId, folder.id);
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
        const entry = `${base}/files/${fileId}`;
        const dir = `${base}/folders/${folder.id}`;
        const post = (url: string, body: unknown, ifMatch: string | null = null) => ({
            method: "POST",
            url,
            body,
            ifMatch,
            contentRange: null,
        });
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
            get(`${base}/items?parentId=${folder.id}&sort=size&limit=2`),
            get(`${base}/files/file%2F1`),
            get(dir),
            get(`${base}/resolve?path=%2FReports%2FQ3+%26+co%2Fsummary.pdf`),
            get(`${base}/tree?pageCursor=p1`),
            get(`${base}/trash`),
            post(`${base}/folders`, { parentId: null, name: "Q3" }),
            post(`${base}/files`, { parentId: null, name: "a.txt", uploadId: "u1" }),
            {
                method: "PATCH",
                url: dir,
                body: { name: "Q4" },
                ifMatch: version,
                contentRange: null,
            },
            post(`${dir}/delete`, {}, version),
            post(`${dir}/restore`, {}, nextVersion),
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
            get(`${dir}/activity`),
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

    it("builds content, app, and zip URLs and reads bytes by range", async () => {
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
        const entry = `http://agent.local/v0/surfaces/vault/${surfaceId}/files/${file.id}`;

        expect(client.vaultFileContentUrl(surfaceId, file.id, 3)).toBe(
            `${entry}/versions/3/content`,
        );
        expect(client.vaultFileContentUrl(surfaceId, file.id, "latest", { download: true })).toBe(
            `${entry}/versions/latest/content?download=true`,
        );
        expect(client.vaultArtifactFileUrl(surfaceId, site.id, 1, "img/hero #1.png")).toBe(
            `http://agent.local/v0/surfaces/vault/${surfaceId}/files/${site.id}/versions/1/artifact/img/hero%20%231.png`,
        );
        expect(client.vaultArtifactZipUrl(surfaceId, file.id, 2)).toBe(`${entry}/versions/2/zip`);
        expect(client.vaultFolderZipUrl(surfaceId, folder.id)).toBe(
            `http://agent.local/v0/surfaces/vault/${surfaceId}/folders/${folder.id}/zip`,
        );
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
            `http://agent.local/v0/surfaces/vault/${surfaceId}/files/${site.id}/versions/1/artifact/index.html`,
        );
    });

    it("surfaces name and version conflicts with the item they concern", async () => {
        const replies = [
            {
                status: 409,
                body: {
                    error: "A file with this name already exists.",
                    code: "name_taken",
                    item: file,
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
            .updateVaultFile(surfaceId, site.id, { name: "summary.pdf" }, { ifMatch: version })
            .catch((error: unknown) => error);
        expect(taken).toBeInstanceOf(HappyAgentApiError);
        expect((taken as HappyAgentApiError).code).toBe("name_taken");
        expect((taken as HappyAgentApiError).body).toMatchObject({ item: { id: file.id } });
        const behind = await client
            .uploadVaultChunk("upload1", { data: new Uint8Array([1]), start: 4, size: 6 })
            .catch((error: unknown) => error);
        expect((behind as HappyAgentApiError).body).toMatchObject({ upload: { received: 2 } });
        expect(calls).toBe(2);
    });
});
