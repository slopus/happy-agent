import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { VaultFile, VaultItem } from "@slopus/happy-agent-client";
import { sql } from "drizzle-orm";
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
import { SurfacesPersistence } from "../../../sources/surfaces/persistence/SurfacesPersistence.js";
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
    const hooks = surfaces.beforeStart(db.context, {} as AgentSystemRef);
    const kv = new SurfacesPersistence(db.database).kv();
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
        asFile(
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
            ).entry,
        );
    const folder = async (parentId: string | null, name: string) =>
        (await vaults.createEntry(ctx, vault.id, { parentId, name, kind: "folder" }, person)).entry;
    const contentFiles = async () =>
        (
            await readdir(join(home, "content"), { recursive: true, withFileTypes: true }).catch(
                () => [],
            )
        ).filter((item) => item.isFile()).length;
    return {
        surfaces,
        vaults,
        hooks,
        kv,
        ctx,
        vault,
        events,
        upload,
        file,
        folder,
        home,
        contentFiles,
    };
}

const enc = (text: string) => new TextEncoder().encode(text);
const asFile = (item: VaultItem): VaultFile => {
    if (item.kind === "folder") throw new Error("Expected a file.");
    return item;
};
const manifest = (fields: Record<string, unknown> = {}) =>
    enc(
        JSON.stringify({
            format: "happy.artifact",
            formatVersion: 1,
            type: "html",
            entry: "index.html",
            ...fields,
        }),
    );
const unzipped = async (items: Parameters<typeof writeZip>[0]) => {
    const chunks: Buffer[] = [];
    for await (const chunk of writeZip(items)) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
};
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
        expect(root.items.map((item) => item.name)).toEqual(["Reports"]);
        const tree = await f.vaults.tree(f.ctx, f.vault.id, { limit: 2 });
        expect(tree.items).toHaveLength(2);
        const rest = await f.vaults.tree(f.ctx, f.vault.id, { pageCursor: tree.nextPageCursor! });
        expect(rest.items).toHaveLength(1);
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
        expect(asFile(renamed).mediaType).toBe("text/plain");
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
        entry = asFile(second.entry);
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

    it("answers a repeated operation ID with what it did the first time", async () => {
        const f = await fixture();
        const entry = await f.file(null, "notes.txt", "one");
        const other = await f.file(null, "other.txt", "one");
        const attempt = (id: string, text: string, expected = entry.version, on = entry.id) =>
            f
                .upload(enc(text))
                .then((uploadId) =>
                    f.vaults.createVersion(
                        f.ctx,
                        f.vault.id,
                        on,
                        expected,
                        { type: "upload", uploadId },
                        { ...person, operationId: id },
                    ),
                );
        const first = await attempt("op-1", "two");
        expect(first).toMatchObject({ created: true, version: { number: 2, pinned: false } });
        const events = f.events.length;

        // A stale If-Match and different content are both ignored, and the upload is kept.
        const spare = await f.upload(enc("three"));
        const repeat = await f.vaults.createVersion(
            f.ctx,
            f.vault.id,
            entry.id,
            "stale",
            { type: "upload", uploadId: spare },
            { ...person, operationId: "op-1" },
        );
        expect(repeat).toEqual(first);
        expect(f.events.length).toBe(events);
        expect((await f.vaults.versions(f.ctx, f.vault.id, entry.id, {})).versions).toHaveLength(2);
        await expect(f.vaults.uploads.requireComplete(f.ctx, spare)).resolves.toBeDefined();

        // The answer shows the file and the version as they are now.
        await f.vaults.setPinned(f.ctx, f.vault.id, entry.id, 2, true, person);
        const later = await attempt("op-2", "four", asFile(first.entry).version);
        const replayed = await f.vaults.replayVersion(f.ctx, f.vault.id, entry.id, "op-1");
        expect(replayed).toMatchObject({ created: true, version: { number: 2, pinned: true } });
        expect(replayed?.entry.version).toBe(later.entry.version);

        // Content matching the newest version is remembered as making none.
        const none = await attempt("op-3", "four", later.entry.version);
        expect(none).toMatchObject({ created: false, version: null });
        expect(await attempt("op-3", "five", "stale")).toMatchObject({
            created: false,
            version: null,
        });

        // The same ID on another file is a new request.
        expect(await attempt("op-1", "two", other.version, other.id)).toMatchObject({
            created: true,
            version: { number: 2, fileId: other.id },
        });
        expect(await f.vaults.replayVersion(f.ctx, f.vault.id, entry.id, "new")).toBeUndefined();
        expect(
            await f.vaults.replayVersion(f.ctx, f.vault.id, entry.id, undefined),
        ).toBeUndefined();

        // A pruned version is answered as null, still as made.
        await f.vaults.setPinned(f.ctx, f.vault.id, entry.id, 2, false, person);
        await f.vaults.updateSettings(f.ctx, f.vault.id, {
            maxVersions: 1,
            maxAgeDays: null,
            keepAllDays: 0,
            thinning: [],
            trashDays: 30,
        });
        await f.vaults.maintain(f.ctx, Date.now() + DAY);
        expect(await f.vaults.replayVersion(f.ctx, f.vault.id, entry.id, "op-1")).toMatchObject({
            created: true,
            version: null,
        });
    });

    it("records an operation ID only when the version request succeeds", async () => {
        const f = await fixture();
        const entry = await f.file(null, "notes.txt", "one");
        const attempt = async (expected: string) =>
            f.vaults.createVersion(
                f.ctx,
                f.vault.id,
                entry.id,
                expected,
                { type: "upload", uploadId: await f.upload(enc("two")) },
                { ...person, operationId: "retry-me" },
            );
        await expect(attempt("stale")).rejects.toMatchObject({ code: "conflict" });
        await expect(
            f.vaults.createVersion(
                f.ctx,
                f.vault.id,
                entry.id,
                entry.version,
                { type: "upload", uploadId: "missing" },
                { ...person, operationId: "retry-me" },
            ),
        ).rejects.toBeDefined();
        expect(
            await f.vaults.replayVersion(f.ctx, f.vault.id, entry.id, "retry-me"),
        ).toBeUndefined();
        // The client's retry with the current If-Match and the same ID goes through.
        expect(await attempt(entry.version)).toMatchObject({
            created: true,
            version: { number: 2 },
        });
    });

    it("searches names and content, and leaves the Trash out", async () => {
        const f = await fixture();
        const find = async (q: string) =>
            (await f.vaults.search(f.ctx, q, 30)).map((hit) => `${hit.match} ${hit.path}`);
        const plans = await f.folder(null, "Plans");
        await f.file(plans.id, "roadmap.md", "Ship vaults in November.\nThen sharing.");
        await f.file(null, "plans-old.txt", "nothing here");
        expect(await find("plans")).toEqual([
            "name /Plans",
            "name /plans-old.txt",
            "path /Plans/roadmap.md",
        ]);
        expect(await f.vaults.search(f.ctx, "november", 30)).toMatchObject([
            {
                type: "vault_file",
                match: "content",
                path: "/Plans/roadmap.md",
                line: 1,
                snippet: "Ship vaults in November.",
            },
        ]);
        // Two letters find words starting with them; a substring needs three.
        expect((await find("no")).sort()).toEqual([
            "content /Plans/roadmap.md",
            "content /plans-old.txt",
        ]);
        expect(await find("ip")).toEqual([]);
        await f.vaults.deleteEntry(f.ctx, f.vault.id, plans.id, plans.version, person);
        expect(await find("november")).toEqual([]);
    });

    it("ranks word matches in tiers, keeps paths current, and searches every vault", async () => {
        const f = await fixture();
        const other = await f.surfaces.create(f.ctx, { type: "vault", name: "Other" }, "alice");
        // Each item is listed once, under its best tier.
        const search = async (q: string) =>
            (await f.vaults.search(f.ctx, q, 30)).map(
                (hit) =>
                    `${hit.type} ${hit.match} ${hit.surfaceId === other.id ? "other" : "main"}${hit.path}${hit.type === "vault_file" && hit.line !== null ? `:${hit.line}` : ""}`,
            );
        const docs = await f.folder(null, "Docs");
        const launch = await f.folder(docs.id, "Launch");
        await f.file(launch.id, "agenda.md", "Who speaks first");
        await f.file(docs.id, "notes.md", "Checklist\nThe launch is on Friday\nCafé after");
        await f.file(null, "launch.txt", "unrelated");
        await f.file(null, "relaunch.txt", "nothing");

        // Own names first, then content, then paths, then substrings.
        expect(await search("launch")).toEqual([
            "vault_folder name main/Docs/Launch",
            "vault_file name main/launch.txt",
            "vault_file content main/Docs/notes.md:2",
            "vault_file path main/Docs/Launch/agenda.md",
            "vault_file name main/relaunch.txt",
        ]);
        // A word matches by prefix and ignores case and diacritics, so typing finds it.
        expect(await search("LAUN fri")).toEqual(["vault_file content main/Docs/notes.md:2"]);
        expect(await search("cafe")).toEqual(["vault_file content main/Docs/notes.md:3"]);
        expect((await f.vaults.search(f.ctx, "cafe", 30))[0]).toMatchObject({
            snippet: "Café after",
            innerPath: null,
        });
        expect(await search("docs agenda")).toEqual(["vault_file path main/Docs/Launch/agenda.md"]);

        // Renaming a folder re-indexes the paths below it in the same transaction.
        await f.vaults.moveEntry(
            f.ctx,
            f.vault.id,
            launch.id,
            launch.version,
            { name: "Liftoff" },
            person,
        );
        expect(await search("liftoff agenda")).toEqual([
            "vault_file path main/Docs/Liftoff/agenda.md",
        ]);
        expect(await search("launch agenda")).toEqual([]);
        expect(await search("liftoff")).toEqual([
            "vault_folder name main/Docs/Liftoff",
            "vault_file path main/Docs/Liftoff/agenda.md",
        ]);

        // Every vault, with the same tiers; the Trash stays out.
        await f.vaults.createEntry(
            f.ctx,
            other.id,
            {
                parentId: null,
                name: "launch codes.txt",
                kind: "file",
                content: { type: "upload", uploadId: await f.upload(enc("secret")) },
            },
            person,
        );
        expect(await search("launch")).toEqual([
            "vault_file name main/launch.txt",
            "vault_file name other/launch codes.txt",
            "vault_file content main/Docs/notes.md:2",
            "vault_file name main/relaunch.txt",
        ]);
        await f.vaults.deleteEntry(f.ctx, f.vault.id, docs.id, docs.version, person);
        expect(await search("friday")).toEqual([]);
    });

    it("searches HTML files and vault apps by the text a reader sees", async () => {
        const f = await fixture();
        const page = [
            "<!doctype html><html><head><style>.secret { color: teal }</style></head>",
            '<body><h1 style="color:tomato" class="title">Counter 2</h1>',
            "<script>const hidden = 1;</script>",
            "<p>Tap &amp; count   the  <b>visitors</b></p></body></html>",
        ].join("\n");
        const html = await f.file(null, "tally.html", page);
        const uploadId = await f.upload(
            zipSync({
                "artifact.json": manifest(),
                "index.html": enc(page.replace("Counter 2", "Launch app")),
            }),
        );
        await f.vaults.createEntry(
            f.ctx,
            f.vault.id,
            {
                parentId: null,
                name: "launch.artifact",
                kind: "artifact",
                content: {
                    type: "upload",
                    uploadId,
                    prepared: await f.vaults.prepareArtifactUpload(f.ctx, uploadId),
                },
            },
            person,
        );
        const found = async (q: string) =>
            (await f.vaults.search(f.ctx, q, 30)).map((hit) => [
                hit.name,
                hit.type === "vault_file" ? hit.innerPath : null,
                hit.type === "vault_file" ? hit.line : null,
                hit.type === "vault_file" ? hit.snippet : null,
            ]);
        // Snippets are the readable text of their line, entities decoded and spaces collapsed.
        expect(await found("visitors")).toEqual(
            expect.arrayContaining([
                ["tally.html", null, 4, "Tap & count the visitors"],
                ["launch.artifact", "index.html", 4, "Tap & count the visitors"],
            ]),
        );
        expect(await found("counter")).toEqual([["tally.html", null, 2, "Counter 2"]]);
        // Tags, attributes, scripts, and styles are no match, by word or by substring.
        for (const q of ["style", "tomato", "title", "hidden", "secret", "doctype", "teal"])
            expect(await found(q)).toEqual([]);
        // Renamed away from .html, the file's text is its source again.
        await f.vaults.moveEntry(
            f.ctx,
            f.vault.id,
            html.id,
            html.version,
            { name: "tally.txt" },
            person,
        );
        expect(await found("tomato")).toEqual([
            ["tally.txt", null, 2, '<body><h1 style="color:tomato" class="title">Counter 2</h1>'],
        ]);
    });

    it("indexes HTML texts again when their words were indexed as source", async () => {
        const f = await fixture();
        await f.file(null, "page.html", '<p class="tomato">Hello</p>');
        await f.file(null, "notes.txt", "Plain tomato soup");
        // The words of every text as a daemon before readable HTML indexed them: the source.
        for (const statement of [
            sql`DELETE FROM happy_agent_vault_text_words`,
            sql`INSERT INTO happy_agent_vault_text_words (rowid, text) SELECT rowid, text FROM happy_agent_vault_text_index`,
            sql`INSERT OR REPLACE INTO happy_agent_vault_search_backfill (id, entries_after, texts_after, texts_until, html_only) SELECT 1, coalesce((SELECT max(id) FROM happy_agent_vault_entries), ''), 0, coalesce((SELECT max(id) FROM happy_agent_vault_texts), 0), 1`,
        ])
            await agentDatabaseRun(f.ctx.db, statement);
        // A stale source word finds nothing that a reader could see.
        expect((await f.vaults.search(f.ctx, "tomato", 30)).map((hit) => hit.name)).toEqual([
            "notes.txt",
        ]);

        await f.vaults.maintain(f.ctx, Date.now());
        expect(
            await agentDatabaseRows(
                f.ctx.db,
                sql`SELECT rowid FROM happy_agent_vault_text_words WHERE happy_agent_vault_text_words MATCH 'tomato'`,
            ),
        ).toHaveLength(1);
        expect(await f.vaults.search(f.ctx, "hello", 30)).toMatchObject([
            { name: "page.html", snippet: "Hello" },
        ]);
        expect(
            await agentDatabaseRows(
                f.ctx.db,
                sql`SELECT id FROM happy_agent_vault_search_backfill`,
            ),
        ).toEqual([]);
    });

    it("indexes vaults made before the word indexes in bounded maintenance passes", async () => {
        const f = await fixture();
        const docs = await f.folder(null, "Docs");
        for (let index = 0; index < 150; index += 1)
            await f.file(docs.id, `note ${index}.md`, `entry number ${index} mentions zeppelins`);
        // Forget the word indexes, as a daemon upgraded from before them has none.
        for (const statement of [
            sql`DELETE FROM happy_agent_vault_name_words`,
            sql`DELETE FROM happy_agent_vault_names`,
            sql`DELETE FROM happy_agent_vault_text_words`,
            sql`INSERT OR REPLACE INTO happy_agent_vault_search_backfill (id, entries_after, texts_after, texts_until) SELECT 1, '', 0, coalesce(max(id), 0) FROM happy_agent_vault_texts`,
        ])
            await agentDatabaseRun(f.ctx.db, statement);
        // Until the backfill runs, substrings still find everything.
        // A provider answers one more than the limit, so fusion knows more matched.
        expect(await f.vaults.search(f.ctx, "zeppelin", 100)).toHaveLength(101);

        await f.vaults.maintain(f.ctx, Date.now());
        const words = await f.vaults.search(f.ctx, "zep", 100);
        expect(words).toHaveLength(101);
        expect(words.every((hit) => hit.match === "content")).toBe(true);
        expect((await f.vaults.search(f.ctx, "docs note 149", 30)).map((hit) => hit.path)).toEqual([
            "/Docs/note 149.md",
        ]);
        const left = await agentDatabaseRows(
            f.ctx.db,
            sql`SELECT id FROM happy_agent_vault_search_backfill`,
        );
        expect(left).toEqual([]);
    }, 30_000);

    it("round-trips .artifact files and nests them in folder zips", async () => {
        const f = await fixture();
        // A zipped launch.artifact/ folder works: its top folder is removed.
        const zip = zipSync({
            "launch.artifact/artifact.json": manifest({ extra: "ignored" }),
            "launch.artifact/index.html": enc("<h1>Launch</h1>"),
            "launch.artifact/img/hero.svg": enc("<svg/>"),
            "launch.artifact/.DS_Store": enc("x"),
            "__MACOSX/launch.artifact/._index.html": enc("x"),
        });
        const uploadId = await f.upload(zip);
        const prepared = await f.vaults.prepareArtifactUpload(f.ctx, uploadId);
        const artifact = asFile(
            (
                await f.vaults.createEntry(
                    f.ctx,
                    f.vault.id,
                    {
                        parentId: null,
                        name: "launch.artifact",
                        kind: "artifact",
                        content: { type: "upload", uploadId, prepared },
                    },
                    person,
                )
            ).entry,
        );
        expect(artifact.artifact).toEqual({ type: "html", entry: "index.html", fileCount: 2 });
        const file = await f.vaults.artifactFile(f.ctx, f.vault.id, artifact.id, 1, "img/hero.svg");
        expect(file.mimeType).toBe("image/svg+xml");
        const resolved = await f.vaults.resolve(f.ctx, f.vault.id, "/launch.artifact/img/hero.svg");
        expect(resolved.innerPath).toBe("img/hero.svg");
        // The upload was used.
        await expect(f.vaults.uploads.get(f.ctx, uploadId)).rejects.toMatchObject({
            code: "not_found",
        });

        // A version downloads as its .artifact file, the manifest first, the same bytes each time.
        const target = { type: "version", fileId: artifact.id, selector: 1 } as const;
        const download = await f.vaults.zip(f.ctx, f.vault.id, target);
        expect(download.name).toBe("launch.artifact");
        const bytes = await unzipped(download.items);
        expect(await unzipped((await f.vaults.zip(f.ctx, f.vault.id, target)).items)).toEqual(
            bytes,
        );
        const entries = unzipSync(bytes);
        expect(Object.keys(entries)).toEqual(["artifact.json", "img/hero.svg", "index.html"]);
        expect(JSON.parse(new TextDecoder().decode(entries["artifact.json"]))).toEqual({
            format: "happy.artifact",
            formatVersion: 1,
            type: "html",
            entry: "index.html",
        });
        // Uploading the download again is the same content: no new version.
        const again = await f.vaults.createVersion(
            f.ctx,
            f.vault.id,
            artifact.id,
            artifact.version,
            {
                type: "upload",
                uploadId: await f.upload(bytes),
                prepared: await f.vaults.prepareArtifactUpload(f.ctx, await f.upload(bytes)),
            },
            person,
        );
        expect(again.version).toBeNull();

        // A folder zip holds every folder, empty ones included, and each artifact nested whole.
        await f.file(null, "readme.txt", "hi");
        const empty = await f.folder(null, "empty");
        await f.vaults.maintain(f.ctx, Date.now() + 2 * DAY);
        expect((await f.vaults.location(f.ctx, f.vault.id, empty.id)).entry.deletedAt).toBeNull();
        const vaultZip = await f.vaults.zip(f.ctx, f.vault.id, { type: "vault" });
        expect(vaultZip.name).toBe("Studio.zip");
        const whole = unzipSync(await unzipped(vaultZip.items));
        expect(Object.keys(whole).sort()).toEqual(["empty/", "launch.artifact", "readme.txt"]);
        expect(Object.keys(unzipSync(whole["launch.artifact"]!))).toEqual([
            "artifact.json",
            "img/hero.svg",
            "index.html",
        ]);
    });

    it("refuses bad .artifact files and names that disagree with their kind", async () => {
        const f = await fixture();
        const refusals = [
            [zipSync({ "index.html": enc("x") }), /no "artifact\.json" manifest/],
            [enc("not a zip at all"), /not a zip/],
            [
                zipSync({ "artifact.json": enc("{"), "index.html": enc("x") }),
                /not valid UTF-8 JSON/,
            ],
            [
                zipSync({
                    "artifact.json": manifest({ formatVersion: 2 }),
                    "index.html": enc("x"),
                }),
                /newer Happy/,
            ],
            [
                zipSync({
                    "artifact.json": manifest({ entry: "index.md" }),
                    "index.html": enc("x"),
                }),
                /entry must be "index\.html"/,
            ],
            [zipSync({ "artifact.json": manifest(), "index.md": enc("x") }), /no "index\.html"/],
            [
                zipSync({
                    "artifact.json": manifest(),
                    "index.html": enc("x"),
                    "../escape": enc("y"),
                }),
                /unsafe/,
            ],
        ] as const;
        for (const [bytes, message] of refusals)
            await expect(
                f.vaults.prepareArtifactUpload(f.ctx, await f.upload(bytes)),
            ).rejects.toMatchObject({
                code: "invalid_request",
                message: expect.stringMatching(message),
            });
        // A Markdown manifest makes a Markdown site even beside an index.html.
        const markdown = await f.vaults.prepareArtifactUpload(
            f.ctx,
            await f.upload(
                zipSync({
                    "artifact.json": manifest({ type: "markdown", entry: "index.md" }),
                    "index.md": enc("# Notes"),
                    "index.html": enc("<p>also</p>"),
                }),
            ),
        );
        expect(markdown).toMatchObject({ summary: { type: "markdown", entry: "index.md" } });

        await expect(f.file(null, "notes.artifact", "x")).rejects.toMatchObject({
            code: "invalid_request",
        });
        await expect(f.folder(null, "Site.ARTIFACT")).rejects.toMatchObject({
            code: "invalid_request",
        });
        await expect(
            f.vaults.createEntry(
                f.ctx,
                f.vault.id,
                {
                    parentId: null,
                    name: "notes",
                    kind: "artifact",
                    content: { type: "stored", content: markdown },
                },
                person,
            ),
        ).rejects.toThrow(/ends in "\.artifact"/);
        const site = (
            await f.vaults.createEntry(
                f.ctx,
                f.vault.id,
                {
                    parentId: null,
                    name: "notes.artifact",
                    kind: "artifact",
                    content: { type: "stored", content: markdown },
                },
                person,
            )
        ).entry;
        await expect(
            f.vaults.moveEntry(f.ctx, f.vault.id, site.id, site.version, { name: "notes" }, person),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const plain = await f.file(null, "plain.txt", "x");
        await expect(
            f.vaults.moveEntry(
                f.ctx,
                f.vault.id,
                plain.id,
                plain.version,
                { name: "plain.artifact" },
                person,
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        // An artifact copies only to a .artifact name, and a plain file never to one.
        await expect(
            f.vaults.createEntry(
                f.ctx,
                f.vault.id,
                {
                    parentId: null,
                    name: "copy.txt",
                    kind: "file",
                    content: { type: "copy", fileId: site.id, version: "latest" },
                },
                person,
            ),
        ).rejects.toThrow(/ending in \.artifact/);
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
                content: { type: "copy", fileId: original.id, version: "latest" },
            },
            person,
        );
        expect(asFile(copy.entry).sha256).toBe(original.sha256);
        expect(await f.contentFiles()).toBe(before);
        expect(
            (await f.vaults.activity(f.ctx, other.id, copy.entry.id, {})).activity[0],
        ).toMatchObject({
            kind: "created",
            copiedFrom: original.id,
        });
        // A repeated ID returns the file unchanged, and a folder cannot take it.
        const again = await f.vaults.createEntry(
            f.ctx,
            other.id,
            {
                id: copy.entry.id,
                parentId: null,
                name: "ignored",
                kind: "file",
                content: { type: "copy", fileId: original.id, version: "latest" },
            },
            person,
        );
        expect(again).toEqual({ entry: copy.entry, created: false });
        await expect(
            f.vaults.createEntry(
                f.ctx,
                other.id,
                { id: copy.entry.id, parentId: null, name: "ignored", kind: "folder" },
                person,
            ),
        ).rejects.toMatchObject({ code: "conflict", current: { file: copy.entry } });
    });

    it("lets an agent copy files and artifacts within and between vaults by digest", async () => {
        const f = await fixture();
        const tools = await f.hooks.tools!(f.ctx, {
            agent: { id: "writer" },
            kv: f.kv.scoped("writer"),
        } as AgentModuleScope);
        const copy = tools.find((tool) => tool.name === "copy_vault_file")!;
        const committed: unknown[] = [];
        const call = (id: string) =>
            ({
                id,
                kv: f.kv.scoped(id),
                commit: async (_ctx: unknown, result: unknown) => {
                    committed.push(result);
                    return result;
                },
            }) as never;
        const docs = await f.folder(null, "Docs");
        const original = await f.file(docs.id, "big.bin", "first bytes");
        await f.vaults.createVersion(
            f.ctx,
            f.vault.id,
            original.id,
            original.version,
            { type: "upload", uploadId: await f.upload(enc("second bytes")) },
            person,
        );
        const before = await f.contentFiles();

        expect(
            await copy.execute(
                f.ctx,
                {
                    surfaceId: f.vault.id,
                    path: "/docs/BIG.bin",
                    toPath: "/Backup/old/big.bin",
                    version: 1,
                },
                call("c1"),
            ),
        ).toEqual({
            path: "/Backup/old/big.bin",
            fileId: expect.any(String),
            kind: "file",
            version: 1,
            created: true,
            folders: ["/Backup", "/Backup/old"],
        });
        expect(
            (await f.vaults.resolve(f.ctx, f.vault.id, "/Backup/old/big.bin")).entry,
        ).toMatchObject({
            latestVersion: 1,
            sha256: sha(enc("first bytes")),
        });
        const other = await f.surfaces.create(f.ctx, { type: "vault", name: "Other" }, "alice");
        const across = (await copy.execute(
            f.ctx,
            {
                surfaceId: f.vault.id,
                path: "/Docs/big.bin",
                toPath: "/big.bin",
                toSurfaceId: other.id,
            },
            call("c2"),
        )) as { fileId: string };
        const copied = (await f.vaults.location(f.ctx, other.id, across.fileId)).entry;
        expect(copied).toMatchObject({ latestVersion: 1, sha256: sha(enc("second bytes")) });
        expect((await f.vaults.activity(f.ctx, other.id, copied.id, {})).activity[0]).toMatchObject(
            {
                kind: "created",
                copiedFrom: original.id,
                actor: { agentId: "writer" },
                source: "tool",
            },
        );
        expect(await f.contentFiles()).toBe(before);

        const site = tools.find((tool) => tool.name === "write_vault_artifact")!;
        expect(
            await site.execute(
                f.ctx,
                {
                    surfaceId: f.vault.id,
                    path: "/Sites/launch.artifact",
                    files: [{ path: "index.html", content: "<h1>Launch</h1>" }],
                },
                call("a1"),
            ),
        ).toMatchObject({ kind: "artifact", version: 1, created: true, folders: ["/Sites"] });
        const withSite = await f.contentFiles();
        await copy.execute(
            f.ctx,
            {
                surfaceId: f.vault.id,
                path: "/Sites/launch.artifact",
                toPath: "/launch.artifact",
                toSurfaceId: other.id,
            },
            call("c3"),
        );
        expect(
            (await f.vaults.resolve(f.ctx, other.id, "/launch.artifact/index.html")).innerPath,
        ).toBe("index.html");
        expect(await f.contentFiles()).toBe(withSite);

        for (const [input, message] of [
            [{ path: "/Docs", toPath: "/Docs2" }, /is a folder/],
            [{ path: "/Docs/big.bin", toPath: "/Backup/old/big.bin" }, /already at/],
            [{ path: "/Docs/big.bin", toPath: "/Docs/big.bin/inside" }, /not a folder/],
            [{ path: "/Docs/missing.bin", toPath: "/x.bin" }, /Nothing is at/],
            [{ path: "/Sites/launch.artifact", toPath: "/launch" }, /ending in \.artifact/],
            [{ path: "/Docs/big.bin", toPath: "/big.artifact" }, /ending in \.artifact/],
        ] as const)
            await expect(
                copy.execute(f.ctx, { surfaceId: f.vault.id, ...input }, call("bad")),
            ).rejects.toThrow(message);
        expect(committed).toHaveLength(4);
    });

    it("gives agents separate tools for folders and files, empty folders included", async () => {
        const f = await fixture();
        const tools = await f.hooks.tools!(f.ctx, {
            agent: { id: "writer" },
            kv: f.kv.scoped("writer"),
        } as AgentModuleScope);
        const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
        const call = (id: string) =>
            ({
                id,
                kv: f.kv.scoped(id),
                commit: async (_ctx: unknown, result: unknown) => result,
            }) as never;
        const run = (name: string, input: Record<string, unknown>) =>
            tool(name).execute(f.ctx, { surfaceId: f.vault.id, ...input } as never, call(name));

        expect(await run("create_vault_folder", { path: "/Reports/Q3" })).toMatchObject({
            created: true,
            folders: ["/Reports", "/Reports/Q3"],
        });
        expect(await run("create_vault_folder", { path: "/reports/q3" })).toMatchObject({
            path: "/Reports/Q3",
            created: false,
            folders: [],
        });
        const created = f.events.filter((event) => event.type === "vault.folder.created");
        expect(created).toHaveLength(2);
        await run("write_vault_file", { path: "/Reports/notes.md", content: "# Notes" });
        // A version carries its call's ID, so the same call repeated finds it again.
        const write = (content: string) =>
            tool("write_vault_file").execute(
                f.ctx,
                { surfaceId: f.vault.id, path: "/Reports/notes.md", content } as never,
                call("w1"),
            );
        expect(await write("# Notes, again")).toMatchObject({ version: 2 });
        expect(await write("# Notes, a third time")).toMatchObject({ version: 2 });
        await expect(
            run("move_vault_file", { path: "/Reports/Q3", toPath: "/Q3" }),
        ).rejects.toThrow(/move_vault_folder/);
        await expect(run("delete_vault_folder", { path: "/Reports/notes.md" })).rejects.toThrow(
            /delete_vault_file/,
        );
        await expect(
            run("write_vault_file", { path: "/Reports/site.artifact", content: "x" }),
        ).rejects.toThrow(/write_vault_artifact/);
        await expect(
            run("write_vault_artifact", {
                path: "/Reports/site",
                files: [{ path: "index.md", content: "# Site" }],
            }),
        ).rejects.toThrow(/ends in "\.artifact"/);
        await expect(
            run("write_vault_artifact", {
                path: "/Reports/site.artifact",
                files: [
                    { path: "index.md", content: "# Site" },
                    { path: "artifact.json", content: "{}" },
                ],
            }),
        ).rejects.toThrow(/reserved/);
        await run("move_vault_folder", { path: "/Reports/Q3", toPath: "/Q3" });
        const deleted = (await run("delete_vault_folder", { path: "/Q3" })) as {
            item: VaultItem;
        };
        expect(deleted.item).toMatchObject({ kind: "folder", name: "Q3" });
        const trash = (await tool("list_vault_trash").execute(
            f.ctx,
            { surfaceId: f.vault.id } as never,
            call("trash"),
        )) as { text: string };
        expect(trash.text).toMatch(new RegExp(`^folder  ${deleted.item.id}  /Q3/`));
        await expect(run("restore_vault_file", { fileId: deleted.item.id })).rejects.toThrow(
            /restore_vault_folder/,
        );
        expect(await run("restore_vault_folder", { folderId: deleted.item.id })).toMatchObject({
            path: "/Q3",
        });
        expect(
            f.events
                .filter((event) => event.type === "vault.folder.updated")
                .map((event) => Object.keys((event.payload as { changes: object }).changes).sort()),
        ).toEqual([
            ["parentId", "updatedAt", "updatedBy"],
            ["deletedAt", "updatedAt", "updatedBy"],
            ["deletedAt", "updatedAt", "updatedBy"],
        ]);
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
        expect(
            f.events.filter(
                (event) => event.type.startsWith("vault.") && event.type.endsWith(".removed"),
            ),
        ).toEqual([
            { type: "vault.folder.removed", payload: { surfaceId: f.vault.id, folderId: docs.id } },
        ]);
        await expect(stat(f.vaults.contentPath(sha(enc("to be purged"))))).rejects.toThrow();
    });
});
