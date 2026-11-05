import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

import type { ArtifactVersion } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** The media fields, which the published client the gym uses does not type yet. */
interface Measured {
    readonly path: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationMs?: number;
    readonly thumbhash?: string;
    readonly preview?: { readonly width: number; readonly height: number };
}

async function fixture(name: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(new URL(`fixtures/${name}`, import.meta.url)));
}

async function upload(gym: AgentGym, bytes: Uint8Array): Promise<string> {
    return (await gym.client.uploadArtifactFile({ data: new Uint8Array(bytes) })).upload.id;
}

function filesOf(version: ArtifactVersion): readonly Measured[] {
    return version.files as readonly Measured[];
}

/** The pixel size in a still WebP's own header, read without an image library. */
function webpSize(bytes: Uint8Array): { readonly width: number; readonly height: number } {
    const view = Buffer.from(bytes);
    expect(view.toString("latin1", 0, 4)).toBe("RIFF");
    expect(view.toString("latin1", 8, 12)).toBe("WEBP");
    const chunk = view.toString("latin1", 12, 16);
    if (chunk === "VP8 ") {
        return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L") {
        const bits = view.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    expect(chunk).toBe("VP8X");
    // A still with alpha: the extended header carries the canvas, and no animation flag.
    expect(view[20]! & 0x02).toBe(0);
    return { width: view.readUIntLE(24, 3) + 1, height: view.readUIntLE(27, 3) + 1 };
}

function hasFfmpeg(): boolean {
    try {
        execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
        execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

describe("artifact media metadata and previews over the API", () => {
    it("measures pictures as the version is made and serves still previews like files", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        running.add(gym);
        const animated = await fixture("animated-cover.webp");
        const { artifact } = await gym.client.createArtifact({
            type: "image_series",
            title: "Loops",
            files: [
                { path: "1-loop.webp", uploadId: await upload(gym, animated) },
                {
                    path: "2-loop.gif",
                    uploadId: await upload(gym, await fixture("animated-cover.gif")),
                },
            ],
        });
        const { version } = await gym.client.getArtifactVersion(artifact.id, 1);
        for (const file of filesOf(version)) {
            expect(file).toMatchObject({
                width: 960,
                height: 540,
                thumbhash: expect.any(String),
                preview: { width: 640, height: 360 },
            });
            expect(file.thumbhash!.length).toBeLessThanOrEqual(128);
        }
        expect(artifact.entry).toEqual(version.files[0]);

        // The preview of an animated WebP is a still of its first frame, fitted within 640×640.
        const preview = await gym.http.request(
            "GET",
            `/v0/artifacts/${artifact.id}/versions/1/previews/1-loop.webp`,
        );
        expect(preview.status).toBe(200);
        expect(preview.headers["content-type"]).toBe("image/webp");
        expect(preview.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
        expect(preview.headers["x-content-type-options"]).toBe("nosniff");
        const etag = preview.headers.etag;
        expect(etag).toBe(`"${version.files[0]!.sha256}-preview"`);
        const bytes = await gym.client.getArtifactFile(artifact.id, 1, "1-loop.webp");
        expect(bytes?.etag).not.toBe(etag);
        const still = await previewBytes(gym, artifact.id, "1", "1-loop.webp");
        expect(webpSize(still)).toEqual({ width: 640, height: 360 });
        const latest = await gym.http.request(
            "GET",
            `/v0/artifacts/${artifact.id}/versions/latest/previews/2-loop.gif`,
        );
        expect(latest.status).toBe(200);
        expect(latest.headers["cache-control"]).toBe("private, no-cache");

        // A later version keeps the measurements, and the same bytes elsewhere reuse them.
        const next = await gym.client.updateArtifact(
            artifact.id,
            {
                title: "Loops, again",
                files: [{ path: "3-loop.webp", uploadId: await upload(gym, animated) }],
            },
            { ifMatch: artifact.version },
        );
        const { version: second } = await gym.client.getArtifactVersion(next.artifact.id, 2);
        const { path: _path, ...measured } = filesOf(version)[0]!;
        expect(filesOf(second)[2]).toEqual({ ...measured, path: "3-loop.webp" });

        // A file without a preview, or one the version does not hold, is 404.
        const { artifact: page } = await gym.client.createArtifact({
            type: "markdown",
            title: "Notes",
            files: [
                { path: "index.md", text: "# Notes\n" },
                { path: "loop.webp", uploadId: await upload(gym, animated) },
            ],
        });
        const { version: notes } = await gym.client.getArtifactVersion(page.id, 1);
        expect(
            Object.keys(filesOf(notes).find((file) => file.path === "loop.webp")!).sort(),
        ).toEqual(["mimeType", "path", "sha256", "size"]);
        for (const path of ["loop.webp", "index.md", "missing.webp"]) {
            const missing = await gym.http.request(
                "GET",
                `/v0/artifacts/${page.id}/versions/1/previews/${path}`,
            );
            expect(missing.status).toBe(404);
        }
        expect(gym.errors).toEqual([]);
    });

    it.skipIf(!hasFfmpeg())(
        "measures a video with the daemon host's ffprobe and serves its poster preview",
        async () => {
            const gym = await createAgentGym({ timeoutMs: 20_000 });
            running.add(gym);
            const { artifact } = await gym.client.createArtifact({
                type: "video",
                title: "Clip",
                files: [
                    {
                        path: "clip.mp4",
                        uploadId: await upload(gym, await fixture("artifact-clip.mp4")),
                    },
                ],
            });
            const entry = artifact.entry as Measured;
            expect(entry).toMatchObject({
                width: 640,
                height: 360,
                durationMs: expect.any(Number),
                thumbhash: expect.any(String),
                preview: { width: 640, height: 360 },
            });
            expect(Math.abs(entry.durationMs! - 1000)).toBeLessThan(150);
            const poster = await previewBytes(gym, artifact.id, "1", "clip.mp4");
            expect(webpSize(poster)).toEqual({ width: 640, height: 360 });
            expect(gym.errors).toEqual([]);
        },
    );
});

/** One preview's bytes, read over the gym daemon's socket; the published client has no call yet. */
async function previewBytes(
    gym: AgentGym,
    artifactId: string,
    version: string,
    path: string,
): Promise<Uint8Array> {
    return await new Promise((resolve, reject) => {
        const call = httpRequest(
            {
                headers: { authorization: `Bearer ${gym.http.token}` },
                method: "GET",
                path: `/v0/artifacts/${artifactId}/versions/${version}/previews/${path}`,
                socketPath: gym.http.socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`The preview answered ${String(response.statusCode)}.`));
                        return;
                    }
                    resolve(new Uint8Array(Buffer.concat(chunks)));
                });
            },
        );
        call.on("error", reject);
        call.end();
    });
}
