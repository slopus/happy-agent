import { join } from "node:path";

import {
    ExecutorImageGenerationUnavailableError,
    type ExecutorImageGeneration,
} from "@slopus/rig-execution";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import { resolveFileSystemPath } from "../../agent/context/resolveFileSystemPath.js";
import type { Message } from "../../agent/types.js";
import {
    getImageProcessor,
    MAX_PROMPT_IMAGE_INPUT_BYTES,
    prepareImageForPrompt,
} from "../../images/index.js";
import { writeGeneratedMediaFile } from "../gemini/writeGeneratedMediaFile.js";

const MAX_EDIT_IMAGES = 5;
const MAX_EDIT_IMAGES_ENCODED_BYTES = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageGenerationProvider {
    id: string;
    imageGeneration: ExecutorImageGeneration;
}

export interface ImageGenerationRequest {
    prompt: string;
    recentConversationImageCount?: number | null;
    referencedImagePaths?: readonly string[] | null;
}

export interface ImageGenerationExecution {
    messages?: readonly Message[];
    onStatus?: (status: string) => void;
    preferredProviderId?: string;
    requestId?: string;
    signal?: AbortSignal;
}

export interface ImageGenerationResult {
    bytes: number;
    imageBase64: string;
    mediaType: "image/png";
    path: string;
}

/** Host-side image provider routing and output validation for the image-generation feature. */
export class ImageGenerator {
    readonly #providers: readonly ImageGenerationProvider[];
    #roundRobinOffset = 0;

    constructor(providers: readonly ImageGenerationProvider[]) {
        if (providers.length === 0) {
            throw new Error("Image generation requires at least one provider.");
        }
        this.#providers = providers;
    }

    async generate(
        request: ImageGenerationRequest,
        context: AgentContext,
        execution: ImageGenerationExecution = {},
    ): Promise<ImageGenerationResult> {
        const paths = request.referencedImagePaths ?? undefined;
        const recent = request.recentConversationImageCount ?? undefined;
        if (paths !== undefined && recent !== undefined) {
            throw new Error(
                "Provide only one of referencedImagePaths or recentConversationImageCount.",
            );
        }
        if (paths !== undefined && paths.length > MAX_EDIT_IMAGES) {
            throw new Error(`At most ${String(MAX_EDIT_IMAGES)} referenced images are supported.`);
        }
        if (recent !== undefined && (recent < 1 || recent > MAX_EDIT_IMAGES)) {
            throw new Error(
                `recentConversationImageCount must be between 1 and ${String(MAX_EDIT_IMAGES)}.`,
            );
        }
        const images =
            paths === undefined
                ? recentConversationImages(execution.messages ?? [], recent)
                : await prepareReferencedImages(paths, context.fs, context.fs.cwd, context.fs.home);
        assertAggregateImageSize(images);
        const offset = this.#roundRobinOffset++ % this.#providers.length;
        const rotated = [...this.#providers.slice(offset), ...this.#providers.slice(0, offset)];
        const preferred = rotated.find(
            (candidate) => candidate.id === execution.preferredProviderId,
        );
        const ordered =
            preferred === undefined
                ? rotated
                : [preferred, ...rotated.filter((candidate) => candidate !== preferred)];
        const failures: string[] = [];
        const requestId =
            execution.requestId ?? `image-${Date.now()}-${String(this.#roundRobinOffset)}`;
        let successful:
            | {
                  generated: Awaited<ReturnType<ExecutorImageGeneration["generate"]>>;
              }
            | undefined;
        for (const provider of ordered) {
            try {
                execution.onStatus?.(`Generating image with ${provider.id}`);
                const generated = await provider.imageGeneration.generate({
                    ...(images.length === 0 ? {} : { images }),
                    prompt: request.prompt,
                    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
                    turnId: requestId,
                });
                successful = { generated };
                break;
            } catch (error) {
                execution.signal?.throwIfAborted();
                if (!(error instanceof ExecutorImageGenerationUnavailableError)) {
                    throw error;
                }
                failures.push(error instanceof Error ? error.message : String(error));
            }
        }
        if (successful === undefined) {
            throw new Error(`No configured Codex image provider succeeded. ${failures.join(" ")}`);
        }
        const bytes = await decodeAndValidatePng(successful.generated.base64);
        const fileName = requestId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
        const path =
            context.generatedMedia === undefined
                ? await writeGeneratedMediaFile(
                      join(context.fs.cwd, "generated_images", `${fileName}.png`),
                      bytes,
                      context,
                  )
                : (
                      await context.generatedMedia.write(bytes, {
                          extension: "png",
                          preferredName: fileName,
                      })
                  ).path;
        return {
            bytes: bytes.byteLength,
            imageBase64: successful.generated.base64,
            mediaType: successful.generated.mediaType,
            path,
        };
    }
}

async function prepareReferencedImages(
    paths: readonly string[],
    fs: import("../../agent/context/FileSystemContext.js").FileSystemContext,
    cwd: string,
    home: string | undefined,
): Promise<string[]> {
    const references: string[] = [];
    let sourceBytes = 0;
    for (const path of paths) {
        const resolved = resolveFileSystemPath(path, cwd, home);
        const stat = await fs.stat(resolved);
        if (!stat.isFile) throw new Error(`Referenced image '${path}' is not a file.`);
        if (stat.size > MAX_PROMPT_IMAGE_INPUT_BYTES) {
            throw new Error(`Referenced image '${path}' exceeds the supported image size.`);
        }
        sourceBytes += stat.size;
        if (sourceBytes > MAX_PROMPT_IMAGE_INPUT_BYTES) {
            throw new Error("Referenced images exceed the 32 MiB aggregate input limit.");
        }
        references.push(resolved);
    }

    const images: string[] = [];
    let remainingBytes = MAX_PROMPT_IMAGE_INPUT_BYTES;
    for (const reference of references) {
        const bytes = await fs.readFileBuffer(reference, { maxBytes: remainingBytes });
        remainingBytes -= bytes.byteLength;
        const image = await prepareImageForPrompt(bytes, "original");
        images.push(`data:${image.mediaType};base64,${image.bytes.toString("base64")}`);
    }
    return images;
}

function assertAggregateImageSize(images: readonly string[]): void {
    const bytes = images.reduce((total, image) => total + Buffer.byteLength(image), 0);
    if (bytes > MAX_EDIT_IMAGES_ENCODED_BYTES) {
        throw new Error("Referenced images exceed the 48 MiB encoded request limit.");
    }
}

async function decodeAndValidatePng(base64: string): Promise<Buffer> {
    const normalized = base64.trim();
    if (
        normalized.length === 0 ||
        normalized.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
    ) {
        throw new Error("The image provider returned invalid base64 image data.");
    }
    const bytes = Buffer.from(normalized, "base64");
    if (
        bytes.toString("base64") !== normalized ||
        bytes.length < PNG_SIGNATURE.length ||
        !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
        throw new Error("The image provider returned data that is not a PNG image.");
    }
    try {
        const sharp = await getImageProcessor();
        const metadata = await sharp(bytes, {
            failOn: "error",
            limitInputPixels: 40_000_000,
        }).metadata();
        if (metadata.format !== "png") {
            throw new Error("The decoded image format is not PNG.");
        }
        await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).stats();
    } catch (error) {
        throw new Error("The image provider returned a malformed PNG image.", { cause: error });
    }
    return bytes;
}

function recentConversationImages(messages: readonly Message[], requested: number | undefined) {
    if (requested === undefined) return [];
    const images: string[] = [];
    let complete = false;
    const addImage = (mediaType: string, data: string) => {
        images.push(`data:${mediaType};base64,${data}`);
        complete = images.length === requested;
    };
    messageLoop: for (const message of [...messages].reverse()) {
        for (const block of [...message.blocks].reverse()) {
            if (block.type === "image") {
                addImage(block.mediaType, block.data);
            } else if (block.type === "tool_result") {
                for (const content of [...block.rendered].reverse()) {
                    if (content.type === "image") {
                        addImage(content.mediaType, content.data);
                        if (complete) break;
                    }
                }
            }
            if (complete) break messageLoop;
        }
    }
    if (complete) return images.reverse();
    throw new Error(
        `Requested the last ${String(requested)} conversation images, but only ${String(images.length)} were available.`,
    );
}
