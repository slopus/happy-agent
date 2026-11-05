import { createHash } from "node:crypto";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { DEFAULT_VAULT_RETENTION, type HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const utf8 = (data: ArrayBuffer | undefined) => new TextDecoder().decode(data);

/** Uploads `text` in two chunks, the way a client resumes a large upload. */
async function upload(client: HappyAgentClient, text: string) {
    const bytes = new TextEncoder().encode(text);
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

        const docs = (
            await client.createVaultEntry(vault.id, {
                kind: "folder",
                name: "Docs",
                parentId: null,
            })
        ).entry;
        const plan = (
            await client.createVaultEntry(vault.id, {
                kind: "file",
                name: "Plan.md",
                parentId: docs.id,
                uploadId: await upload(client, "first draft of the launch plan\n"),
            })
        ).entry;
        expect(plan).toMatchObject({ kind: "file", latestVersion: 1, mediaType: "text/markdown" });
        await expect(
            client.createVaultEntry(vault.id, {
                kind: "folder",
                name: "plan.MD",
                parentId: docs.id,
            }),
        ).rejects.toMatchObject({ status: 409 });
        expect(await client.resolveVaultPath(vault.id, "/docs/plan.md")).toMatchObject({
            entry: { id: plan.id },
            path: "/Docs/Plan.md",
            innerPath: null,
        });

        let entry = plan;
        for (const text of ["second draft\n", "third draft\n"]) {
            const made = await client.createVaultVersion(
                vault.id,
                plan.id,
                { uploadId: await upload(client, text) },
                { ifMatch: entry.version },
            );
            expect(made.version).not.toBeNull();
            entry = made.entry;
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
        ).entry;
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
            await client.createVaultEntry(other.id, {
                kind: "file",
                name: "Plan copy.md",
                parentId: null,
                fromEntryId: plan.id,
                fromVersion: 2,
            })
        ).entry;
        expect(copy).toMatchObject({ latestVersion: 1, sha256: sha256("second draft\n") });

        const deleted = (
            await client.deleteVaultEntry(vault.id, docs.id, { ifMatch: docs.version })
        ).entry;
        expect((await client.listVaultTrash(vault.id)).entries.map((e) => e.id)).toEqual([docs.id]);
        expect((await client.getVaultEntry(vault.id, plan.id)).inTrash).toBe(true);
        expect((await client.searchVault(vault.id, { q: "draft" })).results).toEqual([]);
        await client.restoreVaultEntry(vault.id, docs.id, {}, { ifMatch: deleted.version });
        expect((await client.getVaultEntry(vault.id, plan.id)).inTrash).toBe(false);

        const journal = (await client.getEvents({ limit: 1000 })).events.map((e) => e.type);
        for (const type of [
            "vault.entry.created",
            "vault.entry.updated",
            "vault.version.updated",
            "vault.settings.updated",
        ])
            expect(journal).toContain(type);
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
                    path: "/Sites/launch",
                    files: [
                        { path: "index.html", content: "<h1>Launch</h1>" },
                        { path: "style.css", content: "h1 { color: teal; }" },
                    ],
                }),
            () =>
                call("copy_vault_entry", {
                    path: "/Notes/todo.md",
                    toPath: "/Archive/todo.md",
                    toSurfaceId: archiveId,
                }),
            () => call("read_vault_file", { path: "/Notes/todo.md" }),
            () => call("grep_vault", { pattern: "teal|oat", output_mode: "content" }),
            () => call("list_vault", { depth: 3 }),
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
        expect(results[3]).toContain("/Archive/todo.md");
        expect(results[4]).toContain("oat milk");
        expect(results[5]).toContain("/Sites/launch/style.css");
        expect(results[5]).toContain("/Notes/todo.md");
        expect(results[6]).toContain("launch");

        const todo = await client.resolveVaultPath(surfaceId, "/Notes/todo.md");
        expect(todo.entry).toMatchObject({ kind: "file", latestVersion: 2 });
        const activity = (await client.listVaultActivity(surfaceId, todo.entry.id)).activity;
        expect(activity.map((a) => a.kind)).toEqual(["version_created", "created"]);
        for (const record of activity) expect(JSON.stringify(record.actor)).toContain(agentId);
        const archived = await client.resolveVaultPath(archiveId, "/Archive/todo.md");
        expect(archived.entry).toMatchObject({ latestVersion: 1, sha256: todo.entry.sha256 });
        const site = await client.resolveVaultPath(surfaceId, "/Sites/launch/style.css");
        expect(site).toMatchObject({ entry: { kind: "artifact" }, innerPath: "style.css" });
        const css = await client.getVaultArtifactFile(surfaceId, site.entry.id, 1, "style.css");
        expect(css).toMatchObject({ contentType: expect.stringContaining("text/css") });
        expect(utf8(css?.data)).toBe("h1 { color: teal; }");
        const zip = await gym.raw.get(
            `/v0/surfaces/vault/${surfaceId}/entries/${site.entry.id}/versions/1/zip`,
        );
        expect(zip.status).toBe(200);
        expect(zip.headers["content-type"]).toBe("application/zip");
        expect(zip.text.startsWith("PK")).toBe(true);
        expect(zip.text).toContain("index.html");
        expect(zip.text).toContain("<h1>Launch</h1>");
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
