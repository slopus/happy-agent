import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { getImageProcessor } from "../../impl/images/getImageProcessor.js";
import type { ArtifactFile, ArtifactFileMedia } from "../Artifact.js";
import { artifactFileExists, readArtifactContent } from "./artifactContentFiles.js";
import {
    artifactStillFrame,
    MAX_ARTIFACT_DECODED_PIXELS,
    readArtifactPictureSize,
    readArtifactThumbHash,
} from "./artifactPictures.js";

/** What a file is measured as: a picture, or a video artifact's video. */
export type ArtifactMediaKind = "image" | "video";

/** The picture formats the daemon decodes, by media type, with the format its decoder reports. */
export const ARTIFACT_PICTURE_FORMATS: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
};

/** The box every preview fits within, never enlarged. */
export const ARTIFACT_PREVIEW_SIDE = 640;
/** The largest picture read whole to measure; a larger one goes unmeasured. */
const MAX_MEASURED_PICTURE_BYTES = 64 * 1024 * 1024;
/** How long `ffprobe` or `ffmpeg` may run on one video. */
const VIDEO_TOOL_TIMEOUT_MS = 15_000;
/** The most a first frame, fitted within the preview box, may be as PNG. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Measure one stored picture or video for its file object, as chat media is measured: the size as
 * shown, a video's length, the first frame's ThumbHash, and a still WebP preview fitted within
 * 640×640, written beside the other previews under the file's digest. A video's first frame, its
 * poster, is taken with the daemon host's own `ffmpeg`, and its size and length with `ffprobe`,
 * since the stored bytes are there whichever client or agent made the version. Whatever cannot be
 * measured is left out: this never throws, and a host without those tools measures no video.
 */
export async function measureArtifactMedia(
    file: ArtifactFile,
    kind: ArtifactMediaKind,
    contentPath: string,
    previewPath: string,
): Promise<ArtifactFileMedia> {
    try {
        return kind === "image"
            ? await measurePicture(file, contentPath, previewPath)
            : await measureVideo(contentPath, previewPath);
    } catch {
        return {};
    }
}

async function measurePicture(
    file: ArtifactFile,
    contentPath: string,
    previewPath: string,
): Promise<ArtifactFileMedia> {
    const format = ARTIFACT_PICTURE_FORMATS[file.mimeType];
    if (format === undefined || file.size > MAX_MEASURED_PICTURE_BYTES) return {};
    const bytes = await readArtifactContent(contentPath, 0, file.size);
    const size = await readArtifactPictureSize(bytes, format);
    if (size === undefined) return {};
    const still = artifactStillFrame(bytes, format);
    const measured = still === undefined ? {} : await previewOf(still, previewPath);
    return { width: size.width, height: size.height, ...measured };
}

async function measureVideo(contentPath: string, previewPath: string): Promise<ArtifactFileMedia> {
    const probed = await probeVideo(contentPath);
    const frame = await videoFrame(contentPath);
    const measured = frame === undefined ? {} : await previewOf(frame, previewPath);
    return { ...probed, ...measured };
}

/**
 * A still's preview, written to `previewPath` unless one is already there, and the ThumbHash
 * read from the preview, which is small enough to decode again cheaply.
 */
async function previewOf(
    still: Uint8Array,
    previewPath: string,
): Promise<Pick<ArtifactFileMedia, "preview" | "thumbhash">> {
    let preview: { readonly data: Uint8Array; readonly width: number; readonly height: number };
    try {
        const processor = await getImageProcessor();
        preview = await processor.encode(still, {
            autoOrient: true,
            format: "webp",
            maxPixels: MAX_ARTIFACT_DECODED_PIXELS,
            quality: 80,
            resize: {
                filter: "lanczos3",
                fit: "inside",
                height: ARTIFACT_PREVIEW_SIDE,
                width: ARTIFACT_PREVIEW_SIDE,
                withoutEnlargement: true,
            },
        });
    } catch {
        const thumbhash = await readArtifactThumbHash(still);
        return thumbhash === null ? {} : { thumbhash };
    }
    const thumbhash = await readArtifactThumbHash(preview.data);
    const stored = await storePreview(previewPath, preview.data);
    return {
        ...(thumbhash === null ? {} : { thumbhash }),
        ...(stored ? { preview: { width: preview.width, height: preview.height } } : {}),
    };
}

/**
 * Keep a preview under its source's digest. The same source always makes the same preview, so
 * one already stored wins; a new one is written beside it and moved into place whole.
 */
async function storePreview(previewPath: string, data: Uint8Array): Promise<boolean> {
    try {
        if (await artifactFileExists(previewPath)) return true;
        await mkdir(dirname(previewPath), { recursive: true, mode: 0o700 });
        const partial = `${previewPath}.${randomUUID()}.partial`;
        try {
            await writeFile(partial, data, { mode: 0o600 });
            await rename(partial, previewPath);
        } finally {
            await rm(partial, { force: true });
        }
        return true;
    } catch {
        return false;
    }
}

const probeSchema = Type.Object({
    streams: Type.Optional(
        Type.Array(
            Type.Object({
                width: Type.Optional(Type.Number()),
                height: Type.Optional(Type.Number()),
                duration: Type.Optional(Type.String()),
                tags: Type.Optional(Type.Object({ rotate: Type.Optional(Type.String()) })),
                side_data_list: Type.Optional(
                    Type.Array(Type.Object({ rotation: Type.Optional(Type.Number()) })),
                ),
            }),
        ),
    ),
    format: Type.Optional(Type.Object({ duration: Type.Optional(Type.String()) })),
});

/** A video's size as shown, after its rotation, and its length, as `ffprobe` reports them. */
async function probeVideo(
    contentPath: string,
): Promise<Pick<ArtifactFileMedia, "width" | "height" | "durationMs">> {
    const output = await run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation:format=duration",
        "-of",
        "json",
        contentPath,
    ]);
    if (output === undefined) return {};
    const parsed: unknown = JSON.parse(output.toString("utf8"));
    if (!Value.Check(probeSchema, parsed)) return {};
    const stream = parsed.streams?.[0];
    if (stream === undefined) return {};
    const seconds = Number(stream.duration ?? parsed.format?.duration);
    const durationMs =
        Number.isFinite(seconds) && seconds >= 0 ? { durationMs: Math.round(seconds * 1000) } : {};
    const { width, height } = stream;
    if (
        width === undefined ||
        height === undefined ||
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width < 1 ||
        height < 1
    ) {
        return durationMs;
    }
    const rotation =
        stream.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ??
        Number(stream.tags?.rotate ?? 0);
    const turned = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    return turned
        ? { width: height, height: width, ...durationMs }
        : { width, height, ...durationMs };
}

/**
 * The video's first frame as shown, fitted within the preview box and never enlarged, as a PNG.
 * `ffmpeg` applies the video's rotation itself.
 */
async function videoFrame(contentPath: string): Promise<Uint8Array | undefined> {
    const side = String(ARTIFACT_PREVIEW_SIDE);
    const frame = await run("ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-i",
        contentPath,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease`,
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "-",
    ]);
    return frame === undefined || frame.byteLength === 0 ? undefined : new Uint8Array(frame);
}

/** One run of a host tool's standard output, or undefined when it is missing, fails, or overruns. */
async function run(command: string, args: readonly string[]): Promise<Buffer | undefined> {
    return await new Promise((resolve) => {
        execFile(
            command,
            args,
            {
                encoding: "buffer",
                killSignal: "SIGKILL",
                maxBuffer: MAX_FRAME_BYTES,
                timeout: VIDEO_TOOL_TIMEOUT_MS,
                windowsHide: true,
            },
            (error, stdout) => resolve(error === null ? stdout : undefined),
        );
    });
}
