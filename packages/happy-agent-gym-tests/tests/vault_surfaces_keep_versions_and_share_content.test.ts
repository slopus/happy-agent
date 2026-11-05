import { createHash } from "node:crypto";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { DEFAULT_VAULT_RETENTION, type HappyAgentClient } from "@slopus/happy-agent-client";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const utf8 = (data: ArrayBuffer | undefined) => new TextDecoder().decode(data);

/** Reads a binary route over the daemon's socket; the gym's raw client keeps only text. */
async function download(gym: AgentGym, url: string): Promise<Uint8Array> {
    const response = await fetch(url, {
        unix: gym.socketPath,
        headers: { authorization: `Bearer ${gym.token}` },
    } as RequestInit);
    expect(response.status).toBe(200);
    return new Uint8Array(await response.arrayBuffer());
}

/** Uploads `data` in two chunks, the way a client resumes a large upload. */
async function upload(client: HappyAgentClient, data: string | Uint8Array) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const half = Math.floor(bytes.length / 2);
    const created = (await client.createVaultUpload({ size: bytes.length, sha256: sha256(bytes) }))
        .upload;
    expect(created).toMatchObject({ status: "receiving", received: 0 });
    await client.uploadVaultChunk(created.id, {
        data: bytes.slice(0, half),
        start: 0,
        size: bytes.length,
    });
    const done = (
        await client.uploadVaultChunk(created.id, {
            data: bytes.slice(half),
            start: half,
            size: bytes.length,
        })
    ).upload;
    expect(done).toMatchObject({ status: "complete", sha256: sha256(bytes) });
    return done.id;
}

describe("vault Surfaces through the real daemon", () => {
    it("versions uploaded files, prunes by retention, searches, and copies by content", async () => {
        const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
        running.push(gym);
        const client = gym.client;
        expect((await client.getHealth()).capabilities?.vaults).toBe(true);
        const vault = (await client.createSurface({ type: "vault", name: "Files" })).surface;
        expect(vault).toMatchObject({ type: "vault", name: "Files" });
        expect((await client.getVaultSettings(vault.id)).settings.retention).toEqual(
            DEFAULT_VAULT_RETENTION,
        );

        const docs = (await client.createVaultFolder(vault.id, { name: "Docs", parentId: null }))
            .folder;
        expect(Object.keys(docs).sort()).toEqual([
            "createdAt",
            "createdBy",
            "deletedAt",
            "id",
            "kind",
            "name",
            "parentId",
            "surfaceId",
            "updatedAt",
            "updatedBy",
            "version",
        ]);
        const plan = (
            await client.createVaultFile(vault.id, {
                name: "Plan.md",
                parentId: docs.id,
                uploadId: await upload(client, "first draft of the launch plan\n"),
            })
        ).file;
        expect(plan).toMatchObject({ kind: "file", latestVersion: 1, mediaType: "text/markdown" });
        await expect(
            client.createVaultFolder(vault.id, { name: "plan.MD", parentId: docs.id }),
        ).rejects.toMatchObject({ status: 409 });
        // A folder route does not answer for a file, nor a file route for a folder.
        await expect(client.getVaultFolder(vault.id, plan.id)).rejects.toMatchObject({
            status: 404,
        });
        await expect(client.getVaultFile(vault.id, docs.id)).rejects.toMatchObject({ status: 404 });
        expect(await client.resolveVaultPath(vault.id, "/docs/plan.md")).toMatchObject({
            item: { id: plan.id },
            path: "/Docs/Plan.md",
            innerPath: null,
        });
        // An empty folder is listed, folders first, and stays.
        const empty = (await client.createVaultFolder(vault.id, { name: "Empty", parentId: null }))
            .folder;
        await client.createVaultFile(vault.id, {
            name: "A first.txt",
            parentId: null,
            uploadId: await upload(client, "listed after the folders"),
        });
        expect((await client.listVaultItems(vault.id)).items.map((item) => item.name)).toEqual([
            "Docs",
            "Empty",
            "A first.txt",
        ]);
        expect((await client.getVaultFolder(vault.id, empty.id)).folder.deletedAt).toBeNull();

        let entry = plan;
        for (const text of ["second draft\n", "third draft\n"]) {
            const made = await client.createVaultVersion(
                vault.id,
                plan.id,
                { uploadId: await upload(client, text) },
                { ifMatch: entry.version },
            );
            expect(made.version).not.toBeNull();
            entry = made.file;
        }
        const same = await client.createVaultVersion(
            vault.id,
            plan.id,
            { uploadId: await upload(client, "third draft\n") },
            { ifMatch: entry.version },
        );
        expect(same.version).toBeNull();
        expect(
            (await client.listVaultVersions(vault.id, plan.id)).versions.map((v) => v.number),
        ).toEqual([3, 2, 1]);
        await expect(
            client.createVaultVersion(
                vault.id,
                plan.id,
                { fromVersion: 1 },
                { ifMatch: plan.version },
            ),
        ).rejects.toMatchObject({ status: 409 });

        // Keeping two versions prunes the oldest when the next one arrives; a pin survives it.
        await client.pinVaultVersion(vault.id, plan.id, 2);
        await client.updateVaultSettings(vault.id, {
            retention: { ...DEFAULT_VAULT_RETENTION, maxVersions: 2 },
        });
        entry = (
            await client.createVaultVersion(
                vault.id,
                plan.id,
                { uploadId: await upload(client, "fourth draft\n") },
                { ifMatch: entry.version },
            )
        ).file;
        expect(
            (await client.listVaultVersions(vault.id, plan.id)).versions.map((v) => [
                v.number,
                v.pinned,
            ]),
        ).toEqual([
            [4, false],
            [3, false],
            [2, true],
        ]);
        expect(utf8((await client.getVaultFileContent(vault.id, plan.id, 2))?.data)).toBe(
            "second draft\n",
        );
        await expect(client.getVaultFileContent(vault.id, plan.id, 1)).rejects.toMatchObject({
            status: 404,
        });

        const search = await client.searchVault(vault.id, { q: "draft" });
        expect(search.results).toEqual([
            expect.objectContaining({
                match: "content",
                path: "/Docs/Plan.md",
                line: 1,
                snippet: "fourth draft",
            }),
        ]);
        expect((await client.searchVault(vault.id, { q: "pla" })).results[0]).toMatchObject({
            match: "name",
            path: "/Docs/Plan.md",
        });

        // A copy into another vault reuses the stored bytes and starts its own history.
        const other = (await client.createSurface({ type: "vault", name: "Archive" })).surface;
        const copy = (
            await client.createVaultFile(other.id, {
                name: "Plan copy.md",
                parentId: null,
                fromFileId: plan.id,
                fromVersion: 2,
            })
        ).file;
        expect(copy).toMatchObject({ latestVersion: 1, sha256: sha256("second draft\n") });

        const deleted = (
            await client.deleteVaultFolder(vault.id, docs.id, { ifMatch: docs.version })
        ).folder;
        expect((await client.listVaultTrash(vault.id)).items.map((e) => e.item.id)).toEqual([
            docs.id,
        ]);
        expect((await client.getVaultFile(vault.id, plan.id)).inTrash).toBe(true);
        expect((await client.searchVault(vault.id, { q: "draft" })).results).toEqual([]);
        await client.restoreVaultFolder(vault.id, docs.id, {}, { ifMatch: deleted.version });
        expect((await client.getVaultFile(vault.id, plan.id)).inTrash).toBe(false);

        const journal = (await client.getEvents({ limit: 1000 })).events.map((e) => e.type);
        for (const type of [
            "vault.folder.created",
            "vault.folder.updated",
            "vault.file.created",
            "vault.file.updated",
            "vault.version.updated",
            "vault.settings.updated",
        ])
            expect(journal).toContain(type);
        expect(gym.errors).toEqual([]);
    });

    it("round-trips a .artifact file and refuses a bad one", async () => {
        const gym = await createAgentGym({ permissionMode: "full_access", timeoutMs: 20000 });
        running.push(gym);
        const client = gym.client;
        const vault = (await client.createSurface({ type: "vault", name: "Sites" })).surface;
        const encode = (text: string) => new TextEncoder().encode(text);
        const bundle = zipSync({
            "artifact.json": encode(
                JSON.stringify({
                    format: "happy.artifact",
                    formatVersion: 1,
                    type: "html",
                    entry: "index.html",
                }),
            ),
            "index.html": encode("<h1>Launch</h1>"),
            "img/logo.svg": encode("<svg/>"),
        });
        const site = (
            await client.createVaultFile(vault.id, {
                name: "launch.artifact",
                parentId: null,
                uploadId: await upload(client, bundle),
            })
        ).file;
        expect(site).toMatchObject({
            kind: "artifact",
            artifact: { type: "html", entry: "index.html", fileCount: 2 },
        });
        const page = await client.getVaultArtifactFile(vault.id, site.id, 1, "index.html");
        expect(utf8(page?.data)).toBe("<h1>Launch</h1>");

        const url = client.vaultArtifactZipUrl(vault.id, site.id, 1);
        const downloaded = await download(gym, url);
        expect(await download(gym, url)).toEqual(downloaded);
        expect(Object.keys(unzipSync(downloaded))).toEqual([
            "artifact.json",
            "img/logo.svg",
            "index.html",
        ]);
        // The download uploads back as the same content: no new version.
        const again = await client.createVaultVersion(
            vault.id,
            site.id,
            { uploadId: await upload(client, downloaded) },
            { ifMatch: site.version },
        );
        expect(again.version).toBeNull();
        // And as a new artifact with the same files.
        const copy = (
            await client.createVaultFile(vault.id, {
                name: "copy.artifact",
                parentId: null,
                uploadId: await upload(client, downloaded),
            })
        ).file;
        expect(copy).toMatchObject({ kind: "artifact", size: site.size });

        // A zip without a manifest is not a .artifact file, and nothing changes.
        await expect(
            client.createVaultFile(vault.id, {
                name: "bad.artifact",
                parentId: null,
                uploadId: await upload(client, zipSync({ "index.html": encode("<p>x</p>") })),
            }),
        ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("artifact.json") });
        // A plain file may not take the suffix, nor an artifact lose it.
        await expect(
            client.createVaultFile(vault.id, {
                name: "notes.artifact",
                parentId: null,
                fromFileId: (
                    await client.createVaultFile(vault.id, {
                        name: "notes.txt",
                        parentId: null,
                        uploadId: await upload(client, "notes"),
                    })
                ).file.id,
            }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            client.updateVaultFile(
                vault.id,
                site.id,
                { name: "launch" },
                { ifMatch: site.version },
            ),
        ).rejects.toMatchObject({ status: 400 });
        expect((await client.listVaultItems(vault.id)).items.map((item) => item.name)).toEqual([
            "copy.artifact",
            "launch.artifact",
            "notes.txt",
        ]);

        // The whole vault downloads with each artifact nested as its .artifact file.
        const whole = unzipSync(await download(gym, client.vaultFolderZipUrl(vault.id)));
        expect(Object.keys(whole).sort()).toEqual([
            "copy.artifact",
            "launch.artifact",
            "notes.txt",
        ]);
        expect(whole["launch.artifact"]).toEqual(downloaded);
        expect(gym.errors).toEqual([]);
    });

    it("lets the agent write, read, publish, and search a vault without Auto review", async () => {
        let surfaceId = "";
        let archiveId = "";
        let agentId = "";
        const reviews: string[] = [];
        const script: (() => GymTurn)[] = [
            () => call("write_vault_file", { path: "/Notes/todo.md", content: "buy milk\n" }),
            () =>
                call("edit_vault_file", {
                    path: "/notes/TODO.md",
                    old_string: "milk",
                    new_string: "oat milk",
                }),
            () =>
                call("write_vault_artifact", {
                    path: "/Sites/launch.artifact",
                    files: [
                        { path: "index.html", content: "<h1>Launch</h1>" },
                        { path: "style.css", content: "h1 { color: teal; }" },
                    ],
                }),
            () => call("create_vault_folder", { path: "/Inbox/Later" }),
            () =>
                call("copy_vault_file", {
                    path: "/Notes/todo.md",
                    toPath: "/Archive/todo.md",
                    toSurfaceId: archiveId,
                }),
            () => call("read_vault_file", { path: "/Notes/todo.md" }),
            () => call("grep_vault", { pattern: "teal|oat", output_mode: "content" }),
            () => call("list_vault", { depth: 3 }),
            () =>
                call("export_vault_file", {
                    path: "/Sites/launch.artifact",
                    toPath: "launch.artifact",
                }),
            () =>
                call("import_vault_file", {
                    fromPath: "launch.artifact",
                    path: "/Sites/launch.artifact",
                }),
            () =>
                call("import_vault_file", {
                    fromPath: "launch.artifact",
                    path: "/Copies/launch.artifact",
                }),
            () => ({ content: [{ type: "text", text: "Done." }] }),
        ];
        const call = (name: string, args: Record<string, unknown>): GymTurn => ({
            content: [{ type: "tool_call", name, arguments: { surfaceId, ...args } }],
        });
        const gym = await createAgentGym({
            permissionMode: "auto",
            timeoutMs: 20000,
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Vault</title>" }] };
                if (request.sessionId !== agentId) {
                    reviews.push(JSON.stringify(request.messages));
                    return {
                        content: [
                            { type: "text", text: "<review><outcome>deny</outcome></review>" },
                        ],
                    };
                }
                return script.shift()!();
            },
        });
        running.push(gym);
        agentId = gym.defaultSessionId;
        const client = gym.client;
        surfaceId = (await client.createSurface({ type: "vault", name: "Team files" })).surface.id;
        archiveId = (await client.createSurface({ type: "vault", name: "Archive" })).surface.id;

        await gym.send("Keep a todo and a launch page in the team vault.", {
            permissionMode: "auto",
        });

        expect(reviews).toEqual([]);
        expect(script).toEqual([]);
        const results = gym.inference.toolResults().map((result) => JSON.stringify(result));
        expect(results[3]).toContain("/Inbox/Later");
        expect(results[4]).toContain("/Archive/todo.md");
        expect(results[5]).toContain("oat milk");
        expect(results[6]).toContain("/Sites/launch.artifact/style.css");
        expect(results[6]).toContain("/Notes/todo.md");
        expect(results[7]).toContain("launch.artifact");
        expect(results[7]).toContain("Later/  folder");
        // The exported .artifact file imports back as the same content, or as a new artifact.
        expect(results[8]).toContain(".artifact file");
        expect(results[9]).toContain("already held exactly this content");
        expect(results[10]).toContain("Created artifact");

        const todo = await client.resolveVaultPath(surfaceId, "/Notes/todo.md");
        expect(todo.item).toMatchObject({ kind: "file", latestVersion: 2 });
        const activity = (await client.listVaultFileActivity(surfaceId, todo.item.id)).activity;
        expect(activity.map((a) => a.kind)).toEqual(["version_created", "created"]);
        for (const record of activity) expect(JSON.stringify(record.actor)).toContain(agentId);
        const archived = await client.resolveVaultPath(archiveId, "/Archive/todo.md");
        expect(archived.item).toMatchObject({
            latestVersion: 1,
            sha256: todo.item.kind === "file" ? todo.item.sha256 : "",
        });
        const later = await client.resolveVaultPath(surfaceId, "/Inbox/Later");
        expect(later.item).toMatchObject({ kind: "folder" });
        const site = await client.resolveVaultPath(surfaceId, "/Sites/launch.artifact/style.css");
        expect(site).toMatchObject({ item: { kind: "artifact" }, innerPath: "style.css" });
        const css = await client.getVaultArtifactFile(surfaceId, site.item.id, 1, "style.css");
        expect(css).toMatchObject({ contentType: expect.stringContaining("text/css") });
        expect(utf8(css?.data)).toBe("h1 { color: teal; }");
        const zip = await gym.raw.get(
            `/v0/surfaces/vault/${surfaceId}/files/${site.item.id}/versions/1/zip`,
        );
        expect(zip.status).toBe(200);
        expect(zip.headers["content-type"]).toBe("application/zip");
        expect(zip.headers["content-disposition"]).toContain('filename="launch.artifact"');
        expect(zip.text.startsWith("PK")).toBe(true);
        expect(zip.text).toContain("artifact.json");
        expect(zip.text).toContain("<h1>Launch</h1>");
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
