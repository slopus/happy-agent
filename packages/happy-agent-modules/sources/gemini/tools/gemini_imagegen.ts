import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { ConfigModule } from "../../config/index.js";
import { decodeAndValidatePng } from "../../impl/images/decodeAndValidatePng.js";
import { writeGeneratedImageFile } from "../../impl/images/writeGeneratedImageFile.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { GeminiConnection } from "../Gemini.js";
import { generateGeminiImage } from "../impl/generateGeminiImage.js";

const generatedImageSchema = Type.Object({
    bytes: Type.Number(),
    description: Type.Optional(Type.String()),
    image_base64: Type.String(),
    media_type: Type.Literal("image/png"),
    path: Type.String(),
});

/**
 * Gemini's image generation, published the way every generated image is.
 *
 * The tool follows the same approach as `codex_imagegen`: it needs only the credential behind it,
 * proves the answer is a real PNG, publishes it into the shared generated-files folder named after
 * the tool call, and hands the model both the path and the image itself. The arguments stay
 * Gemini's own — aspect ratio and resolution — because the two vendor tools are separate
 * definitions, not one shared surface.
 */
export function geminiGenerateImageTool(connection: GeminiConnection, config: ConfigModule) {
    return defineAgentTool({
        name: "gemini_imagegen",
        defer: true,
        capabilities: ["Generate new images and edit existing images."],
        searchKeywords: ["Gemini image generation", "create picture", "generate visual"],
        description: `Generate a new PNG image with Gemini 3.1 Flash Image from a detailed visual prompt.

Guidelines:
- Use a detailed visual prompt; \`aspect_ratio\` and \`image_size\` are optional.
- This tool generates brand new images only; it cannot edit an existing image.
- The finished image is saved in the shared generated-files folder named in your environment instructions and returned to you.`,
        parameters: Type.Object({
            prompt: Type.String({ minLength: 2, description: "Detailed image generation prompt" }),
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
        describeAutoPermissionAction: ({ prompt }) =>
            `sending ${quoteVisibleExact(prompt)} to Gemini image generation. Access: external Gemini API and local filesystem write`,
        shouldReviewInAutoMode: () => true,
        execute: async (ctx, { prompt, aspect_ratio, image_size }, call) => {
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
            const base64 = Buffer.from(generated.bytes).toString("base64");
            const bytes = await decodeAndValidatePng(base64);
            const fileName = `${call.id.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}.png`;
            const path = await writeGeneratedImageFile(
                config.configuration.paths.generatedPath,
                fileName,
                bytes,
            );
            return {
                bytes: bytes.byteLength,
                ...(generated.text === undefined ? {} : { description: generated.text }),
                image_base64: base64,
                media_type: "image/png" as const,
                path,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Generated image at ${result.path} (${String(result.bytes)} bytes).${result.description === undefined ? "" : `\n\n${result.description}`}`,
            },
            { type: "image", mimeType: result.media_type, data: result.image_base64 },
        ],
    });
}
