import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

import { createAgentGym, frameEvent, type AgentGym } from "@slopus/happy-agent-gym";
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

/** One request exactly as written, so its target reaches the daemon without URL normalization. */
async function send(
    gym: AgentGym,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }> {
    return await new Promise((resolve, reject) => {
        const call = httpRequest(
            {
                socketPath: gym.socketPath,
                path,
                method: options.method ?? "GET",
                headers: {
                    authorization: `Bearer ${gym.token}`,
                    ...(options.body === undefined
                        ? {}
                        : { "content-length": String(options.body.byteLength) }),
                    ...options.headers,
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        bytes: Buffer.concat(chunks),
                    }),
                );
            },
        );
        call.on("error", reject);
        call.end(options.body === undefined ? undefined : Buffer.from(options.body));
    });
}

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

const CHART = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);
const ENTRY = "# Q3 revenue\n\n![Revenue](images/chart.png)\n";
const STYLE = "body { color: navy; }\n";

describe("artifact file bundles over the API", () => {
    it("creates a bundle from text and uploads and serves every file under one prefix", async () => {
        const gym = await start();
        const before = (await gym.client.getEvents()).latestCursor;
        const stream = gym.stream("/v0/events/stream");
        await stream.opened();

        const { upload } = await gym.client.uploadArtifactFile({ data: CHART });
        expect(upload).toEqual({
            id: expect.any(String),
            size: CHART.byteLength,
            sha256: sha256(CHART),
            createdAt: expect.any(Number),
            expiresAt: upload.createdAt + 24 * 60 * 60 * 1000,
        });

        const { artifact } = await gym.client.createArtifact({
            mutationId: "create-report",
            type: "markdown",
            title: "Q3 revenue report",
            files: [
                { path: "images/chart.png", uploadId: upload.id },
                { path: "assets/site style.css", text: STYLE },
                { path: "index.md", text: ENTRY },
            ],
        });
        const entry = {
            path: "index.md",
            mimeType: "text/markdown",
            size: Buffer.byteLength(ENTRY),
            sha256: sha256(Buffer.from(ENTRY)),
        };
        expect(artifact).toEqual({
            id: expect.any(String),
            type: "markdown",
            title: "Q3 revenue report",
            status: "active",
            latestVersion: 1,
            entry,
            fileCount: 3,
            size: Buffer.byteLength(ENTRY) + Buffer.byteLength(STYLE) + CHART.byteLength,
            source: null,
            createdBy: { kind: "user", userId: null },
            createdAt: expect.any(Number),
            updatedBy: { kind: "user", userId: null },
            updatedSource: null,
            updatedAt: artifact.createdAt,
            deletedBy: null,
            deletedSource: null,
            deletedAt: null,
            version: expect.any(String),
        });
        expect(await gym.client.getArtifact(artifact.id)).toEqual({ artifact });

        // The manifest lists every file in path order, the entry among them.
        const { version } = await gym.client.getArtifactVersion(artifact.id, 1);
        expect(version).toMatchObject({ artifactId: artifact.id, number: 1, entry, source: null });
        expect(version.files.map((file) => [file.path, file.mimeType])).toEqual([
            ["assets/site style.css", "text/css"],
            ["images/chart.png", "image/png"],
            ["index.md", "text/markdown"],
        ]);
        expect((await gym.client.getArtifactVersion(artifact.id, "latest")).version).toEqual(
            version,
        );

        // The creation is announced once, echoing the mutation.
        const created = (await gym.client.getEvents({ after: before })).events.filter((event) =>
            event.type.startsWith("artifact."),
        );
        expect(created).toMatchObject([
            { type: "artifact.created", payload: { artifact, mutationId: "create-report" } },
        ]);
        try {
            const frame = await stream.waitFor(
                (candidate) => frameEvent(candidate)?.type === "artifact.created",
            );
            expect(frameEvent(frame)).toMatchObject({
                type: "artifact.created",
                payload: { artifact, mutationId: "create-report" },
            });
        } finally {
            stream.close();
        }

        // The entry is served as itself, sandboxed, and cached for good under its number.
        const entryUrl = gym.client.artifactFileUrl(artifact.id, 1, "index.md");
        const served = await send(gym, new URL(entryUrl).pathname);
        expect(served.status).toBe(200);
        expect(served.bytes.toString("utf8")).toBe(ENTRY);
        expect(served.headers).toMatchObject({
            "content-type": "text/markdown; charset=utf-8",
            "content-length": String(Buffer.byteLength(ENTRY)),
            etag: `"${entry.sha256}"`,
            "cache-control": "private, max-age=31536000, immutable",
            vary: "Authorization",
            "content-disposition": `inline; filename="index.md"; filename*=UTF-8''index.md`,
            "x-content-type-options": "nosniff",
            "content-security-policy":
                "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
            "accept-ranges": "bytes",
        });

        // A relative reference in the entry resolves against its URL to its file.
        const chartUrl = new URL("images/chart.png", entryUrl);
        const chart = await send(gym, chartUrl.pathname);
        expect(chart.status).toBe(200);
        expect(chart.headers["content-type"]).toBe("image/png");
        expect(new Uint8Array(chart.bytes)).toEqual(CHART);
        const style = await gym.client.getArtifactFile(artifact.id, 1, "assets/site style.css");
        expect(Buffer.from(style!.data).toString("utf8")).toBe(STYLE);
        expect(style!.contentType).toBe("text/css; charset=utf-8");

        // `latest` is revalidated, and a held digest answers 304.
        const latest = await send(
            gym,
            new URL(gym.client.artifactFileUrl(artifact.id, "latest", "index.md")).pathname,
        );
        expect(latest.status).toBe(200);
        expect(latest.headers["cache-control"]).toBe("private, no-cache");
        expect(
            await gym.client.getArtifactFile(artifact.id, "latest", "index.md", {
                ifNoneMatch: `"${entry.sha256}"`,
            }),
        ).toBeNull();

        expect(gym.errors).toEqual([]);
    });

    it("answers byte ranges as a video player asks for them", async () => {
        const gym = await start();
        const { upload } = await gym.client.uploadArtifactFile({ data: CHART });
        const { artifact } = await gym.client.createArtifact({
            type: "image",
            title: "Chart",
            files: [{ path: "chart.png", uploadId: upload.id }],
        });

        const middle = await gym.client.getArtifactFile(artifact.id, 1, "chart.png", {
            range: { start: 2, end: 5 },
        });
        expect(middle!.contentRange).toBe(`bytes 2-5/${String(CHART.byteLength)}`);
        expect(new Uint8Array(middle!.data)).toEqual(CHART.slice(2, 6));
        const tail = await gym.client.getArtifactFile(artifact.id, 1, "chart.png", {
            range: { suffix: 3 },
        });
        expect(new Uint8Array(tail!.data)).toEqual(CHART.slice(-3));
        const open = await gym.client.getArtifactFile(artifact.id, 1, "chart.png", {
            range: { start: 10 },
        });
        expect(open!.contentRange).toBe(`bytes 10-12/${String(CHART.byteLength)}`);

        const path = new URL(gym.client.artifactFileUrl(artifact.id, 1, "chart.png")).pathname;
        const outside = await send(gym, path, { headers: { range: "bytes=64-" } });
        expect(outside.status).toBe(416);
        expect(outside.headers["content-range"]).toBe(`bytes */${String(CHART.byteLength)}`);
        expect(outside.headers["cache-control"]).toBe("no-store");
        expect(JSON.parse(outside.bytes.toString("utf8"))).toMatchObject({
            code: "range_not_satisfiable",
        });
        // Several ranges are ignored, answering the whole file.
        const several = await send(gym, path, { headers: { range: "bytes=0-1,4-5" } });
        expect(several.status).toBe(200);
        expect(several.bytes.byteLength).toBe(CHART.byteLength);
    });

    it("serves only paths the version's manifest holds", async () => {
        const gym = await start();
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Landing page",
            files: [
                { path: "index.html", text: '<link rel="stylesheet" href="css/site.css">' },
                { path: "css/site.css", text: STYLE },
            ],
        });
        const prefix = `/v0/artifacts/${artifact.id}/versions/1/files`;
        expect((await send(gym, `${prefix}/css/site.css`)).status).toBe(200);
        for (const target of [
            `${prefix}/css/../index.html`,
            `${prefix}/css/%2e%2e/index.html`,
            `${prefix}/css%2Fsite.css`,
            `${prefix}/css//site.css`,
            `${prefix}/./index.html`,
            `${prefix}/css`,
            `${prefix}/css/`,
            `${prefix}/missing.html`,
            `/v0/artifacts/${artifact.id}/versions/2/files/index.html`,
            `/v0/artifacts/missingartifact/versions/1/files/index.html`,
        ]) {
            const response = await send(gym, target);
            expect({ target, status: response.status }).toEqual({ target, status: 404 });
            expect(response.headers["content-security-policy"]).toBeUndefined();
        }
        expect(
            (await send(gym, `/v0/artifacts/${artifact.id}/versions/1/files/index.html`)).status,
        ).toBe(200);
    });

    it("refuses uploads and files that break the rules without creating anything", async () => {
        const gym = await start();
        const empty = await send(gym, "/v0/artifact-uploads", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: new Uint8Array(0),
        });
        expect(empty.status).toBe(400);

        const { upload } = await gym.client.uploadArtifactFile({ data: CHART });
        await expect(
            gym.client.createArtifact({
                type: "markdown",
                title: "No entry",
                files: [{ path: "notes.md", text: "# Notes\n" }],
            }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        await expect(
            gym.client.createArtifact({
                type: "markdown",
                title: "Clashing paths",
                files: [
                    { path: "index.md", text: "# Report\n" },
                    { path: "index.md", text: "# Again\n" },
                ],
            }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        await expect(
            gym.client.createArtifact({
                type: "video",
                title: "Not a video",
                files: [{ path: "clip.png", uploadId: upload.id }],
            }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        await expect(
            gym.client.createArtifact({
                type: "image",
                title: "Unknown upload",
                files: [{ path: "chart.png", uploadId: "missingupload" }],
            }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
        await expect(
            gym.client.createArtifact({
                type: "markdown",
                title: "Named a missing project",
                source: { kind: "project", projectId: "missingproject" },
                files: [{ path: "index.md", text: "# Report\n" }],
            }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        expect((await gym.client.listArtifacts()).artifacts).toEqual([]);

        // A refused creation did not use the upload; a successful one uses it up.
        const { artifact } = await gym.client.createArtifact({
            type: "image",
            title: "Chart",
            files: [{ path: "chart.png", uploadId: upload.id }],
        });
        expect(artifact.entry.sha256).toBe(sha256(CHART));
        await expect(
            gym.client.createArtifact({
                type: "image",
                title: "Chart again",
                files: [{ path: "chart.png", uploadId: upload.id }],
            }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });

        // Repeating an ID answers the existing artifact without using anything.
        const again = await gym.client.createArtifact({
            id: artifact.id,
            type: "markdown",
            title: "Ignored",
            files: [{ path: "index.md", text: "# Ignored\n" }],
        });
        expect(again.artifact).toEqual(artifact);
        expect((await gym.client.listArtifacts()).artifacts.map((item) => item.id)).toEqual([
            artifact.id,
        ]);
    });
});
