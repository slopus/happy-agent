import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

async function start(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 20_000 });
    running.add(gym);
    return gym;
}

async function artifactEvents(gym: AgentGym, after: string) {
    return (await gym.client.getEvents({ after })).events.filter((event) =>
        event.type.startsWith("artifact."),
    );
}

/** The catalog's order: newest created first, the ID breaking ties. */
function newestFirst(artifacts: readonly { id: string; createdAt: number }[]): string[] {
    return [...artifacts]
        .sort((left, right) =>
            left.createdAt === right.createdAt
                ? Number(right.id > left.id) - Number(right.id < left.id)
                : right.createdAt - left.createdAt,
        )
        .map((artifact) => artifact.id);
}

async function fileText(gym: AgentGym, id: string, version: number | "latest", path: string) {
    const file = await gym.client.getArtifactFile(id, version, path);
    return Buffer.from(file!.data).toString("utf8");
}

describe("artifact versions and tombstones over the API", () => {
    it("makes a new version per change and keeps every earlier one", async () => {
        const gym = await start();
        const { artifact: first } = await gym.client.createArtifact({
            type: "html",
            title: "Landing page",
            files: [
                { path: "index.html", text: '<script src="old.js"></script>' },
                { path: "style.css", text: "body { color: navy; }\n" },
                { path: "old.js", text: "console.log('old');\n" },
            ],
        });
        const before = (await gym.client.getEvents()).latestCursor;

        // Every change names the version it was made against.
        await expect(
            gym.client.updateArtifact(first.id, { title: "Unguarded" }, { ifMatch: "" }),
        ).rejects.toMatchObject({ status: 400 });
        const stale = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        await expect(
            gym.client.updateArtifact(first.id, { title: "Stale" }, { ifMatch: stale }),
        ).rejects.toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: first.version, artifact: first },
        });
        await expect(
            gym.client.updateArtifact(first.id, {}, { ifMatch: first.version }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            gym.client.updateArtifact(
                first.id,
                { remove: ["missing.js"] },
                { ifMatch: first.version },
            ),
        ).rejects.toMatchObject({ status: 400 });

        const { artifact: second } = await gym.client.updateArtifact(
            first.id,
            {
                mutationId: "restyle",
                title: "Landing page, restyled",
                files: [{ path: "style.css", text: "body { color: teal; }\n" }],
                remove: ["old.js"],
            },
            { ifMatch: first.version },
        );
        expect(second).toMatchObject({
            id: first.id,
            title: "Landing page, restyled",
            latestVersion: 2,
            fileCount: 2,
            createdAt: first.createdAt,
            createdBy: first.createdBy,
            updatedBy: { kind: "user", userId: null },
        });
        expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
        expect(second.version > first.version).toBe(true);

        // The earlier version still serves what it held; the new one carries the entry over.
        expect(await fileText(gym, first.id, 1, "old.js")).toBe("console.log('old');\n");
        expect(await fileText(gym, first.id, 1, "style.css")).toBe("body { color: navy; }\n");
        expect(await fileText(gym, first.id, 2, "style.css")).toBe("body { color: teal; }\n");
        await expect(gym.client.getArtifactFile(first.id, 2, "old.js")).rejects.toMatchObject({
            status: 404,
        });
        const v1 = (await gym.client.getArtifactVersion(first.id, 1)).version;
        const v2 = (await gym.client.getArtifactVersion(first.id, 2)).version;
        expect(v2.entry).toEqual(v1.entry);
        expect(v2.files.map((file) => file.path)).toEqual(["index.html", "style.css"]);

        // A title alone makes a version holding the same files.
        const { artifact: third } = await gym.client.updateArtifact(
            first.id,
            { title: "Landing page, final" },
            { ifMatch: second.version },
        );
        expect(third.latestVersion).toBe(3);
        expect((await gym.client.getArtifactVersion(first.id, 3)).version.files).toEqual(v2.files);

        // Replacing every file starts the version from nothing.
        const { artifact: fourth } = await gym.client.updateArtifact(
            first.id,
            { replaceAll: true, files: [{ path: "index.html", text: "<p>Moved.</p>" }] },
            { ifMatch: third.version },
        );
        expect(fourth.fileCount).toBe(1);

        // Versions list newest first and page by number.
        const page = await gym.client.listArtifactVersions(first.id, { limit: 3 });
        expect(page.versions.map((version) => version.number)).toEqual([4, 3, 2]);
        expect(page.nextPageCursor).not.toBeNull();
        const rest = await gym.client.listArtifactVersions(first.id, {
            limit: 3,
            pageCursor: page.nextPageCursor!,
        });
        expect(rest).toEqual({ versions: [v1], nextPageCursor: null });
        await expect(
            gym.client.listArtifactVersions(first.id, { pageCursor: "not-a-cursor" }),
        ).rejects.toMatchObject({ status: 400 });

        // Each new version is announced with its fixed set of changes, chained by version.
        const events = await artifactEvents(gym, before);
        expect(events.map((event) => event.type)).toEqual([
            "artifact.updated",
            "artifact.updated",
            "artifact.updated",
        ]);
        expect(events[0]!.payload).toEqual({
            artifactId: first.id,
            previousVersion: first.version,
            version: second.version,
            changes: {
                latestVersion: 2,
                title: second.title,
                entry: second.entry,
                fileCount: 2,
                size: second.size,
                updatedBy: second.updatedBy,
                updatedSource: null,
                updatedAt: second.updatedAt,
            },
            mutationId: "restyle",
        });
        expect(events[1]!.payload).toMatchObject({
            previousVersion: second.version,
            version: third.version,
            changes: { latestVersion: 3, entry: second.entry, fileCount: 2 },
        });
        expect(events[1]!.payload).not.toHaveProperty("mutationId");
    });

    it("leaves a tombstone that stops serving content and survives a retried deletion", async () => {
        const gym = await start();
        const project = (await gym.getSession()).workspaceId;
        const { artifact } = await gym.client.createArtifact({
            type: "markdown",
            title: "Release notes",
            source: { kind: "project", projectId: project },
            files: [{ path: "index.md", text: "# Release notes\n" }],
        });
        expect(artifact.source).toEqual({ kind: "project", projectId: project, agentId: null });
        const { artifact: other } = await gym.client.createArtifact({
            type: "document",
            title: "Budget",
            files: [{ path: "budget.csv", text: "item,cost\nrent,10\n" }],
        });
        expect(other.entry.mimeType).toBe("text/csv");
        const before = (await gym.client.getEvents()).latestCursor;

        await expect(
            gym.client.deleteArtifact(artifact.id, { ifMatch: other.version }),
        ).rejects.toMatchObject({ status: 409, body: { artifact } });
        const { artifact: deleted } = await gym.client.deleteArtifact(artifact.id, {
            ifMatch: artifact.version,
            mutationId: "remove-notes",
        });
        expect(deleted).toMatchObject({
            id: artifact.id,
            status: "deleted",
            latestVersion: 1,
            deletedBy: { kind: "user", userId: null },
            deletedSource: null,
            updatedBy: { kind: "user", userId: null },
            updatedSource: null,
        });
        expect(deleted.deletedAt).toBe(deleted.updatedAt);

        // The tombstone stays readable; its versions and files do not.
        expect((await gym.client.getArtifact(artifact.id)).artifact).toEqual(deleted);
        await expect(gym.client.listArtifactVersions(artifact.id)).rejects.toMatchObject({
            status: 404,
        });
        await expect(gym.client.getArtifactVersion(artifact.id, "latest")).rejects.toMatchObject({
            status: 404,
        });
        await expect(gym.client.getArtifactFile(artifact.id, 1, "index.md")).rejects.toMatchObject({
            status: 404,
        });
        await expect(
            gym.client.updateArtifact(artifact.id, { title: "Back" }, { ifMatch: deleted.version }),
        ).rejects.toMatchObject({ status: 409, body: { artifact: deleted } });

        // A retried deletion answers the tombstone, even with the version it was first sent with.
        expect(await gym.client.deleteArtifact(artifact.id, { ifMatch: artifact.version })).toEqual(
            { artifact: deleted },
        );

        // Lists leave tombstones out unless asked for them.
        expect((await gym.client.listArtifacts()).artifacts.map((item) => item.id)).toEqual([
            other.id,
        ]);
        expect(
            (await gym.client.listArtifacts({ includeDeleted: true })).artifacts.map(
                (item) => item.id,
            ),
        ).toEqual(newestFirst([other, artifact]));
        expect(
            (
                await gym.client.listArtifacts({
                    includeDeleted: true,
                    sourceKind: "project",
                    sourceId: project,
                })
            ).artifacts.map((item) => item.id),
        ).toEqual([artifact.id]);

        const events = await artifactEvents(gym, before);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: "artifact.deleted",
            payload: {
                artifactId: artifact.id,
                previousVersion: artifact.version,
                version: deleted.version,
                changes: {
                    status: "deleted",
                    deletedBy: deleted.deletedBy,
                    deletedSource: null,
                    deletedAt: deleted.deletedAt,
                    updatedBy: deleted.updatedBy,
                    updatedSource: null,
                    updatedAt: deleted.updatedAt,
                },
                mutationId: "remove-notes",
            },
        });
    });

    it("lists the catalog newest first, filtered and paged", async () => {
        const gym = await start();
        const created = [];
        for (const title of ["First", "Second", "Third"]) {
            created.push(
                (
                    await gym.client.createArtifact({
                        type: title === "Second" ? "html" : "markdown",
                        title,
                        files: [
                            title === "Second"
                                ? { path: "index.html", text: "<p>Second</p>" }
                                : { path: "index.md", text: `# ${title}\n` },
                        ],
                    })
                ).artifact,
            );
        }
        const ids = newestFirst(created);
        const listed = await gym.client.listArtifacts();
        expect(listed.artifacts.map((artifact) => artifact.id)).toEqual(ids);
        expect(listed.nextPageCursor).toBeNull();
        expect(listed.cursor).toEqual(expect.any(String));

        const first = await gym.client.listArtifacts({ limit: 2 });
        expect(first.artifacts.map((artifact) => artifact.id)).toEqual(ids.slice(0, 2));
        const second = await gym.client.listArtifacts({
            limit: 2,
            pageCursor: first.nextPageCursor!,
        });
        expect(second.artifacts.map((artifact) => artifact.id)).toEqual(ids.slice(2));
        expect(second.nextPageCursor).toBeNull();
        await expect(
            gym.client.listArtifacts({ pageCursor: "missingartifact" }),
        ).rejects.toMatchObject({ status: 400 });

        expect(
            (await gym.client.listArtifacts({ type: "html" })).artifacts.map((item) => item.title),
        ).toEqual(["Second"]);
        expect((await gym.client.listArtifacts({ type: "podcast" })).artifacts).toEqual([]);
        expect((await gym.client.listArtifacts({ authorKind: "user" })).artifacts).toHaveLength(3);
        expect((await gym.client.listArtifacts({ authorKind: "agent" })).artifacts).toEqual([]);
        await expect(gym.client.listArtifacts({ sourceId: "someproject" })).rejects.toMatchObject({
            status: 400,
        });
    });
});
