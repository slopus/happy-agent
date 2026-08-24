import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { Compute, ComputeModule } from "../../compute/index.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { GeminiConnection } from "../Gemini.js";
import { computePathExtension } from "../impl/computePathExtension.js";
import { generateGeminiImage } from "../impl/generateGeminiImage.js";
import { prepareGeneratedMediaOutputPath } from "../impl/prepareGeneratedMediaOutputPath.js";
import { writeGeneratedMediaFile } from "../impl/writeGeneratedMediaFile.js";

const generatedImageSchema = Type.Object({
    bytes: Type.Number(),
    description: Type.Optional(Type.String()),
    mime_type: Type.String(),
    path: Type.String(),
});

/** Gemini's image generation, written straight to a file on the agent's machine. */
export function geminiGenerateImageTool(
    connection: GeminiConnection,
    computeModule: ComputeModule,
    compute: Compute,
    reads: FileReadLog,
) {
    return defineAgentTool({
        name: "gemini_imagegen",
        defer: true,
        capabilities: ["Generate and analyze images, audio, music, and other media with Gemini."],
        searchKeywords: ["Gemini image generation", "create picture", "generate visual"],
        description:
            "Generate a new PNG image with Gemini 3.1 Flash Image and save it to the local filesystem. Use a detailed visual prompt and an output path ending in .png.",
        parameters: Type.Object({
            prompt: Type.String({ minLength: 2, description: "Detailed image generation prompt" }),
            output_path: Type.String({ description: "Local output path ending in .png" }),
            aspect_ratio: Type.Optional(
                Type.Union(
                    [
                        Type.Literal("1:1"),
                        Type.Literal("2:3"),
                        Type.Literal("3:2"),
                        Type.Literal("3:4"),
                        Type.Literal("4:3"),
                        Type.Literal("4:5"),
                        Type.Literal("5:4"),
                        Type.Literal("9:16"),
                        Type.Literal("16:9"),
                        Type.Literal("1:4"),
                        Type.Literal("4:1"),
                        Type.Literal("1:8"),
                        Type.Literal("8:1"),
                    ],
                    { description: "Optional generated image aspect ratio" },
                ),
            ),
            image_size: Type.Optional(
                Type.Union(
                    [
                        Type.Literal("0.5K"),
                        Type.Literal("1K"),
                        Type.Literal("2K"),
                        Type.Literal("4K"),
                    ],
                    { description: "Optional generated image resolution; defaults to 1K" },
                ),
            ),
        }),
        returnType: generatedImageSchema,
        // Generating an image is billed work that leaves a file behind, so an interrupted call is
        // reported rather than run a second time.
        durable: false,
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: ({ prompt, output_path }) =>
            `sending ${quoteVisibleExact(prompt)} to Gemini image generation and writing ${quoteVisibleExact(output_path)}. Access: external Gemini API and local filesystem write`,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: ({ output_path }, ctx) =>
            computeModule.shouldReviewPath(ctx, compute, output_path, { write: true }),
        execute: async (ctx, { prompt, output_path, aspect_ratio, image_size }) => {
            if (computePathExtension(computeModule, output_path) !== ".png") {
                throw new Error("Gemini image output_path must end in .png.");
            }
            const resolvedOutputPath = await prepareGeneratedMediaOutputPath(
                computeModule,
                compute,
                reads,
                ctx,
                output_path,
            );
            const generated = await generateGeminiImage({
                apiKey: connection.apiKey,
                ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
                ...(aspect_ratio === undefined ? {} : { aspectRatio: aspect_ratio }),
                ...(image_size === undefined ? {} : { imageSize: image_size }),
                prompt,
                ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
            });
            if (generated.mimeType !== "image/png") {
                throw new Error(`Gemini returned unsupported image type '${generated.mimeType}'.`);
            }
            const path = await writeGeneratedMediaFile(
                computeModule,
                compute,
                reads,
                ctx,
                resolvedOutputPath,
                generated.bytes,
            );
            return {
                bytes: generated.bytes.byteLength,
                ...(generated.text === undefined ? {} : { description: generated.text }),
                mime_type: generated.mimeType,
                path,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Generated image at ${result.path} (${String(result.bytes)} bytes).${result.description === undefined ? "" : `\n\n${result.description}`}`,
            },
        ],
    });
}
