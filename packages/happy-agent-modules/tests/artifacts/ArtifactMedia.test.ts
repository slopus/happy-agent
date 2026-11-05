import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type {
    ArtifactAuthor,
    ArtifactPlacement,
    ArtifactSource,
} from "../../sources/artifacts/index.js";
import { artifactsWorld, type ArtifactsWorld } from "./support/artifactsWorld.js";

const WRITER: ArtifactAuthor = { kind: "agent", agentId: "agentalpha" };
const SOURCE: ArtifactSource = { kind: "agent", agentId: "agentalpha" };

const worlds: ArtifactsWorld[] = [];
afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
});

async function world(name: string): Promise<ArtifactsWorld> {
    const created = await artifactsWorld(name);
    worlds.push(created);
    return created;
}

async function picture(width: number, height: number, red = 20): Promise<Uint8Array> {
    const image = sharp({
        create: { width, height, channels: 3, background: { r: red, g: 120, b: 200 } },
    });
    return new Uint8Array(await image.png().toBuffer());
}

async function placed(w: ArtifactsWorld, path: string, bytes: Uint8Array | string) {
    const upload =
        typeof bytes === "string"
            ? await w.artifacts.stageText(w.ctx, bytes)
            : await w.artifacts.stageUpload(w.ctx, bytes);
    return { path, uploadId: upload.id } satisfies ArtifactPlacement;
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

/** A short test-pattern clip, made with the host's ffmpeg. */
function clip(width: number, height: number, seconds: number): Uint8Array {
    const output = join(
        tmpdir(),
        `artifact-media-${String(process.pid)}-${String(Date.now())}.mp4`,
    );
    execFileSync(
        "ffmpeg",
        [
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            `testsrc=size=${String(width)}x${String(height)}:rate=10:duration=${String(seconds)}`,
            "-pix_fmt",
            "yuv420p",
            "-y",
            output,
        ],
        { stdio: "ignore" },
    );
    const bytes = new Uint8Array(readFileSync(output));
    rmSync(output, { force: true });
    return bytes;
}

describe("artifact media metadata and previews", () => {
    it("measures every picture of an image series and stores one preview per digest, never enlarged", async () => {
        const w = await world("media-series");
        const wide = await picture(1600, 900);
        const small = await picture(320, 180, 200);
        const { artifact } = await w.artifacts.create(w.ctx, {
            type: "image_series",
            title: "Charts",
            files: [await placed(w, "1-wide.png", wide), await placed(w, "2-small.png", small)],
            author: WRITER,
            source: SOURCE,
        });
        const version = await w.artifacts.getVersion(w.ctx, artifact.id, 1);
        expect(version.files).toEqual([
            expect.objectContaining({
                path: "1-wide.png",
                width: 1600,
                height: 900,
                thumbhash: expect.any(String),
                preview: { width: 640, height: 360 },
            }),
            expect.objectContaining({
                path: "2-small.png",
                width: 320,
                height: 180,
                thumbhash: expect.any(String),
                preview: { width: 320, height: 180 },
            }),
        ]);
        expect(version.files[0]?.thumbhash).not.toBe(version.files[1]?.thumbhash);
        expect(artifact.entry).toEqual(version.files[0]);

        const preview = await w.artifacts.storedPreview(w.ctx, artifact.id, 1, "1-wide.png");
        const decoded = await sharp(await readFile(preview.contentPath)).metadata();
        expect(decoded).toMatchObject({ format: "webp", width: 640, height: 360 });
        expect(preview.preview).toEqual({ width: 640, height: 360 });

        // A later version and another artifact holding the same bytes reuse the measurements.
        const retitled = await w.artifacts.update(w.ctx, {
            artifactId: artifact.id,
            title: "Charts, again",
            files: [await placed(w, "3-again.png", wide)],
            author: WRITER,
            source: SOURCE,
        });
        const second = await w.artifacts.getVersion(w.ctx, retitled.id, 2);
        const { path: _first, ...measured } = version.files[0]!;
        expect(second.files[0]).toEqual(version.files[0]);
        expect(second.files[2]).toEqual({ ...measured, path: "3-again.png" });
        const digest = version.files[0]!.sha256;
        const previews = await readdir(dirname(preview.contentPath));
        expect(previews.filter((name) => name.startsWith(digest))).toEqual([`${digest}.webp`]);
    });

    it("measures an animated WebP from its container with a still first-frame preview", async () => {
        const w = await world("media-animated");
        const frames = await Promise.all(
            [20, 200].map(
                async (red) =>
                    await sharp({
                        create: {
                            width: 960,
                            height: 540,
                            channels: 3,
                            background: { r: red, g: 80, b: 160 },
                        },
                    })
                        .png()
                        .toBuffer(),
            ),
        );
        const webp = new Uint8Array(
            await sharp(frames, { join: { animated: true } })
                .webp({ loop: 0, delay: [400, 400] })
                .toBuffer(),
        );
        const { artifact } = await w.artifacts.create(w.ctx, {
            type: "image",
            title: "Loop",
            files: [await placed(w, "loop.webp", webp)],
            author: WRITER,
            source: SOURCE,
        });
        expect(artifact.entry).toMatchObject({
            width: 960,
            height: 540,
            thumbhash: expect.any(String),
            preview: { width: 640, height: 360 },
        });
        expect(artifact.cover?.thumbhash).toBe(artifact.entry.thumbhash);
        const preview = await w.artifacts.storedPreview(w.ctx, artifact.id, "latest", "loop.webp");
        const decoded = await sharp(await readFile(preview.contentPath)).metadata();
        expect(decoded.pages ?? 1).toBe(1);
    });

    it("measures a document's cover but not its other pictures, and makes a version from an undecodable picture", async () => {
        const w = await world("media-cover-only");
        const { artifact } = await w.artifacts.create(w.ctx, {
            type: "markdown",
            title: "Report",
            files: [
                await placed(w, "index.md", "# Report\n\n![](chart.png)\n"),
                await placed(w, "cover.png", await picture(1600, 900)),
                await placed(w, "chart.png", await picture(800, 600)),
            ],
            cover: "cover.png",
            author: WRITER,
            source: SOURCE,
        });
        const files = (await w.artifacts.getVersion(w.ctx, artifact.id, 1)).files;
        const byPath = new Map(files.map((file) => [file.path, file]));
        expect(byPath.get("cover.png")).toMatchObject({
            width: 1600,
            height: 900,
            thumbhash: artifact.cover?.thumbhash,
            preview: { width: 640, height: 360 },
        });
        expect(Object.keys(byPath.get("chart.png")!).sort()).toEqual([
            "mimeType",
            "path",
            "sha256",
            "size",
        ]);
        await expect(w.artifacts.storedPreview(w.ctx, artifact.id, 1, "chart.png")).rejects.toThrow(
            /has no preview/,
        );

        const broken = await w.artifacts.create(w.ctx, {
            type: "image",
            title: "Not really a picture",
            files: [await placed(w, "broken.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]))],
            author: WRITER,
            source: SOURCE,
        });
        expect(Object.keys(broken.artifact.entry).sort()).toEqual([
            "mimeType",
            "path",
            "sha256",
            "size",
        ]);
    });

    it("gives the next version's kept pictures what older versions lacked", async () => {
        const w = await world("media-next-version");
        const { artifact } = await w.artifacts.create(w.ctx, {
            type: "image",
            title: "Before",
            files: [await placed(w, "photo.png", await picture(1200, 1200))],
            author: WRITER,
            source: SOURCE,
        });
        // A version made before media metadata existed stored its file bare.
        await agentDatabaseRun(
            w.ctx.db,
            sql`UPDATE happy_agent_module_artifact_files SET media_json = NULL`,
        );
        await rm(w.config.artifactPreviewPath(artifact.entry.sha256), { force: true });
        expect((await w.artifacts.getVersion(w.ctx, artifact.id, 1)).entry.width).toBeUndefined();
        const next = await w.artifacts.update(w.ctx, {
            artifactId: artifact.id,
            title: "After",
            author: WRITER,
            source: SOURCE,
        });
        expect(next.entry).toMatchObject({
            width: 1200,
            height: 1200,
            preview: { width: 640, height: 640 },
        });
        expect((await w.artifacts.getVersion(w.ctx, artifact.id, 1)).entry.width).toBeUndefined();
    });

    it.skipIf(!hasFfmpeg())(
        "measures a video with the host's ffprobe and takes a poster preview with its ffmpeg",
        async () => {
            const w = await world("media-video");
            const { artifact } = await w.artifacts.create(w.ctx, {
                type: "video",
                title: "Demo",
                files: [await placed(w, "demo.mp4", clip(1280, 720, 2))],
                author: WRITER,
                source: SOURCE,
            });
            expect(artifact.entry).toMatchObject({
                width: 1280,
                height: 720,
                durationMs: expect.any(Number),
                thumbhash: expect.any(String),
                preview: { width: 640, height: 360 },
            });
            expect(Math.abs((artifact.entry.durationMs ?? 0) - 2000)).toBeLessThan(150);
            const poster = await w.artifacts.storedPreview(w.ctx, artifact.id, 1, "demo.mp4");
            expect(await sharp(await readFile(poster.contentPath)).metadata()).toMatchObject({
                format: "webp",
                width: 640,
                height: 360,
            });

            const small = await w.artifacts.create(w.ctx, {
                type: "video",
                title: "Small",
                files: [await placed(w, "small.mp4", clip(320, 240, 1))],
                author: WRITER,
                source: SOURCE,
            });
            expect(small.artifact.entry).toMatchObject({
                width: 320,
                height: 240,
                preview: { width: 320, height: 240 },
            });
        },
    );

    it("makes a video version without measurements when the host has no ffmpeg", async () => {
        const w = await world("media-video-no-tools");
        const path = process.env["PATH"];
        process.env["PATH"] = "/nonexistent";
        try {
            const { artifact } = await w.artifacts.create(w.ctx, {
                type: "video",
                title: "Demo",
                files: [await placed(w, "demo.mp4", new Uint8Array([0, 0, 0, 24, 102, 116]))],
                author: WRITER,
                source: SOURCE,
            });
            expect(Object.keys(artifact.entry).sort()).toEqual([
                "mimeType",
                "path",
                "sha256",
                "size",
            ]);
        } finally {
            process.env["PATH"] = path;
        }
    });
});
