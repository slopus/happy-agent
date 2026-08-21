import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    imageGenerationArgumentsSchema,
    imageGenerationResultSchema,
    selectedPaths,
} from "../ImageGeneration.js";
import type { ImageGenerationModule } from "../ImageGenerationModule.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import { selectedRecentCount } from "../ImageGeneration.js";

/**
 * The one image tool, given to every model.
 *
 * The name is Codex's because the capability is: images are generated on Codex accounts, and Codex
 * models are trained against a built-in image tool Happy Agent cannot redefine — the Responses API reserves
 * both that tool and its `image_gen` namespace and rejects the whole request when a definition
 * under either differs from the built-in one. Prefixing the name keeps the request valid while the
 * model still recognizes the capability, and every other family reads the same guidance rather than
 * a second surface that would have to be kept in step with this one.
 */
export function codexImageGenerationTool(
    module: ImageGenerationModule,
    agentId: string,
    preferredProviderId: string,
) {
    return defineAgentTool({
        name: "codex_imagegen",
        description: `The \`codex_imagegen\` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:

- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.
- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).

Guidelines:
- Image generation takes a few minutes to finish.
- Omit both \`referenced_image_paths\` and \`num_last_images_to_include\` when generating a brand new image.
- For edits, use \`referenced_image_paths\` when every target image has a local file path.
- Use \`num_last_images_to_include\` only when at least one target image has no local file path.
- Set \`num_last_images_to_include\` to the smallest number of recent conversation images that includes every target image, up to 5.
- Never provide both \`referenced_image_paths\` and \`num_last_images_to_include\`.
- If neither mechanism can include every target image, ask the user to attach the missing images again.
- Directly generate the image without reconfirmation or clarification unless required images must be attached again.
- Always use this tool for image editing unless the user explicitly requests otherwise.
- The finished image is saved in the shared generated-files folder named in your environment instructions and returned to you.`,
        parameters: imageGenerationArgumentsSchema,
        returnType: imageGenerationResultSchema,
        // Generating an image is billed work that cannot be safely repeated, so an interrupted
        // call becomes an error rather than a second image nobody asked for.
        durable: false,
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: (args) => describeImageGenerationAction(module, args),
        shouldReviewInAutoMode: () => true,
        // A referenced path is read straight off this machine, so an approved call has to carry
        // the access that read needs. A prompt on its own reaches nothing local.
        shouldRunInFullAccessInAutoMode: (args) => selectedPaths(args) !== undefined,
        execute: async (ctx, args, call) =>
            await module.generate(ctx, agentId, args, {
                turnId: call.id,
                preferredProviderId,
            }),
        toLLM: (result) => [
            {
                type: "text",
                text: `Generated image at ${result.path} (${String(result.bytes)} bytes).`,
            },
            { type: "image", mimeType: result.media_type, data: result.image_base64 },
        ],
    });
}

/**
 * The exact action a reviewer is deciding on: the prompt as written, what it is built from, and
 * which accounts it may reach. The prompt is model-supplied text, so it is quoted rather than
 * allowed to read as part of the sentence around it.
 */
function describeImageGenerationAction(
    module: ImageGenerationModule,
    args: Parameters<typeof selectedPaths>[0],
): string {
    const paths = selectedPaths(args);
    const recent = selectedRecentCount(args);
    return `sending ${quoteVisibleExact(args.prompt)}${
        paths === undefined ? "" : ` and ${String(paths.length)} local image reference(s)`
    }${
        recent === undefined ? "" : ` and ${String(recent)} recent conversation image(s)`
    } to Codex image generation. If an account definitively refuses the request, Happy Agent may send the same data to another of ${String(module.accountCount)} configured Codex cloud account(s), including accounts with custom endpoints. Access: conversation data, local filesystem read/write, and external Codex APIs`;
}
