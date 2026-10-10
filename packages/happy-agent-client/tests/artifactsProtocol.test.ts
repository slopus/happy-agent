import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    artifactListResponseSchema,
    artifactPathSchema,
    artifactResponseSchema,
    artifactSchema,
    artifactUploadResponseSchema,
    artifactVersionListResponseSchema,
    artifactVersionSchema,
    createArtifactRequestSchema,
    deleteArtifactRequestSchema,
    updateArtifactRequestSchema,
    type Artifact,
    type ArtifactVersion,
} from "../sources/protocol/artifacts.js";
import {
    artifactCreatedPayloadSchema,
    artifactDeletedPayloadSchema,
    artifactUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const createdAt = 1_755_300_000_000;
const sha256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const chartSha256 = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
const entry = { mimeType: "text/markdown", path: "index.md", sha256, size: 18_234 };
const chart = {
    mimeType: "image/png",
    path: "images/chart.png",
    sha256: chartSha256,
    size: 48_213,
};

const artifact: Artifact = {
    createdAt,
    createdBy: { agentId: "agent1", botId: null, kind: "agent" },
    deletedAt: null,
    deletedBy: null,
    deletedSource: null,
    entry,
    fileCount: 2,
    id: "artifact1",
    latestVersion: 1,
    size: 66_447,
    source: {
        agentId: "agent1",
        kind: "workspace",
        projectId: "project1",
        workspaceId: "workspace1",
    },
    status: "active",
    title: "Q3 revenue report",
    type: "markdown",
    updatedAt: createdAt,
    updatedBy: { agentId: "agent1", botId: null, kind: "agent" },
    updatedSource: {
        agentId: "agent1",
        kind: "workspace",
        projectId: "project1",
        workspaceId: "workspace1",
    },
    version,
};

const firstVersion: ArtifactVersion = {
    artifactId: artifact.id,
    createdAt,
    createdBy: artifact.createdBy,
    entry,
    files: [chart, entry],
    number: 1,
    source: artifact.source,
    title: artifact.title,
};

describe("artifacts protocol", () => {
    it("validates artifacts with extensible sources and authors, versions, and uploads", () => {
        expect(Value.Check(artifactSchema, artifact)).toBe(true);
        expect(
            Value.Check(artifactSchema, {
                ...artifact,
                source: { agentId: null, botId: "bot1", kind: "bot" },
                createdBy: { kind: "user", userId: null },
            }),
        ).toBe(true);
        expect(
            Value.Check(artifactSchema, {
                ...artifact,
                source: { agentId: "task1agent", kind: "task", taskId: "task1" },
            }),
        ).toBe(true);
        // Every conversation-only source names its conversation.
        expect(
            Value.Check(artifactSchema, { ...artifact, source: { agentId: null, kind: "agent" } }),
        ).toBe(false);
        expect(Value.Check(artifactSchema, { ...artifact, source: null })).toBe(true);
        expect(Value.Check(artifactSchema, { ...artifact, title: " " })).toBe(false);
        expect(Value.Check(artifactSchema, { ...artifact, entry: { ...entry, size: 0 } })).toBe(
            false,
        );
        expect(
            Value.Check(artifactVersionSchema, {
                ...firstVersion,
                files: [{ ...chart, path: "images/../index.md" }],
            }),
        ).toBe(false);
        expect(Value.Check(artifactVersionSchema, firstVersion)).toBe(true);
        expect(
            Value.Check(artifactListResponseSchema, {
                artifacts: [artifact],
                cursor: version,
                nextPageCursor: null,
            }),
        ).toBe(true);
        expect(
            Value.Check(artifactVersionListResponseSchema, {
                nextPageCursor: "1",
                versions: [firstVersion],
            }),
        ).toBe(true);
        expect(
            Value.Check(artifactUploadResponseSchema, {
                upload: {
                    createdAt,
                    expiresAt: createdAt + 86_400_000,
                    id: "upload1",
                    sha256,
                    size: 48_213,
                },
            }),
        ).toBe(true);
    });

    it("accepts relative file paths and refuses every way out of the artifact", () => {
        for (const path of [
            "index.md",
            "images/chart.png",
            "assets/css/site.css",
            ".well-known/x.json",
            "a..b/c",
            "Bilder/Übersicht.png",
        ]) {
            expect(Value.Check(artifactPathSchema, path)).toBe(true);
        }
        for (const path of [
            "",
            ".",
            "..",
            "../index.md",
            "images/../index.md",
            "images/./chart.png",
            "images/..",
            "/index.md",
            "images/",
            "images//chart.png",
            "images\\chart.png",
            "line\nbreak.md",
            `${"a".repeat(256)}.md`,
        ]) {
            expect(Value.Check(artifactPathSchema, path)).toBe(false);
        }
    });

    it("places text and uploads at paths, and patches versions file by file", () => {
        expect(
            Value.Check(createArtifactRequestSchema, {
                files: [
                    { path: "index.md", text: "# Q3\n\n![Revenue](images/chart.png)\n" },
                    { path: "images/chart.png", uploadId: "upload1" },
                ],
                title: "Q3",
                type: "markdown",
            }),
        ).toBe(true);
        expect(
            Value.Check(createArtifactRequestSchema, {
                files: [
                    { path: "01.png", uploadId: "upload1" },
                    { path: "02.png", uploadId: "upload2" },
                ],
                id: "artifact1",
                mutationId: "create-1",
                source: { kind: "workspace", workspaceId: "workspace1" },
                title: "Storyboard",
                type: "image_series",
            }),
        ).toBe(true);
        expect(
            Value.Check(createArtifactRequestSchema, {
                files: [],
                title: "Storyboard",
                type: "image_series",
            }),
        ).toBe(false);
        expect(
            Value.Check(createArtifactRequestSchema, {
                files: [{ path: "../escape.md", text: "x" }],
                title: "Escape",
                type: "markdown",
            }),
        ).toBe(false);
        expect(
            Value.Check(createArtifactRequestSchema, {
                files: [{ path: "index.md", text: "x" }],
                title: "Unknown",
                type: "spreadsheet",
            }),
        ).toBe(false);
        expect(Value.Check(updateArtifactRequestSchema, { title: "Q3, revised" })).toBe(true);
        expect(
            Value.Check(updateArtifactRequestSchema, {
                files: [{ path: "images/chart.png", uploadId: "upload2" }],
                remove: ["images/old-chart.png"],
                replaceAll: false,
            }),
        ).toBe(true);
        expect(Value.Check(deleteArtifactRequestSchema, {})).toBe(true);
        expect(
            Value.Check(deleteArtifactRequestSchema, {
                source: { agentId: "agent1", kind: "agent" },
            }),
        ).toBe(true);
    });

    it("validates created, updated, and deleted events", () => {
        const events: HappyAgentEvent[] = [
            {
                cursor: version,
                occurredAt: createdAt,
                payload: { artifact },
                type: "artifact.created",
            },
            {
                cursor: nextVersion,
                occurredAt: createdAt + 1,
                payload: {
                    artifactId: artifact.id,
                    changes: {
                        entry,
                        fileCount: 2,
                        latestVersion: 2,
                        size: 66_447,
                        title: "Q3 revenue report, revised",
                        updatedAt: createdAt + 1,
                        updatedBy: { kind: "user", userId: "user1" },
                        updatedSource: null,
                    },
                    mutationId: "update-1",
                    previousVersion: version,
                    version: nextVersion,
                },
                type: "artifact.updated",
            },
            {
                cursor: nextVersion,
                occurredAt: createdAt + 2,
                payload: {
                    artifactId: artifact.id,
                    changes: {
                        deletedAt: createdAt + 2,
                        deletedBy: { kind: "user", userId: "user1" },
                        deletedSource: null,
                        status: "deleted",
                        updatedAt: createdAt + 2,
                        updatedBy: { kind: "user", userId: "user1" },
                        updatedSource: null,
                    },
                    previousVersion: nextVersion,
                    version: "01991f3a-7e3f-7000-8000-4b1c3d5e6f70",
                },
                type: "artifact.deleted",
            },
        ];
        expect(Value.Check(artifactCreatedPayloadSchema, events[0]?.payload)).toBe(true);
        expect(Value.Check(artifactUpdatedPayloadSchema, events[1]?.payload)).toBe(true);
        expect(Value.Check(artifactDeletedPayloadSchema, events[2]?.payload)).toBe(true);
        expect(
            Value.Check(artifactUpdatedPayloadSchema, {
                artifactId: artifact.id,
                changes: { title: "Missing the version" },
                previousVersion: version,
                version: nextVersion,
            }),
        ).toBe(false);
    });

    it("lists, reads, creates, updates, and deletes through the artifact routes", async () => {
        const requests: {
            body: string | null;
            ifMatch: string | null;
            method: string;
            url: string;
        }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            requests.push({
                body: typeof init?.body === "string" ? init.body : null,
                ifMatch: new Headers(init?.headers).get("if-match"),
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            const url = input.toString();
            const body = url.includes("/versions/")
                ? { version: firstVersion }
                : url.includes("/versions")
                  ? { nextPageCursor: null, versions: [firstVersion] }
                  : url.includes("/v0/artifacts?") || url.endsWith("/v0/artifacts")
                    ? requests.at(-1)?.method === "POST"
                        ? { artifact }
                        : { artifacts: [artifact], cursor: version, nextPageCursor: null }
                    : { artifact };
            return new Response(JSON.stringify(body), {
                headers: { "content-type": "application/json" },
                status: requests.at(-1)?.method === "POST" ? 201 : 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        await expect(client.listArtifacts()).resolves.toEqual({
            artifacts: [artifact],
            cursor: version,
            nextPageCursor: null,
        });
        await client.listArtifacts({
            includeDeleted: true,
            limit: 10,
            pageCursor: "artifact9",
            sourceId: "project1",
            sourceKind: "project",
            type: "image",
        });
        await expect(client.getArtifact("artifact/1")).resolves.toEqual({ artifact });
        await client.listArtifactVersions("artifact1", { limit: 5 });
        await expect(client.getArtifactVersion("artifact1", 1)).resolves.toEqual({
            version: firstVersion,
        });
        await expect(client.getArtifactVersion("artifact1", "latest")).resolves.toEqual({
            version: firstVersion,
        });
        await client.createArtifact({
            files: [{ path: "index.md", text: "# Q3" }],
            mutationId: "create-1",
            title: "Q3",
            type: "markdown",
        });
        await client.updateArtifact(
            "artifact1",
            {
                files: [{ path: "images/chart.png", uploadId: "upload1" }],
                remove: ["images/old.png"],
                title: "Q3, revised",
            },
            { ifMatch: version },
        );
        await client.deleteArtifact("artifact1", { ifMatch: nextVersion, mutationId: "delete-1" });

        expect(requests).toEqual([
            { body: null, ifMatch: null, method: "GET", url: "http://agent.local/v0/artifacts" },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/artifacts?includeDeleted=true&limit=10&pageCursor=artifact9&sourceId=project1&sourceKind=project&type=image",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/artifacts/artifact%2F1",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/artifacts/artifact1/versions?limit=5",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/artifacts/artifact1/versions/1",
            },
            {
                body: null,
                ifMatch: null,
                method: "GET",
                url: "http://agent.local/v0/artifacts/artifact1/versions/latest",
            },
            {
                body: JSON.stringify({
                    files: [{ path: "index.md", text: "# Q3" }],
                    mutationId: "create-1",
                    title: "Q3",
                    type: "markdown",
                }),
                ifMatch: null,
                method: "POST",
                url: "http://agent.local/v0/artifacts",
            },
            {
                body: JSON.stringify({
                    files: [{ path: "images/chart.png", uploadId: "upload1" }],
                    remove: ["images/old.png"],
                    title: "Q3, revised",
                }),
                ifMatch: version,
                method: "PATCH",
                url: "http://agent.local/v0/artifacts/artifact1",
            },
            {
                body: JSON.stringify({ mutationId: "delete-1" }),
                ifMatch: nextVersion,
                method: "POST",
                url: "http://agent.local/v0/artifacts/artifact1/delete",
            },
        ]);
    });

    it("uploads raw bytes and reads files whole, by range, and conditionally", async () => {
        const requests: { headers: Headers; method: string; url: string; body: unknown }[] = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            const headers = new Headers(init?.headers);
            requests.push({
                body: init?.body,
                headers,
                method: init?.method ?? "GET",
                url: input.toString(),
            });
            if (input.toString().endsWith("/v0/artifact-uploads")) {
                return new Response(
                    JSON.stringify({
                        upload: {
                            createdAt,
                            expiresAt: createdAt + 86_400_000,
                            id: "upload1",
                            sha256,
                            size: 3,
                        },
                    }),
                    { headers: { "content-type": "application/json" }, status: 201 },
                );
            }
            if (headers.get("if-none-match") === `"${sha256}"`) {
                return new Response(null, { status: 304 });
            }
            if (headers.get("range") !== null) {
                return new Response(new Uint8Array([2, 3]), {
                    headers: {
                        "content-range": "bytes 1-2/3",
                        "content-type": "video/mp4",
                        etag: `"${sha256}"`,
                    },
                    status: 206,
                });
            }
            return new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "video/mp4", etag: `"${sha256}"` },
                status: 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });

        const uploaded = await client.uploadArtifactFile({ data: new Uint8Array([1, 2, 3]) });
        expect(uploaded.upload.id).toBe("upload1");
        expect(requests[0]?.headers.get("content-type")).toBe("application/octet-stream");
        expect(requests[0]?.method).toBe("POST");

        const whole = await client.getArtifactFile("artifact1", 2, "media/clip.mp4");
        expect(whole).toMatchObject({ contentRange: null, contentType: "video/mp4" });
        expect([...new Uint8Array(whole?.data ?? new ArrayBuffer(0))]).toEqual([1, 2, 3]);
        expect(requests[1]?.url).toBe(
            "http://agent.local/v0/artifacts/artifact1/versions/2/files/media/clip.mp4",
        );
        expect(requests[1]?.headers.get("accept")).toBe("*/*");

        const range = await client.getArtifactFile("artifact1", 2, "media/clip.mp4", {
            range: { start: 1, end: 2 },
        });
        expect(range?.contentRange).toBe("bytes 1-2/3");
        expect(requests[2]?.headers.get("range")).toBe("bytes=1-2");
        await client.getArtifactFile("artifact1", 2, "media/clip.mp4", { range: { start: 1 } });
        expect(requests[3]?.headers.get("range")).toBe("bytes=1-");
        await client.getArtifactFile("artifact1", 2, "media/clip.mp4", { range: { suffix: 2 } });
        expect(requests[4]?.headers.get("range")).toBe("bytes=-2");

        await expect(
            client.getArtifactFile("artifact1", 2, "media/clip.mp4", {
                ifNoneMatch: `"${sha256}"`,
            }),
        ).resolves.toBeNull();
        // Each segment is encoded on its own, so the slashes stay and relative references resolve.
        const entryUrl = client.artifactFileUrl("artifact1", 2, "docs/index.html");
        expect(entryUrl).toBe(
            "http://agent.local/v0/artifacts/artifact1/versions/2/files/docs/index.html",
        );
        expect(new URL("img/hero 1.jpg", entryUrl).toString()).toBe(
            client.artifactFileUrl("artifact1", 2, "docs/img/hero 1.jpg"),
        );
        expect(client.artifactFileUrl("artifact1", "latest", "Bilder/Übersicht 100%.png")).toBe(
            "http://agent.local/v0/artifacts/artifact1/versions/latest/files/Bilder/%C3%9Cbersicht%20100%25.png",
        );
        expect(Value.Check(artifactResponseSchema, { artifact })).toBe(true);
    });
});
