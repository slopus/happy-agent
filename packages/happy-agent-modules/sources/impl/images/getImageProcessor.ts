import type { ImageProcessor } from "./ImageProcessor.js";
import { createBunImageProcessor } from "./createBunImageProcessor.js";
import { createNodeImageProcessor } from "./createNodeImageProcessor.js";

let imageProcessor: ImageProcessor | undefined;

export async function getImageProcessor(): Promise<ImageProcessor> {
    imageProcessor ??=
        "bun" in process.versions ? createBunImageProcessor() : createNodeImageProcessor();
    return imageProcessor;
}
