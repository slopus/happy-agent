import { readFile, stat } from "node:fs/promises";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    ArtifactConflictError,
    ArtifactInputError,
    ArtifactNotFoundError,
    artifactRecordSchema,
    artifactVersionSchema,
    type ArtifactAuthor,
    type ArtifactPlacement,
    type ArtifactSource,
    type ArtifactType,
} from "../../sources/artifacts/index.js";
import {
    artifactsWorld,
    imageBytes,
    sha256,
    type ArtifactsWorld,
} from "./support/artifactsWorld.js";

const AGENT = "agentalpha";
const OTHER_AGENT = "agentbeta";
const BOT = "botplanner";
const PROJECT = "projectsite";
const WRITER: ArtifactAuthor = { kind: "agent", agentId: AGENT, botId: BOT };
const EDITOR: ArtifactAuthor = { kind: "user", userId: "userdana" };
const IN_BOT: ArtifactSource = { kind: "bot", botId: BOT, agentId: AGENT };
const IN_PROJECT: ArtifactSource = { kind: "project", projectId: PROJECT, agentId: OTHER_AGENT };

const worlds: ArtifactsWorld[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const world of worlds.splice(0)) await world.close();
});

async function world(name: string): Promise<ArtifactsWorld> {
    const created = await artifactsWorld(name);
    worlds.push(created);
    return created;
}

async function text(w: ArtifactsWorld, path: string, body: string): Promise<ArtifactPlacement> {
    return { path, uploadId: (await w.artifacts.stageText(w.ctx, body)).id };
}

async function bytes(
    w: ArtifactsWorld,
    path: string,
    body: Uint8Array,
): Promise<ArtifactPlacement> {
    return { path, uploadId: (await w.artifacts.stageUpload(w.ctx, body)).id };
}

async function create(
    w: ArtifactsWorld,
    type: ArtifactType,
    files: readonly ArtifactPlacement[],
    title = "Release notes",
) {
    return (
        await w.artifacts.create(w.ctx, {
            type,
            title,
            files: [...files],
            author: WRITER,
            source: IN_BOT,
        })
    ).artifact;
}

describe("ArtifactsModule", () => {
    it("publishes a Markdown bundle whose entry refers to the files beside it", async () => {
        const w = await world("artifacts-create");
        const markdown = "# Q3\n\n![Revenue](images/chart.png)\n";
        const chart = imageBytes("chart");
        const files = [
            await bytes(w, "images/chart.png", chart),
            await text(w, "index.md", markdown),
            await text(w, "data/revenue.csv", "quarter,revenue\nQ3,12\n"),
        ];
        // Removal is owed from the moment each upload exists.
        expect(await w.pendingRemovals()).toBe(3);

        const artifact = await create(w, "markdown", files);

        expect(Value.Check(artifactRecordSchema, artifact)).toBe(true);
        const entry = {
            path: "index.md",
            mimeType: "text/markdown",
            size: markdown.length,
            sha256: sha256(markdown),
        };
        expect(artifact).toMatchObject({
            type: "markdown",
            title: "Release notes",
            status: "active",
            latestVersion: 1,
            revision: 1,
            entry,
            fileCount: 3,
            size: markdown.length + chart.byteLength + "quarter,revenue\nQ3,12\n".length,
            source: IN_BOT,
            updatedSource: IN_BOT,
            createdBy: WRITER,
            updatedBy: WRITER,
        });
        const version = await w.artifacts.getVersion(w.ctx, artifact.id, "latest");
        expect(Value.Check(artifactVersionSchema, version)).toBe(true);
        expect(version.entry).toEqual(entry);
        // Kept in path order, each typed by its extension.
        expect(version.files.map((file) => [file.path, file.mimeType])).toEqual([
            ["data/revenue.csv", "text/csv"],
            ["images/chart.png", "image/png"],
            ["index.md", "text/markdown"],
        ]);

        const stored = await w.artifacts.storedFile(w.ctx, artifact.id, 1, "images/chart.png");
        expect(stored.version).toBe(1);
        expect(stored.contentPath).toBe(w.config.artifactContentPath(sha256(chart)));
        expect(new Uint8Array(await readFile(stored.contentPath))).toEqual(chart);
        expect(((await stat(stored.contentPath)).mode & 0o777).toString(8)).toBe("600");
        // Placing the uploads ends them and their owed removals in the same transaction.
        expect(await w.uploadRows()).toBe(0);
        expect(await w.uploadFiles()).toEqual([]);
        expect(await w.pendingRemovals()).toBe(0);
        expect(w.events.map((event) => event.type)).toEqual(["artifact_created"]);
        await expect(w.artifacts.get(w.ctx, artifact.id)).resolves.toEqual(artifact);
    });

    it("serves only paths the version's manifest holds, exactly as written", async () => {
        const w = await world("artifacts-paths");
        const artifact = await create(w, "html", [
            await text(w, "index.html", '<img src="img/hero.jpg">'),
            await bytes(w, "img/hero.jpg", imageBytes("hero")),
        ]);

        for (const path of [
            "../index.html",
            "img/../index.html",
            "./index.html",
            "IMG/hero.jpg",
            "img",
            "img/",
            "/index.html",
            "index.html/..",
        ]) {
            await expect(
                w.artifacts.storedFile(w.ctx, artifact.id, 1, path),
            ).rejects.toBeInstanceOf(ArtifactNotFoundError);
        }
        await expect(w.artifacts.storedFile(w.ctx, artifact.id, 2, "index.html")).rejects.toThrow(
            "The version was not found.",
        );
        await expect(
            w.artifacts.storedFile(w.ctx, artifact.id, "latest", "img/hero.jpg"),
        ).resolves.toMatchObject({ version: 1, file: { mimeType: "image/jpeg" } });

        // A path that could leave the artifact is refused before anything is placed.
        for (const path of ["../escape.html", "img/../../escape.png", "a//b.png", "a\\b.png"]) {
            await expect(
                w.artifacts.create(w.ctx, {
                    type: "html",
                    title: "Escape",
                    files: [
                        await text(w, "index.html", "<p>hi</p>"),
                        await bytes(w, path, imageBytes(path)),
                    ],
                    author: WRITER,
                }),
            ).rejects.toBeInstanceOf(ArtifactInputError);
        }
    });

    it("returns an artifact already created under the requested ID unchanged", async () => {
        const w = await world("artifacts-create-retry");
        const created = await w.artifacts.create(w.ctx, {
            id: "artifactretry",
            type: "markdown",
            title: "Draft",
            files: [await text(w, "index.md", "First")],
            author: WRITER,
        });
        const second = await text(w, "index.md", "Second");

        const again = await w.artifacts.create(w.ctx, {
            id: "artifactretry",
            type: "markdown",
            title: "Another title",
            files: [second],
            author: EDITOR,
        });

        expect(again).toEqual({ artifact: created.artifact, created: false });
        expect(w.events).toHaveLength(1);
        // The retry placed nothing, so the second upload waits out its own lifetime.
        expect(await w.uploadRows()).toBe(1);
        expect(created.artifact.source).toBeUndefined();
    });

    it("makes each version from the last one, carrying unchanged files over by digest", async () => {
        const w = await world("artifacts-versions");
        const chart = imageBytes("chart");
        const created = await create(w, "markdown", [
            await text(w, "index.md", "# One"),
            await bytes(w, "images/chart.png", chart),
            await bytes(w, "images/old.png", imageBytes("old")),
        ]);

        const retitled = await w.artifacts.update(w.ctx, {
            artifactId: created.id,
            title: "Release notes, revised",
            author: EDITOR,
            source: IN_PROJECT,
        });
        const patched = await w.artifacts.update(w.ctx, {
            artifactId: created.id,
            files: [
                await text(w, "index.md", "# Two\n\n![](images/new.png)"),
                await bytes(w, "images/new.png", imageBytes("new")),
            ],
            remove: ["images/old.png"],
            author: WRITER,
        });

        expect(retitled).toMatchObject({
            latestVersion: 2,
            revision: 2,
            title: "Release notes, revised",
            entry: created.entry,
            fileCount: 3,
            createdBy: WRITER,
            source: IN_BOT,
            updatedBy: EDITOR,
            updatedSource: IN_PROJECT,
        });
        expect(patched).toMatchObject({
            latestVersion: 3,
            revision: 3,
            title: "Release notes, revised",
            updatedBy: WRITER,
            fileCount: 3,
            entry: { path: "index.md", sha256: sha256("# Two\n\n![](images/new.png)") },
        });
        // A change made outside any place records none, rather than keeping the last one's.
        expect(patched.updatedSource).toBeUndefined();
        expect(patched.updatedAt).toBeGreaterThan(retitled.updatedAt);

        const third = await w.artifacts.getVersion(w.ctx, created.id, 3);
        expect(third.files.map((file) => file.path)).toEqual([
            "images/chart.png",
            "images/new.png",
            "index.md",
        ]);
        // The chart was never sent again: the new version holds the same stored content.
        expect(third.files[0]?.sha256).toBe(sha256(chart));
        const first = await w.artifacts.getVersion(w.ctx, created.id, 1);
        expect(first).toMatchObject({ title: "Release notes", createdBy: WRITER, source: IN_BOT });
        expect(first.files.map((file) => file.path)).toEqual([
            "images/chart.png",
            "images/old.png",
            "index.md",
        ]);
        // Old versions keep serving what they held.
        await expect(
            w.artifacts.storedFile(w.ctx, created.id, 1, "images/old.png"),
        ).resolves.toMatchObject({ file: { path: "images/old.png" } });
        await expect(
            w.artifacts.storedFile(w.ctx, created.id, "latest", "images/old.png"),
        ).rejects.toBeInstanceOf(ArtifactNotFoundError);

        const firstPage = await w.artifacts.listVersions(w.ctx, created.id, { limit: 2 });
        expect(firstPage.versions.map((version) => version.number)).toEqual([3, 2]);
        expect(firstPage.nextBefore).toBe(2);
        expect(firstPage.versions[1]).toMatchObject({ createdBy: EDITOR, source: IN_PROJECT });
        const lastPage = await w.artifacts.listVersions(w.ctx, created.id, {
            before: 2,
            limit: 2,
        });
        expect(lastPage.versions.map((version) => version.number)).toEqual([1]);
        expect(lastPage.nextBefore).toBeUndefined();

        const replaced = await w.artifacts.update(w.ctx, {
            artifactId: created.id,
            files: [await text(w, "index.md", "# Fresh start")],
            replaceAll: true,
            author: WRITER,
        });
        expect(replaced).toMatchObject({ latestVersion: 4, fileCount: 1 });

        const read = await w.artifacts.readFile(w.ctx, created.id, 3, "index.md", {
            offset: 2,
            maxBytes: 3,
        });
        expect(new TextDecoder().decode(read.bytes)).toBe("Two");
        expect(read).toMatchObject({ offset: 2, more: true, version: 3 });

        expect(w.events.map((event) => event.type)).toEqual([
            "artifact_created",
            "artifact_updated",
            "artifact_updated",
            "artifact_updated",
        ]);
        const update = w.events[2];
        if (update?.type !== "artifact_updated") throw new Error("Expected an update event.");
        expect(update.previousArtifact.revision).toBe(2);
        expect(update.artifact.revision).toBe(3);
        expect(update.version.number).toBe(3);
        expect(update.version.files).toHaveLength(3);
    });

    it("refuses a patch that removes what is not there or both writes and removes a path", async () => {
        const w = await world("artifacts-patch-refusals");
        const created = await create(w, "markdown", [
            await text(w, "index.md", "# One"),
            await text(w, "notes/today.md", "Notes"),
        ]);

        await expect(
            w.artifacts.update(w.ctx, {
                artifactId: created.id,
                remove: ["images/missing.png"],
                author: WRITER,
            }),
        ).rejects.toThrow('The artifact has no file at "images/missing.png".');
        await expect(
            w.artifacts.update(w.ctx, {
                artifactId: created.id,
                files: [await text(w, "notes.txt", "x")],
                remove: ["notes.txt"],
                author: WRITER,
            }),
        ).rejects.toThrow('"notes.txt" cannot be both written and removed.');
        await expect(
            w.artifacts.update(w.ctx, {
                artifactId: created.id,
                remove: ["index.md"],
                author: WRITER,
            }),
        ).rejects.toThrow('A Markdown document artifact needs its "index.md" file.');
        await expect(
            w.artifacts.update(w.ctx, { artifactId: created.id, author: WRITER }),
        ).rejects.toBeInstanceOf(ArtifactInputError);
        expect(w.events).toHaveLength(1);
    });

    it("makes one version per operation, and refuses a change from a stale revision", async () => {
        const w = await world("artifacts-update-retry");
        const created = await create(w, "markdown", [await text(w, "index.md", "One")]);

        const first = await w.artifacts.update(w.ctx, {
            artifactId: created.id,
            operationId: "call-1",
            title: "Second",
            author: WRITER,
        });
        const retried = await w.artifacts.update(w.ctx, {
            artifactId: created.id,
            operationId: "call-1",
            title: "Second, again",
            author: WRITER,
        });

        expect(retried).toEqual(first);
        expect(first.latestVersion).toBe(2);
        const stale = w.artifacts.update(w.ctx, {
            artifactId: created.id,
            expectedRevision: 1,
            title: "Third",
            author: WRITER,
        });
        await expect(stale).rejects.toBeInstanceOf(ArtifactConflictError);
        await expect(stale).rejects.toMatchObject({ artifact: { revision: 2 } });
        await expect(
            w.artifacts.update(w.ctx, {
                artifactId: "missingartifact",
                title: "X",
                author: WRITER,
            }),
        ).rejects.toBeInstanceOf(ArtifactNotFoundError);
        expect(w.events).toHaveLength(2);
    });

    it("deletes to a tombstone that stays listed on request while its content stops being served", async () => {
        const w = await world("artifacts-delete");
        const created = await create(w, "markdown", [await text(w, "index.md", "Secret plan")]);
        const path = w.config.artifactContentPath(sha256("Secret plan"));

        const deleted = await w.artifacts.delete(w.ctx, {
            artifactId: created.id,
            author: EDITOR,
            source: IN_PROJECT,
        });
        const again = await w.artifacts.delete(w.ctx, { artifactId: created.id, author: WRITER });

        expect(deleted).toMatchObject({
            status: "deleted",
            revision: 2,
            latestVersion: 1,
            deletedBy: EDITOR,
            deletedSource: IN_PROJECT,
            updatedBy: EDITOR,
            updatedSource: IN_PROJECT,
        });
        expect(deleted.deletedAt).toBe(deleted.updatedAt);
        expect(again).toEqual(deleted);
        expect(w.events.map((event) => event.type)).toEqual([
            "artifact_created",
            "artifact_deleted",
        ]);
        await expect(w.artifacts.get(w.ctx, created.id)).resolves.toEqual(deleted);
        await expect(w.artifacts.listVersions(w.ctx, created.id)).rejects.toBeInstanceOf(
            ArtifactNotFoundError,
        );
        await expect(w.artifacts.getVersion(w.ctx, created.id, 1)).rejects.toBeInstanceOf(
            ArtifactNotFoundError,
        );
        await expect(
            w.artifacts.storedFile(w.ctx, created.id, 1, "index.md"),
        ).rejects.toBeInstanceOf(ArtifactNotFoundError);
        await expect(
            w.artifacts.update(w.ctx, { artifactId: created.id, title: "Back", author: WRITER }),
        ).rejects.toBeInstanceOf(ArtifactConflictError);
        expect((await w.artifacts.list(w.ctx)).artifacts).toEqual([]);
        expect((await w.artifacts.list(w.ctx, { includeDeleted: true })).artifacts).toEqual([
            deleted,
        ]);
        // Nothing durable is erased: the bytes stay where they were.
        expect(await readFile(path, "utf8")).toBe("Secret plan");
    });

    it("lists newest first, filtered by type, source, and author, one page at a time", async () => {
        const w = await world("artifacts-list");
        let now = 1_700_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
        const notes = await create(w, "markdown", [await text(w, "index.md", "Notes")]);
        const photo = (
            await w.artifacts.create(w.ctx, {
                type: "image",
                title: "Screenshot",
                files: [await bytes(w, "screen.png", imageBytes("screen"))],
                author: EDITOR,
                source: IN_PROJECT,
            })
        ).artifact;
        const page = (
            await w.artifacts.create(w.ctx, {
                type: "html",
                title: "Dashboard",
                files: [await text(w, "index.html", "<h1>Dashboard</h1>")],
                author: { kind: "agent", agentId: OTHER_AGENT },
                source: { kind: "agent", agentId: OTHER_AGENT },
            })
        ).artifact;

        const ids = async (query: Parameters<typeof w.artifacts.list>[1]) =>
            (await w.artifacts.list(w.ctx, query)).artifacts.map((artifact) => artifact.id);

        expect(await ids({})).toEqual([page.id, photo.id, notes.id]);
        expect(await ids({ type: "image" })).toEqual([photo.id]);
        expect(await ids({ type: "spreadsheet" })).toEqual([]);
        expect(await ids({ sourceKind: "bot", sourceId: BOT })).toEqual([notes.id]);
        expect(await ids({ sourceKind: "project" })).toEqual([photo.id]);
        expect(await ids({ agentId: OTHER_AGENT })).toEqual([page.id, photo.id]);
        expect(await ids({ authorKind: "user" })).toEqual([photo.id]);
        expect(await ids({ authorKind: "agent", authorId: AGENT })).toEqual([notes.id]);

        const first = await w.artifacts.list(w.ctx, { limit: 2 });
        expect(first.artifacts.map((artifact) => artifact.id)).toEqual([page.id, photo.id]);
        expect(first.nextAfter).toBe(photo.id);
        const second = await w.artifacts.list(w.ctx, { limit: 2, after: photo.id });
        expect(second.artifacts.map((artifact) => artifact.id)).toEqual([notes.id]);
        expect(second.nextAfter).toBeUndefined();

        await expect(w.artifacts.list(w.ctx, { after: "unknownartifact" })).rejects.toBeInstanceOf(
            ArtifactInputError,
        );
        await expect(w.artifacts.list(w.ctx, { sourceId: BOT })).rejects.toBeInstanceOf(
            ArtifactInputError,
        );
        await expect(w.artifacts.list(w.ctx, { authorId: AGENT })).rejects.toBeInstanceOf(
            ArtifactInputError,
        );
    });

    it("holds what each type allows and says which rule a refused version broke", async () => {
        const w = await world("artifacts-types");
        const series = await create(w, "image_series", [
            await bytes(w, "03-end.webp", imageBytes("end")),
            await bytes(w, "01-start.png", imageBytes("start")),
            await bytes(w, "02-middle.JPG", imageBytes("middle")),
        ]);
        // A series opens on its first image in path order.
        expect(series.entry).toMatchObject({ path: "01-start.png", mimeType: "image/png" });
        const frames = await w.artifacts.getVersion(w.ctx, series.id, 1);
        expect(frames.files.map((file) => [file.path, file.mimeType])).toEqual([
            ["01-start.png", "image/png"],
            ["02-middle.JPG", "image/jpeg"],
            ["03-end.webp", "image/webp"],
        ]);

        const pdf = await bytes(w, "spec.pdf", new TextEncoder().encode("%PDF-1.7"));
        await expect(
            w.artifacts.create(w.ctx, {
                type: "image",
                title: "Not an image",
                files: [pdf],
                author: WRITER,
            }),
        ).rejects.toThrow('An image artifact cannot hold "spec.pdf", a application/pdf file.');
        // The refusal rolled back, so the upload is still there for a version that fits it.
        const document = await create(w, "document", [pdf]);
        expect(document.entry).toMatchObject({ path: "spec.pdf", mimeType: "application/pdf" });
        await expect(create(w, "document", [pdf])).rejects.toBeInstanceOf(ArtifactNotFoundError);

        await expect(
            create(w, "markdown", [await text(w, "README.md", "# Wrong name")]),
        ).rejects.toThrow('A Markdown document artifact needs its "index.md" file.');
        await expect(
            create(w, "html", [await bytes(w, "index.html", new Uint8Array([0x3c, 0xff, 0x3e]))]),
        ).rejects.toThrow('"index.html" must be UTF-8 text.');
        await expect(
            create(w, "markdown", [
                await text(w, "index.md", "# Clash"),
                await text(w, "notes", "a file"),
                await text(w, "notes/today.md", "and a folder"),
            ]),
        ).rejects.toThrow('"notes" cannot be both a file and the folder holding "notes/today.md".');
        const once = await text(w, "index.md", "A");
        await expect(
            create(w, "markdown", [once, { path: "copy.md", uploadId: once.uploadId }]),
        ).rejects.toThrow("Each upload can be placed only once.");
        await expect(create(w, "markdown", [once, await text(w, "index.md", "B")])).rejects.toThrow(
            "Each path can be written only once per version.",
        );
        await expect(
            create(w, "video", [
                await bytes(w, "a.mp4", imageBytes("a")),
                await bytes(w, "b.mp4", imageBytes("b")),
            ]),
        ).rejects.toThrow("A video artifact holds exactly one file.");
        // Any file may sit beside a page, typed by its extension or as plain bytes.
        const page = await create(w, "html", [
            await text(w, "index.html", "<script src='app.js'></script>"),
            await text(w, "app.js", "console.log(1)"),
            await bytes(w, "data/blob", imageBytes("blob")),
        ]);
        expect(
            (await w.artifacts.getVersion(w.ctx, page.id, 1)).files.map((file) => file.mimeType),
        ).toEqual(["text/javascript", "application/octet-stream", "text/html"]);
    });

    it("removes an unused upload and its bytes when it expires, unless something holds them", async () => {
        const w = await world("artifacts-expiry");
        const lonely = await w.artifacts.stageUpload(w.ctx, imageBytes("lonely"));
        const shared = imageBytes("shared");
        const first = await w.artifacts.stageUpload(w.ctx, shared);
        const second = await w.artifacts.stageUpload(w.ctx, shared);
        const placed = await w.artifacts.stageUpload(w.ctx, imageBytes("placed"));
        const leftover = await w.artifacts.stageUpload(w.ctx, imageBytes("placed"));
        await create(w, "image", [{ path: "placed.png", uploadId: placed.id }]);
        expect(await w.uploadRows()).toBe(4);

        await w.expire(lonely.id);
        await w.expire(first.id);
        await w.expire(leftover.id);

        expect(await w.uploadRows()).toBe(1);
        await expect(stat(w.config.artifactContentPath(lonely.sha256))).rejects.toThrow();
        // Another upload still holds the shared bytes, and a version holds the placed ones.
        expect((await stat(w.config.artifactContentPath(second.sha256))).isFile()).toBe(true);
        expect((await stat(w.config.artifactContentPath(placed.sha256))).isFile()).toBe(true);
        await w.expire(second.id);
        await expect(stat(w.config.artifactContentPath(second.sha256))).rejects.toThrow();
        await expect(
            create(w, "image", [{ path: "late.png", uploadId: first.id }]),
        ).rejects.toBeInstanceOf(ArtifactNotFoundError);
        // Expiring twice is harmless.
        await w.expire(lonely.id);
    });

    it("refuses an empty upload and keeps nothing of it", async () => {
        const w = await world("artifacts-refusals");
        await expect(w.artifacts.stageUpload(w.ctx, new Uint8Array(0))).rejects.toThrow(
            "An artifact file cannot be empty.",
        );
        expect(await w.uploadRows()).toBe(0);
        expect(await w.uploadFiles()).toEqual([]);
        expect(await w.pendingRemovals()).toBe(0);
    });

    it("publishes events only after the change commits, and none for a rolled-back change", async () => {
        const w = await world("artifacts-events");
        const draft = await text(w, "index.md", "Draft");

        await expect(
            w.ctx.inTx(async (txCtx) => {
                await w.artifacts.create(txCtx, {
                    type: "markdown",
                    title: "Rolled back",
                    files: [draft],
                    author: WRITER,
                });
                expect(w.events).toEqual([]);
                throw new Error("The caller changed its mind.");
            }),
        ).rejects.toThrow("The caller changed its mind.");
        expect(w.events).toEqual([]);
        expect((await w.artifacts.list(w.ctx)).artifacts).toEqual([]);
        expect(await w.uploadRows()).toBe(1);
        expect(await w.pendingRemovals()).toBe(1);

        const created = await w.ctx.inTx(async (txCtx) => {
            const creation = await w.artifacts.create(txCtx, {
                type: "markdown",
                title: "Committed",
                files: [draft],
                author: WRITER,
            });
            expect(w.events).toEqual([]);
            return creation.artifact;
        });
        expect(w.events).toEqual([
            expect.objectContaining({ type: "artifact_created", artifact: created }),
        ]);
        expect(Object.isFrozen(w.events[0])).toBe(true);
    });

    it("stages texts and passes uploads through when files are described by callers", async () => {
        const w = await world("artifacts-stage-files");
        const chart = await w.artifacts.stageUpload(w.ctx, imageBytes("chart"));

        const placements = await w.artifacts.stageFiles(w.ctx, [
            { path: "index.md", text: "# Staged" },
            { path: "images/chart.png", uploadId: chart.id },
        ]);

        expect(placements[1]).toEqual({ path: "images/chart.png", uploadId: chart.id });
        const artifact = await create(w, "markdown", placements);
        expect(artifact.entry.sha256).toBe(sha256("# Staged"));
        await expect(
            w.artifacts.stageFiles(w.ctx, [{ path: "../index.md", text: "x" }]),
        ).rejects.toBeInstanceOf(ArtifactInputError);
    });
});
