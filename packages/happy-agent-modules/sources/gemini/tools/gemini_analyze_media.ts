import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { Compute, ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { GeminiConnection } from "../Gemini.js";
import { analyzeGeminiMedia } from "../impl/analyzeGeminiMedia.js";
import { resolveGeminiMediaInput } from "../impl/resolveGeminiMediaInput.js";

/** Gemini takes the file inline in the request, so the whole file has to fit in one call. */
const MAX_INLINE_MEDIA_BYTES = 15 * 1024 * 1024;

const analyzedMediaSchema = Type.Object({
    analysis: Type.String(),
    mime_type: Type.String(),
    path: Type.String(),
});

/** Ask Gemini about a file already on the agent's machine. */
export function geminiAnalyzeMediaTool(
    connection: GeminiConnection,
    computeModule: ComputeModule,
    compute: Compute,
) {
    return defineAgentTool({
        name: "gemini_analyze_media",
        defer: true,
        capabilities: ["Generate and analyze images, audio, music, and other media with Gemini."],
        searchKeywords: ["analyze media file", "inspect audio or video", "understand image"],
        description:
            "Analyze a local image, audio, video, or PDF file up to 15 MiB with Gemini 3.5 Flash. Use it to describe, transcribe, summarize, extract details, or answer questions about media.",
        parameters: Type.Object({
            path: Type.String({ description: "Local path to an image, audio, video, or PDF file" }),
            prompt: Type.String({
                minLength: 2,
                description: "Specific analysis, transcription, extraction, or question to perform",
            }),
        }),
        returnType: analyzedMediaSchema,
        // The file leaves the machine, so an interrupted call is reported rather than sent again.
        durable: false,
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: ({ path, prompt }) =>
            `uploading ${quoteVisibleExact(path)} to Gemini for ${quoteVisibleExact(prompt)}. Access: local filesystem read and external Gemini API`,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            computeModule.shouldReviewPath(ctx, compute, path, { write: false }),
        execute: async (ctx, { path, prompt }) => {
            const permissions = computeModule.permissionsForContext(ctx);
            const resolvedPath = computeModule.resolvePath(compute, path);
            const stat = await compute.fs.stat(permissions, resolvedPath);
            if (!stat.isFile) throw new Error(`Gemini media path '${path}' is not a file.`);
            if (stat.size > MAX_INLINE_MEDIA_BYTES) {
                throw new Error("Gemini media analysis supports files up to 15 MiB.");
            }
            const media = resolveGeminiMediaInput(computeModule, resolvedPath);
            const bytes = await compute.fs.readFileBuffer(permissions, resolvedPath, {
                maxBytes: MAX_INLINE_MEDIA_BYTES,
            });
            if (bytes.byteLength > MAX_INLINE_MEDIA_BYTES) {
                throw new Error("Gemini media analysis supports files up to 15 MiB.");
            }
            const analysis = await analyzeGeminiMedia({
                apiKey: connection.apiKey,
                bytes,
                ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
                mimeType: media.mimeType,
                prompt,
                ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
                type: media.type,
            });
            return { analysis, mime_type: media.mimeType, path: resolvedPath };
        },
        toLLM: (result) => [{ type: "text", text: result.analysis }],
    });
}
