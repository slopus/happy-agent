import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { createNodeAgentContext } from "../../agent/context/createNodeAgentContext.js";
import { createGeneratedMediaStore } from "../../generated-media/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import { validPng32Base64 } from "../../testing/validImageFixtures.js";
import {
    parseUrlMetadata,
    prepareAttachment,
    resolveAttachmentSource,
} from "./prepareAttachment.js";
import { runBundledMediaCommand } from "./runBundledMediaCommand.js";

describe("prepareAttachment", () => {
    it("prepares image dimensions and a ThumbHash", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/result.png": Buffer.from(validPng32Base64, "base64") },
        });
        const source = await resolveAttachmentSource(
            { path: "/workspace/result.png" },
            harness.context,
        );

        const attachment = await prepareAttachment(source, "image-1", harness.context);

        expect(attachment).toMatchObject({
            height: 32,
            id: "image-1",
            kind: "image",
            mediaType: "image/png",
            width: 32,
        });
        if (attachment.kind !== "image") throw new Error("Expected an image attachment.");
        expect(Buffer.from(attachment.thumbhash, "base64").byteLength).toBeGreaterThan(0);
    });

    it("extracts bounded Open Graph metadata and resolves its image URL", () => {
        expect(
            parseUrlMetadata(
                `<html><head>
                    <meta property="og:title" content="Release notes">
                    <meta property="og:description" content="What changed">
                    <meta property="og:site_name" content="Rig">
                    <meta property="og:image" content="/preview.png">
                </head></html>`,
                "https://example.test/releases/1",
            ),
        ).toEqual({
            description: "What changed",
            image: "https://example.test/preview.png",
            siteName: "Rig",
            title: "Release notes",
        });
    });

    it("probes video metadata and persists its first-frame preview", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/result.mp4": Buffer.from("video") },
        });
        harness.context.generatedMedia = {
            hostDirectory: "/host/generated",
            modelDirectory: "/happy/generated",
            remove: async () => undefined,
            write: async () => ({
                hostPath: "/host/generated/preview.png",
                location: "generated/preview.png",
                path: "/happy/generated/preview.png",
            }),
        };
        const source = await resolveAttachmentSource(
            { path: "/workspace/result.mp4" },
            harness.context,
        );
        if (source.kind !== "file") throw new Error("Expected a file source.");
        source.hostPath = "/host/generated/result.mp4";

        const attachment = await prepareAttachment(source, "video-1", harness.context, {
            runMediaCommand: async (options) => {
                if (options.executable === "ffprobe") {
                    expect(options.arguments.at(-1)).toBe("/host/generated/result.mp4");
                    return {
                        exitCode: 0,
                        stderr: "",
                        stdout: JSON.stringify({
                            format: { duration: "2.5" },
                            streams: [{ height: 720, width: 1280 }],
                        }),
                        timedOut: false,
                    };
                }
                const previewPath = options.arguments.at(-1);
                if (previewPath === undefined) throw new Error("Missing preview output path.");
                await writeFile(previewPath, Buffer.from(validPng32Base64, "base64"));
                return { exitCode: 0, stderr: "", stdout: "", timedOut: false };
            },
        });

        expect(attachment).toMatchObject({
            duration: 2.5,
            height: 720,
            kind: "video",
            preview: {
                height: 32,
                path: "generated/preview.png",
                width: 32,
            },
            width: 1280,
        });
    });

    it("probes audio duration", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/result.mp3": Buffer.from("audio") },
        });
        const source = await resolveAttachmentSource(
            { path: "/workspace/result.mp3" },
            harness.context,
        );

        const attachment = await prepareAttachment(source, "audio-1", harness.context, {
            runMediaCommand: async () => ({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({ format: { duration: "3.25" } }),
                timedOut: false,
            }),
        });

        expect(attachment).toMatchObject({
            duration: 3.25,
            kind: "audio",
            mediaType: "audio/mpeg",
        });
    });

    it("retains environment-local audio probing when no host snapshot exists", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/result.mp3": Buffer.from("audio") },
        });
        const run = vi.spyOn(harness.context.bash, "run").mockResolvedValue({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ format: { duration: "4.5" } }),
            timedOut: false,
        });
        const source = await resolveAttachmentSource(
            { path: "/workspace/result.mp3" },
            harness.context,
        );

        await expect(
            prepareAttachment(source, "audio-local", harness.context),
        ).resolves.toMatchObject({
            duration: 4.5,
            kind: "audio",
        });
        expect(run).toHaveBeenCalledWith(
            expect.objectContaining({
                command:
                    "ffprobe -v error -show_entries format=duration -of json -- '/workspace/result.mp3'",
            }),
        );
    });

    it("extracts a real preview without system FFmpeg on PATH", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-bundled-media-"));
        const videoPath = join(root, "result.mp4");
        const generated = join(root, "generated");
        try {
            const created = await runBundledMediaCommand({
                arguments: [
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=red:s=16x16:d=0.2",
                    "-pix_fmt",
                    "yuv420p",
                    videoPath,
                ],
                executable: "ffmpeg",
                timeoutMs: 5_000,
            });
            expect(created.exitCode).toBe(0);
            const context = createNodeAgentContext(createTestRootContext().named("agent"), {
                cwd: root,
                processManager: new NativeProcessManager(),
            });
            context.generatedMedia = createGeneratedMediaStore({
                hostDirectory: generated,
            });
            const source = await resolveAttachmentSource({ path: videoPath }, context);

            const attachment = await prepareAttachment(source, "video-real", context);

            expect(attachment).toMatchObject({
                duration: expect.any(Number),
                height: 16,
                kind: "video",
                preview: {
                    height: 16,
                    path: expect.stringMatching(/^generated\/video-preview-/u),
                    width: 16,
                },
                width: 16,
            });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
