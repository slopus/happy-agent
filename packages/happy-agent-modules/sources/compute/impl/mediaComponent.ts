import { mediaComponent, mediaFallback } from "@slopus/happy-agent-client";

import type { ChatMediaModule } from "../../chatMedia/index.js";
import type { ChatUiModule } from "../../chatUi/index.js";
import type { ComputeModule } from "../ComputeModule.js";
import { presentComputeFiles, shouldReviewPaths } from "../tools/present_files.js";

/**
 * Serve `media`: pictures, videos, and other files on the agent's machine, snapshotted into the
 * `show_ui` call's media under the call's own file-read boundary, as `present_files` reads them.
 * Compute contributes it because only compute can read the agent's machine; chat media keeps the
 * bytes.
 */
export function contributeMediaComponent(
    chatUi: ChatUiModule,
    compute: ComputeModule,
    chatMedia: ChatMediaModule,
): void {
    chatUi.contribute(mediaComponent, {
        prompt: "Pictures, videos, or other files from your machine, laid out by the client in justified rows from their real sizes, each with an optional one-line label. Use it to show several files together.",
        fallback: (props, items) =>
            mediaFallback(
                props.items.map((item, index) => ({
                    kind: items[index]?.kind ?? "file",
                    ...(item.label === undefined ? {} : { label: item.label }),
                })),
            ),
        prepare: async (ctx, agentId, input, firstItemIndex) => {
            const machine = await compute.resolve(ctx, agentId);
            if (machine === undefined) {
                return { problems: ["There is no machine to read files from."] };
            }
            let items;
            try {
                items = await presentComputeFiles(
                    ctx,
                    machine,
                    chatMedia,
                    input.items.map((item) => item.path),
                );
            } catch (error: unknown) {
                return { problems: [error instanceof Error ? error.message : String(error)] };
            }
            return {
                props: {
                    // Each item is named by where it lands in the document's one media list.
                    items: input.items.map((item, index) => ({
                        mediaIndex: firstItemIndex + index,
                        ...(item.label === undefined ? {} : { label: item.label }),
                    })),
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
                    input.items.map((item) => item.path),
                ))
            );
        },
        reviewAccess:
            "media components read local files (outside-workspace or symlink targets require full access) and copy them into this installation's private chat media",
        actions: {},
    });
}
