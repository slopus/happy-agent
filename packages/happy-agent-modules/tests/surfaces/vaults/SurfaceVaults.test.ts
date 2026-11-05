import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAgentDatabaseConnection, type AgentSystemRef } from "@slopus/happy-agent-base";
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactsModule } from "../../../sources/artifacts/index.js";
import type { BotsModule } from "../../../sources/bots/index.js";
import type { ComputeModule } from "../../../sources/compute/index.js";
import type { ConfigModule } from "../../../sources/config/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import type { RunnersModule } from "../../../sources/runners/index.js";
import {
    SurfaceError,
    SurfacesModule,
    type SurfaceEvent,
} from "../../../sources/surfaces/index.js";
import type { TasksModule } from "../../../sources/tasks/index.js";
import type { TeamModule } from "../../../sources/team/index.js";
import { writeZip } from "../../../sources/surfaces/vaults/zip/writeZip.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";

const close: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const dispose of close.splice(0).reverse()) await dispose();
});

const DAY = 24 * 60 * 60 * 1000;
const person = { actor: { userId: "alice", agentId: null }, source: "api" as const };

async function fixture() {
    const home = await mkdtemp(join(tmpdir(), "vaults-"));
    const config = {
        vaultsHome: home,
        vaultContentPath: (sha: string) => join(home, "content", sha.slice(0, 2), sha),
        vaultUploadPath: (id: string) => join(home, "uploads", id),
    } as unknown as ConfigModule;
    const durable = new DurableFunctionsModule();
    const surfaces = new SurfacesModule(
        durable,
        {
            enabled: true,
            getUser: async (_ctx: unknown, id: string) =>
                ["alice"].includes(id) ? { id, authentication: "jwt" } : undefined,
        } as unknown as TeamModule,
        { forAgent: async () => undefined } as unknown as BotsModule,
        { get: async () => undefined } as unknown as TasksModule,
        { get: async () => undefined } as unknown as ArtifactsModule,
        { resolve: vi.fn(async () => undefined) } as unknown as ComputeModule,
        config,
        { localExecution: true } as RunnersModule,
    );
    const db = moduleDatabase([...durable.migrations, ...surfaces.migrations], "vault-test");
    ensureAgentDatabaseConnection(db.database);
    close.push(async () => {
        durable.stop();
        db.close();
        await rm(home, { recursive: true, force: true });
    });
    await db.ready;
    surfaces.beforeStart(db.context, {} as AgentSystemRef);
    const events: SurfaceEvent[] = [];
    surfaces.onEventTransactional((_ctx, event) => {
        events.push(event);
    });
    const ctx = db.context;
    const vault = await surfaces.create(ctx, { type: "vault", name: "Studio" }, "alice");
    const vaults = surfaces.vaults;
    const upload = async (bytes: Uint8Array) => {
        const created = await vaults.uploads.create(ctx, { size: bytes.byteLength });
        if (bytes.byteLength === 0) return created.id;
        await vaults.uploads.receive(
            ctx,
            created.id,
            undefined,
            (async function* () {
                yield bytes;
            })(),
        );
        return created.id;
    };
    const file = async (parentId: string | null, name: string, text: string) =>
        (
            await vaults.createEntry(
                ctx,
                vault.id,
                {
                    parentId,
                    name,
                    kind: "file",
                    content: {
                        type: "upload",
                        uploadId: await upload(new TextEncoder().encode(text)),
                    },
                },
                person,
            )
        ).entry;
    const folder = async (parentId: string | null, name: string) =>
        (await vaults.createEntry(ctx, vault.id, { parentId, name, kind: "folder" }, person)).entry;
    const contentFiles = async () =>
        (
            await readdir(join(home, "content"), { recursive: true, withFileTypes: true }).catch(
                () => [],
            )
        ).filter((item) => item.isFile()).length;
    return { surfaces, vaults, ctx, vault, events, upload, file, folder, home, contentFiles };
}

const enc = (text: string) => new TextEncoder().encode(text);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("vault Surfaces", () => {
    it("creates a vault with the Time Machine default and changes its retention", async () => {
        const f = await fixture();
        const settings = await f.vaults.settings(f.ctx, f.vault.id);
        expect(settings.retention.keepAllDays).toBe(1);
        expect(settings.retention.thinning).toEqual([
            { afterDays: 1, everyDays: 1 },
            { afterDays: 30, everyDays: 7 },
        ]);
        const changed = await f.vaults.updateSettings(f.ctx, f.vault.id, {
            ...settings.retention,
            maxVersions: 3,
        });
        expect(changed.version > settings.version).toBe(true);
        const same = await f.vaults.updateSettings(f.ctx, f.vault.id, changed.retention);
        expect(same.version).toBe(changed.version);
        await expect(
            f.vaults.updateSettings(f.ctx, f.vault.id, {
                ...settings.retention,
                thinning: [
                    { afterDays: 5, everyDays: 1 },
                    { afterDays: 5, everyDays: 2 },
                ],
            }),
        ).rejects.toThrow(/strictly increasing/);
        expect(f.events.filter((event) => event.type === "vault.settings.updated")).toHaveLength(1);
        await expect(f.vaults.settings(f.ctx, "a".repeat(24))).rejects.toThrow(SurfaceError);
    });

    it("builds a tree with unique case-insensitive names and resolves paths", async () => {
        const f = await fixture();
        const reports = await f.folder(null, "Reports");
        const q3 = await f.folder(reports.id, "Q3");
        const summary = await f.file(q3.id, "Summary.md", "# Q3\nRevenue grew.\n");
        expect(summary.mediaType).toBe("text/markdown");
        expect(summary.latestVersion).toBe(1);
        await expect(f.folder(null, "reports")).rejects.toMatchObject({ code: "name_taken" });
        const resolved = await f.vaults.resolve(f.ctx, f.vault.id, "/reports/q3/SUMMARY.md");
        expect(resolved.entry.id).toBe(summary.id);
        expect(resolved.path).toBe("/Reports/Q3/Summary.md");
        expect(resolved.ancestors.map((item) => item.name)).toEqual(["Reports", "Q3"]);
        const root = await f.vaults.list(f.ctx, f.vault.id, {});
        expect(root.entries.map((entry) => entry.name)).toEqual(["Reports"]);
        const tree = await f.vaults.tree(f.ctx, f.vault.id, { limit: 2 });
        expect(tree.entries).toHaveLength(2);
        const rest = await f.vaults.tree(f.ctx, f.vault.id, { pageCursor: tree.nextPageCursor! });
        expect(rest.entries).toHaveLength(1);
        await expect(
            f.vaults.moveEntry(
                f.ctx,
                f.vault.id,
                reports.id,
                reports.version,
                { parentId: q3.id },
                person,
            ),
        ).rejects.toMatchObject({ code: "conflict" });
        const renamed = await f.vaults.moveEntry(
            f.ctx,
            f.vault.id,
            summary.id,
            summary.version,
            { name: "summary.txt", parentId: reports.id },
            person,
        );
        expect(renamed.mediaType).toBe("text/plain");
        await expect(
            f.vaults.moveEntry(
                f.ctx,
                f.vault.id,
                summary.id,
                summary.version,
                { name: "x" },
                person,
            ),
        ).rejects.toMatchObject({ code: "conflict" });
        const activity = await f.vaults.activity(f.ctx, f.vault.id, summary.id, {});
        expect(activity.activity.map((item) => item.kind)).toEqual(["moved", "created"]);
    });

    it("trashes and restores folders with what is inside them", async () => {
        const f = await fixture();
        const docs = await f.folder(null, "Docs");
        const inner = await f.file(docs.id, "a.txt", "alpha");
        const deleted = await f.vaults.deleteEntry(
            f.ctx,
            f.vault.id,
            docs.id,
            docs.version,
            person,
        );
        expect(deleted.deletedAt).not.toBeNull();
        const trash = await f.vaults.trash(f.ctx, f.vault.id, {});
        expect(trash.items.map((item) => item.path)).toEqual(["/Docs"]);
        expect((await f.vaults.location(f.ctx, f.vault.id, inner.id)).inTrash).toBe(true);
        await expect(f.vaults.resolve(f.ctx, f.vault.id, "/Docs/a.txt")).rejects.toMatchObject({
            code: "not_found",
        });
        // A new live entry may take the deleted name; restoring then needs another one.
        const other = await f.folder(null, "Docs");
        await expect(
            f.vaults.restoreEntry(f.ctx, f.vault.id, docs.id, deleted.version, {}, person),
        ).rejects.toMatchObject({ code: "name_taken" });
        const restored = await f.vaults.restoreEntry(
            f.ctx,
            f.vault.id,
            docs.id,
            deleted.version,
            { name: "Docs (restored)" },
            person,
        );
        expect(restored.deletedAt).toBeNull();
        expect((await f.vaults.resolve(f.ctx, f.vault.id, "/Docs (restored)/a.txt")).entry.id).toBe(
            inner.id,
        );
        expect(other.name).toBe("Docs");
    });

    it("versions files, skips identical content, restores, pins, and prunes", async () => {
        const f = await fixture();
        let entry = await f.file(null, "notes.txt", "one");
        const second = await f.vaults.createVersion(
            f.ctx,
            f.vault.id,
            entry.id,
            entry.version,
            { type: "upload", uploadId: await f.upload(enc("two")) },
            person,
        );
        expect(second.version?.number).toBe(2);
        entry = second.entry;
        const same = await f.vaults.createVersion(
            f.ctx,
            f.vault.id,
            entry.id,
            entry.version,
            { type: "upload", uploadId: await f.upload(enc("two")) },
            person,
        );
        expect(same.version).toBeNull();
        expect(same.entry.version).toBe(entry.version);
        const restored = await f.vaults.createVersion(
            f.ctx,
            f.vault.id,
            entry.id,
            entry.version,
            { type: "version", number: 1 },
            person,
        );
        expect(restored.version).toMatchObject({
            number: 3,
            restoredFrom: 1,
            sha256: sha(enc("one")),
        });
        await f.vaults.setPinned(f.ctx, f.vault.id, entry.id, 1, true, person);
        await f.vaults.updateSettings(f.ctx, f.vault.id, {
            maxVersions: 1,
            maxAgeDays: null,
            keepAllDays: 0,
            thinning: [],
            trashDays: 30,
        });
        await f.vaults.maintain(f.ctx, Date.now() + DAY);
        const versions = await f.vaults.versions(f.ctx, f.vault.id, entry.id, {});
        expect(versions.versions.map((version) => version.number)).toEqual([3, 1]);
        await expect(f.vaults.version(f.ctx, f.vault.id, entry.id, 2)).rejects.toMatchObject({
            code: "not_found",
        });
        // "two" is held by nothing now, so its content was collected.
        await expect(stat(f.vaults.contentPath(sha(enc("two"))))).rejects.toThrow();
        await expect(stat(f.vaults.contentPath(sha(enc("one"))))).resolves.toBeDefined();
    });

    it("searches names and content, and leaves the Trash out", async () => {
        const f = await fixture();
        const plans = await f.folder(null, "Plans");
        await f.file(plans.id, "roadmap.md", "Ship vaults in November.\nThen sharing.");
        await f.file(null, "plans-old.txt", "nothing here");
        const names = await f.vaults.search(f.ctx, f.vault.id, { q: "plans", kind: "name" });
        expect(names.results.map((result) => result.path)).toEqual([
            "/Plans",
            "/plans-old.txt",
            "/Plans/roadmap.md",
        ]);
        const content = await f.vaults.search(f.ctx, f.vault.id, {
            q: "november",
            kind: "content",
        });
        expect(content.results).toMatchObject([
            {
                match: "content",
                path: "/Plans/roadmap.md",
                line: 1,
                snippet: "Ship vaults in November.",
            },
        ]);
        expect(
            (await f.vaults.search(f.ctx, f.vault.id, { q: "no", kind: "content" })).results,
        ).toEqual([]);
        await f.vaults.deleteEntry(f.ctx, f.vault.id, plans.id, plans.version, person);
        expect((await f.vaults.search(f.ctx, f.vault.id, { q: "november" })).results).toEqual([]);
    });

    it("reads artifact zips, serves their files, and zips folders back", async () => {
        const f = await fixture();
        const zip = zipSync({
            "site/index.html": enc("<h1>Launch</h1>"),
            "site/img/hero.svg": enc("<svg/>"),
            "site/.DS_Store": enc("x"),
            "__MACOSX/site/._index.html": enc("x"),
        });
        const uploadId = await f.upload(zip);
        const prepared = await f.vaults.prepareArtifactUpload(f.ctx, uploadId);
        const { entry } = await f.vaults.createEntry(
            f.ctx,
            f.vault.id,
            {
                parentId: null,
                name: "launch",
                kind: "artifact",
                content: { type: "upload", uploadId, prepared },
            },
            person,
        );
        expect(entry.artifact).toEqual({ type: "html", entry: "index.html", fileCount: 2 });
        const file = await f.vaults.artifactFile(f.ctx, f.vault.id, entry.id, 1, "img/hero.svg");
        expect(file.mimeType).toBe("image/svg+xml");
        const resolved = await f.vaults.resolve(f.ctx, f.vault.id, "/launch/img/hero.svg");
        expect(resolved.innerPath).toBe("img/hero.svg");
        // The upload was used.
        await expect(f.vaults.uploads.get(f.ctx, uploadId)).rejects.toMatchObject({
            code: "not_found",
        });
        await f.file(null, "readme.txt", "hi");
        await f.folder(null, "empty");
        const download = await f.vaults.zip(f.ctx, f.vault.id, { type: "vault" });
        const chunks: Buffer[] = [];
        for await (const chunk of writeZip(download.items)) chunks.push(chunk);
        const unpacked = unzipSync(new Uint8Array(Buffer.concat(chunks)));
        expect(Object.keys(unpacked).sort()).toEqual([
            "empty/",
            "launch/img/hero.svg",
            "launch/index.html",
            "readme.txt",
        ]);
        expect(new TextDecoder().decode(unpacked["launch/index.html"])).toBe("<h1>Launch</h1>");
        const refused = await f.upload(zipSync({ "page.html": enc("x") }));
        await expect(f.vaults.prepareArtifactUpload(f.ctx, refused)).rejects.toThrow(/index\.html/);
        const unsafe = await f.upload(zipSync({ "index.html": enc("x"), "../escape": enc("y") }));
        await expect(f.vaults.prepareArtifactUpload(f.ctx, unsafe)).rejects.toThrow(/unsafe/);
    });

    it("receives resumable uploads in order and checks their digest", async () => {
        const f = await fixture();
        const bytes = enc("0123456789");
        const upload = await f.vaults.uploads.create(f.ctx, { size: 10, sha256: sha(bytes) });
        const body = (chunk: Uint8Array) =>
            (async function* () {
                yield chunk;
            })();
        const first = await f.vaults.uploads.receive(
            f.ctx,
            upload.id,
            { start: 0, end: 3, size: 10 },
            body(bytes.subarray(0, 4)),
        );
        expect(first).toMatchObject({ received: 4, status: "receiving", sha256: null });
        await expect(
            f.vaults.uploads.receive(
                f.ctx,
                upload.id,
                { start: 2, end: 5, size: 10 },
                body(bytes.subarray(2, 6)),
            ),
        ).rejects.toMatchObject({ code: "conflict", current: { upload: { received: 4 } } });
        await expect(
            f.vaults.uploads.receive(
                f.ctx,
                upload.id,
                { start: 4, end: 9, size: 10 },
                body(bytes.subarray(4, 8)),
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const done = await f.vaults.uploads.receive(
            f.ctx,
            upload.id,
            { start: 4, end: 9, size: 10 },
            body(bytes.subarray(4)),
        );
        expect(done).toMatchObject({ received: 10, status: "complete", sha256: sha(bytes) });
        const wrong = await f.vaults.uploads.create(f.ctx, { size: 3, sha256: sha(enc("abc")) });
        await expect(
            f.vaults.uploads.receive(f.ctx, wrong.id, undefined, body(enc("abd"))),
        ).rejects.toMatchObject({
            code: "hash_mismatch",
        });
        await expect(f.vaults.uploads.get(f.ctx, wrong.id)).rejects.toMatchObject({
            code: "not_found",
        });
        const empty = await f.vaults.uploads.create(f.ctx, { size: 0 });
        expect(empty.status).toBe("complete");
    });

    it("copies by digest across vaults without storing bytes again", async () => {
        const f = await fixture();
        const original = await f.file(null, "big.bin", "same bytes");
        const before = await f.contentFiles();
        const other = await f.surfaces.create(f.ctx, { type: "vault", name: "Other" }, "alice");
        const copy = await f.vaults.createEntry(
            f.ctx,
            other.id,
            {
                parentId: null,
                name: "copy.bin",
                kind: "file",
                content: { type: "copy", entryId: original.id, version: "latest" },
            },
            person,
        );
        expect(copy.entry.sha256).toBe(original.sha256);
        expect(await f.contentFiles()).toBe(before);
        expect(
            (await f.vaults.activity(f.ctx, other.id, copy.entry.id, {})).activity[0],
        ).toMatchObject({
            kind: "created",
            copiedFrom: original.id,
        });
        // A repeated ID returns the entry unchanged.
        const again = await f.vaults.createEntry(
            f.ctx,
            other.id,
            { id: copy.entry.id, parentId: null, name: "ignored", kind: "folder" },
            person,
        );
        expect(again).toEqual({ entry: copy.entry, created: false });
    });

    it("removes Trash items past their time with their versions and content", async () => {
        const f = await fixture();
        const docs = await f.folder(null, "Old");
        const inner = await f.file(docs.id, "gone.txt", "to be purged");
        await f.vaults.deleteEntry(f.ctx, f.vault.id, docs.id, docs.version, person);
        await f.vaults.maintain(f.ctx, Date.now() + 31 * DAY);
        await expect(f.vaults.location(f.ctx, f.vault.id, inner.id)).rejects.toMatchObject({
            code: "not_found",
        });
        expect(f.events.filter((event) => event.type === "vault.entry.removed")).toEqual([
            { type: "vault.entry.removed", payload: { surfaceId: f.vault.id, entryId: docs.id } },
        ]);
        await expect(stat(f.vaults.contentPath(sha(enc("to be purged"))))).rejects.toThrow();
    });
});
