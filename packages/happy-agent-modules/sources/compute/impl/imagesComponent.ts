import { imagesComponent } from "@slopus/happy-agent-client";

import type { ChatMediaModule } from "../../chatMedia/index.js";
import type { ChatUiModule } from "../../chatUi/index.js";
import type { ComputeModule } from "../ComputeModule.js";
import { presentComputeFiles, shouldReviewPaths } from "../tools/present_files.js";

/**
 * Serve `images`: image files on the agent's machine, snapshotted into the `show_ui` call's media
 * under the call's own file-read boundary, as `present_files` reads them. Compute contributes it
 * because only compute can read the agent's machine; chat media keeps the bytes.
 */
export function contributeImagesComponent(
    chatUi: ChatUiModule,
    compute: ComputeModule,
    chatMedia: ChatMediaModule,
): void {
    chatUi.contribute(imagesComponent, {
        prompt: "Image files from your machine in a grid of one to three columns, each with an optional caption. Use it instead of HTML to lay images out.",
        fallback: (props) =>
            props.images
                .map((image, index) => image.caption ?? image.alt ?? `Image ${String(index + 1)}`)
                .join(" · "),
        prepare: async (ctx, agentId, input) => {
            const machine = await compute.resolve(ctx, agentId);
            if (machine === undefined)
                return { problems: ["There is no machine to read images from."] };
            let items;
            try {
                items = await presentComputeFiles(
                    ctx,
                    machine,
                    chatMedia,
                    input.images.map((image) => image.path),
                );
            } catch (error: unknown) {
                return { problems: [error instanceof Error ? error.message : String(error)] };
            }
            const notImages = items
                .filter((item) => item.kind !== "image")
                .map((item) => item.name);
            if (notImages.length > 0) {
                return {
                    problems: [
                        `Not an image: ${notImages.join(", ")}. Use present_files for other files.`,
                    ],
                };
            }
            return {
                props: {
                    images: input.images.map((image, mediaIndex) => ({
                        mediaIndex,
                        ...(image.alt === undefined ? {} : { alt: image.alt }),
                        ...(image.caption === undefined ? {} : { caption: image.caption }),
                    })),
                    ...(input.columns === undefined ? {} : { columns: input.columns }),
                },
                items,
            };
        },
        shouldReview: async (ctx, agentId, input) => {
            const machine = await compute.resolve(ctx, agentId);
            return (
                machine !== undefined &&
                (await shouldReviewPaths(
                    ctx,
                    machine,
                    input.images.map((image) => image.path),
                ))
            );
        },
        actions: {},
    });
}
