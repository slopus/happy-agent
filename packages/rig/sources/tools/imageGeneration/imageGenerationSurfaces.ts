import type { ImageGenerationSurface } from "./createImageGenerationTool.js";

/** The image tool as every non-Codex model family sees it. */
export const imageGenerationSurface: ImageGenerationSurface = {
    name: "imagegen",
    description:
        "Generate a new image or edit up to five referenced images. Omit both image reference fields for a new image. For edits, provide local image paths or request the smallest sufficient number of recent conversation images, but never both.",
};

/**
 * The image tool as Codex models see it. Codex models are trained against a built-in image tool
 * that Rig cannot redefine, because the Responses API reserves both that tool and its `image_gen`
 * namespace. This surface keeps the guidance those models already know under a name of Rig's own,
 * so the request stays valid while the model still recognizes the capability.
 */
export const codexImageGenerationSurface: ImageGenerationSurface = {
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
};
