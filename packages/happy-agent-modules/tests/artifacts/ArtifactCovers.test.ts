import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
    ArtifactInputError,
    type ArtifactAuthor,
    type ArtifactPlacement,
    type ArtifactRecord,
    type ArtifactSource,
} from "../../sources/artifacts/index.js";
import { LIVE_ARTIFACT_FALLBACK } from "../../sources/artifacts/impl/liveArtifact.js";
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

async function picture(
    width: number,
    height: number,
    format: "png" | "jpeg" | "webp" = "png",
): Promise<Uint8Array> {
    const image = sharp({
        create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
    });
    return new Uint8Array(await image.toFormat(format).toBuffer());
}

async function placed(w: ArtifactsWorld, path: string, bytes: Uint8Array | string) {
    const upload =
        typeof bytes === "string"
            ? await w.artifacts.stageText(w.ctx, bytes)
            : await w.artifacts.stageUpload(w.ctx, bytes);
    return { path, uploadId: upload.id } satisfies ArtifactPlacement;
}

async function report(w: ArtifactsWorld, extra: { cover?: string | null; summary?: string }) {
    return (
        await w.artifacts.create(w.ctx, {
            type: "markdown",
            title: "Q3 revenue",
            files: [
                await placed(w, "index.md", "# Q3\n"),
                await placed(w, "cover.png", await picture(1600, 900)),
            ],
            ...extra,
            author: WRITER,
            source: SOURCE,
        })
    ).artifact;
}

async function update(
    w: ArtifactsWorld,
    artifact: ArtifactRecord,
    change: {
        cover?: string | null;
        summary?: string | null;
        title?: string;
        files?: ArtifactPlacement[];
        remove?: string[];
        replaceAll?: boolean;
    },
) {
    return await w.artifacts.update(w.ctx, {
        artifactId: artifact.id,
        ...change,
        author: WRITER,
        source: SOURCE,
    });
}

describe("artifact covers and summaries", () => {
    it("records a named cover's decoded size and carries cover and summary into later versions", async () => {
        const w = await world("covers-named");
        const summary = "Revenue up 18% QoQ, driven by enterprise seats.";
        const artifact = await report(w, { cover: "cover.png", summary });
        const cover = {
            path: "cover.png",
            mimeType: "image/png",
            width: 1600,
            height: 900,
            aspect: "wide",
            thumbhash: expect.any(String),
            preview: { width: 640, height: 360 },
        };
        expect(artifact).toMatchObject({ cover, summary });
        expect(await w.artifacts.getVersion(w.ctx, artifact.id, 1)).toMatchObject({
            cover,
            summary,
        });

        const retitled = await update(w, artifact, { title: "Q3 revenue, final" });
        expect(retitled).toMatchObject({ latestVersion: 2, cover, summary });
        // The same file keeps its ThumbHash; another picture gets its own.
        expect(retitled.cover?.thumbhash).toBe(artifact.cover?.thumbhash);

        // Replacing the cover's file measures it again.
        const square = await update(w, retitled, {
            files: [await placed(w, "cover.png", await picture(1200, 1200))],
        });
        expect(square.cover?.thumbhash).not.toBe(artifact.cover?.thumbhash);
        expect(square.cover).toEqual({
            ...cover,
            width: 1200,
            height: 1200,
            aspect: "square",
            thumbhash: expect.any(String),
            preview: { width: 640, height: 640 },
        });

        const cleared = await update(w, square, { cover: null, summary: null });
        expect(cleared.cover).toBeUndefined();
        expect(cleared.summary).toBeUndefined();
        const versions = (await w.artifacts.listVersions(w.ctx, artifact.id)).versions;
        expect(versions.map((version) => version.cover?.width ?? null)).toEqual([
            null,
            1200,
            1600,
            1600,
        ]);
    });

    it("refuses a version that loses its cover's file or breaks the cover rules, and makes nothing", async () => {
        const w = await world("covers-refused");
        const artifact = await report(w, { cover: "cover.png" });

        await expect(update(w, artifact, { remove: ["cover.png"] })).rejects.toThrow(
            /no longer be in the artifact/,
        );
        await expect(
            update(w, artifact, { files: [await placed(w, "cover.png", await picture(320, 180))] }),
        ).rejects.toThrow(/too small for a wide cover/);
        await expect(
            update(w, artifact, {
                files: [await placed(w, "cover.png", await picture(4800, 2700))],
            }),
        ).rejects.toThrow(/too large/);
        await expect(
            update(w, artifact, {
                files: [await placed(w, "cover.png", await picture(1600, 1200))],
            }),
        ).rejects.toThrow(/neither 16:9 nor square/);
        await expect(
            update(w, artifact, {
                files: [await placed(w, "cover.png", await picture(3000, 500))],
            }),
        ).rejects.toThrow(/neither 16:9 nor square.*1600×900.*1200×1200/);
        await expect(
            update(w, artifact, {
                files: [await placed(w, "cover.png", await picture(1600, 900, "jpeg"))],
            }),
        ).rejects.toThrow(/could not be read as a PNG image/);
        await expect(
            update(w, artifact, {
                files: [
                    await placed(
                        w,
                        "chart.svg",
                        '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"/>',
                    ),
                ],
                cover: "chart.svg",
            }),
        ).rejects.toThrow(/Render the SVG to a PNG or WebP/);
        await expect(update(w, artifact, { cover: "missing.png" })).rejects.toThrow(
            /no file at "missing.png"/,
        );
        await expect(update(w, artifact, { cover: "index.md" })).rejects.toThrow(
            /must be a PNG, JPEG, WebP, or GIF/,
        );
        for (const [summary, reason] of [
            [" \r\n\t ", /needs some text/],
            ["tab\there", /plain text/],
            ["a".repeat(5001), /at most 5,000 characters; this one has 5,001/],
        ] as const) {
            await expect(update(w, artifact, { summary })).rejects.toThrow(reason);
            await expect(update(w, artifact, { summary })).rejects.toBeInstanceOf(
                ArtifactInputError,
            );
        }
        expect((await w.artifacts.get(w.ctx, artifact.id))?.latestVersion).toBe(1);

        // Removing the file together with the cover is fine.
        const moved = await update(w, artifact, {
            remove: ["cover.png"],
            files: [await placed(w, "art/cover.webp", await picture(1600, 900, "webp"))],
            cover: "art/cover.webp",
        });
        expect(moved.cover).toEqual({
            path: "art/cover.webp",
            mimeType: "image/webp",
            width: 1600,
            height: 900,
            aspect: "wide",
            thumbhash: expect.any(String),
            preview: { width: 640, height: 360 },
        });
    });

    it("keeps a summary as a post: line breaks kept, CRLF made LF, and trimmed", async () => {
        const w = await world("covers-summary-post");
        const artifact = await report(w, {
            summary: "  Q3 revenue grew 18%.\r\n\r\nChurn fell to 2.1% — see the cohort chart.\n",
        });
        expect(artifact.summary).toBe(
            "Q3 revenue grew 18%.\n\nChurn fell to 2.1% — see the cohort chart.",
        );
        // Five thousand characters, counted as characters rather than UTF-16 units.
        const long = await update(w, artifact, { summary: "😀".repeat(5000) });
        expect([...(long.summary ?? "")]).toHaveLength(5000);
        expect((await update(w, long, { summary: "Short again." })).summary).toBe("Short again.");
    });

    it("measures animated WebP and GIF covers from their containers, with a first-frame ThumbHash", async () => {
        const w = await world("covers-animated");
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
        const animated = sharp(frames, { join: { animated: true } });
        const webp = new Uint8Array(
            await animated
                .clone()
                .webp({ loop: 0, delay: [400, 400] })
                .toBuffer(),
        );
        const gif = new Uint8Array(
            await animated
                .clone()
                .gif({ loop: 0, delay: [400, 400] })
                .toBuffer(),
        );
        const artifact = await report(w, {});
        const moving = await update(w, artifact, {
            files: [await placed(w, "cover.webp", webp)],
            cover: "cover.webp",
        });
        expect(moving.cover).toEqual({
            path: "cover.webp",
            mimeType: "image/webp",
            width: 960,
            height: 540,
            aspect: "wide",
            thumbhash: expect.any(String),
            preview: { width: 640, height: 360 },
        });
        const looping = await update(w, moving, {
            files: [await placed(w, "cover.gif", gif)],
            cover: "cover.gif",
        });
        expect(looping.cover).toMatchObject({ width: 960, height: 540 });
        const still = await update(w, looping, {
            files: [
                await placed(w, "still.webp", await picture(1200, 1200, "webp")),
                await placed(
                    w,
                    "still.gif",
                    new Uint8Array(await sharp(frames[0]).gif().toBuffer()),
                ),
            ],
            cover: "still.webp",
        });
        expect(still.cover).toMatchObject({ aspect: "square", thumbhash: expect.any(String) });
        expect((await update(w, still, { cover: "still.gif" })).cover).toMatchObject({
            width: 960,
            thumbhash: expect.any(String),
        });
        const lossless = new Uint8Array(await sharp(frames[0]).webp({ lossless: true }).toBuffer());
        const exact = await update(w, still, {
            files: [await placed(w, "lossless.webp", lossless)],
            cover: "lossless.webp",
        });
        expect(exact.cover).toMatchObject({ width: 960, height: 540 });
        // A GIF whose header reads but whose frames do not decode is a cover without a ThumbHash.
        const broken = new Uint8Array([...gif.subarray(0, 13), 0x2c, 0, 0, 0, 0, 0xc0, 0x03]);
        const unreadable = await update(w, exact, {
            files: [await placed(w, "broken.gif", broken)],
            cover: "broken.gif",
        });
        expect(unreadable.cover).toMatchObject({ width: 960, height: 540, thumbhash: null });
        // A file named as WebP that is not one is refused, as for any other format.
        await expect(
            update(w, exact, { files: [await placed(w, "fake.webp", gif)], cover: "fake.webp" }),
        ).rejects.toThrow(/could not be read as a WebP image/);
    });

    it("leaves other types without a cover unless one is named", async () => {
        const w = await world("covers-none");
        const artifact = await report(w, {});
        expect(artifact.cover).toBeUndefined();
        expect((await update(w, artifact, { title: "Renamed" })).cover).toBeUndefined();
    });

    it("covers an image with itself, follows its file, and stays cleared once cleared", async () => {
        const w = await world("covers-image");
        const { artifact } = await w.artifacts.create(w.ctx, {
            type: "image",
            title: "Chart",
            files: [await placed(w, "chart.png", await picture(1600, 900))],
            author: WRITER,
            source: SOURCE,
        });
        expect(artifact.cover).toEqual({
            path: "chart.png",
            mimeType: "image/png",
            width: 1600,
            height: 900,
            aspect: "wide",
            thumbhash: expect.any(String),
            preview: { width: 640, height: 360 },
        });

        // A new picture under another name takes the default along with it.
        const replaced = await update(w, artifact, {
            replaceAll: true,
            files: [await placed(w, "chart-v2.jpg", await picture(1200, 1200, "jpeg"))],
        });
        expect(replaced.cover).toMatchObject({
            path: "chart-v2.jpg",
            aspect: "square",
            thumbhash: expect.any(String),
        });

        // A picture of no standard shape has no cover, and that is not an error.
        const banner = await update(w, replaced, {
            replaceAll: true,
            files: [await placed(w, "banner.png", await picture(1600, 1200))],
        });
        expect(banner.latestVersion).toBe(3);
        expect(banner.cover).toBeUndefined();
        const back = await update(w, banner, {
            replaceAll: true,
            files: [await placed(w, "chart.png", await picture(1600, 900))],
        });
        expect(back.cover).toMatchObject({ path: "chart.png" });

        const cleared = await update(w, back, { cover: null });
        expect(cleared.cover).toBeUndefined();
        const another = await update(w, cleared, {
            replaceAll: true,
            files: [await placed(w, "other.png", await picture(1600, 900))],
        });
        expect(another.cover).toBeUndefined();
    });

    it("covers an image series with its first picture, and an SVG image with nothing", async () => {
        const w = await world("covers-series");
        const { artifact: series } = await w.artifacts.create(w.ctx, {
            type: "image_series",
            title: "Frames",
            files: [
                await placed(w, "02-after.png", await picture(800, 800)),
                await placed(w, "01-before.png", await picture(1600, 900)),
            ],
            author: WRITER,
            source: SOURCE,
        });
        expect(series.cover).toMatchObject({ path: "01-before.png", width: 1600, height: 900 });

        const { artifact: vector } = await w.artifacts.create(w.ctx, {
            type: "image",
            title: "Logo",
            files: [
                await placed(
                    w,
                    "logo.svg",
                    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"/>',
                ),
            ],
            author: WRITER,
            source: SOURCE,
        });
        expect(vector.cover).toBeUndefined();
    });

    it("gives a live page a summary but never a cover", async () => {
        const w = await world("covers-live");
        const create = async (cover?: string) =>
            await w.artifacts.create(w.ctx, {
                type: "html",
                title: "Dev server",
                files: [await placed(w, "index.html", LIVE_ARTIFACT_FALLBACK)],
                live: { url: "http://localhost:5173/", networkId: "local" },
                summary: "The checkout flow, running locally.",
                ...(cover === undefined ? {} : { cover }),
                author: WRITER,
                source: SOURCE,
            });
        await expect(create("index.html")).rejects.toThrow(/cannot have a cover/);
        const { artifact } = await create();
        expect(artifact).toMatchObject({ summary: "The checkout flow, running locally." });
        expect(artifact.cover).toBeUndefined();
        const summarized = await update(w, artifact, { summary: "Now with payments." });
        expect(summarized.summary).toBe("Now with payments.");
    });
});
