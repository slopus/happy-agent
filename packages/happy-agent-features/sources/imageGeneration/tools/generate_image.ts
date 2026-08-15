import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    imageGenerationStatusSchema,
    imageGenerationToolInputSchema,
    type ImageGenerationToolInput,
} from "../ImageGeneration.js";
import type { ImageGenerationFeature } from "../ImageGenerationFeature.js";

/** The common provider-neutral image generation tool. */
export function generateImageTool(feature: ImageGenerationFeature, agentId: string) {
    return defineAgentTool({
        name: "generate_image",
        description:
            "Generate an image from a prompt. The result includes a durable opaque operation ID, asset ID, and host-owned serving locator; never infer or construct a filesystem path.",
        parameters: imageGenerationToolInputSchema,
        returnType: imageGenerationStatusSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ImageGenerationToolInput) =>
            await feature.generate(ctx, agentId, input),
        toLLM: (status) => [
            {
                type: "text",
                text: feature.formatForModel(status),
            },
        ],
    });
}
