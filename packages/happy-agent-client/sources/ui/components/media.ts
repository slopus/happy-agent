import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { uiLabelSchema } from "../uiValues.js";

/** The most items one `media` component shows, and one `show_ui` presentation carries. */
export const MAX_UI_MEDIA = 24;

/**
 * Pictures, videos, and other files already on the agent's machine, in the order given. The model
 * writes paths; the daemon snapshots each file into the `show_ui` presentation's `items` and
 * stores its index. Clients lay the items out from their known sizes with `layoutMedia`, never
 * from loaded bytes. Only `show_ui` can show media, because only its presentation carries it.
 */
export const mediaComponent = defineUiComponent({
    type: "media",
    description:
        "Pictures, videos, and files laid out in justified rows, each with an optional label.",
    props: Type.Object(
        {
            items: Type.Array(
                Type.Object(
                    {
                        /** The item's index in the presentation's `items`. */
                        mediaIndex: Type.Integer({ minimum: 0, maximum: MAX_UI_MEDIA - 1 }),
                        /** One line under the item. */
                        label: Type.Optional(uiLabelSchema),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: MAX_UI_MEDIA },
            ),
        },
        { additionalProperties: false },
    ),
    input: Type.Object(
        {
            items: Type.Array(
                Type.Object(
                    {
                        /** A file on the agent's machine, absolute or workspace-relative. */
                        path: Type.String({ minLength: 1, maxLength: 4_096 }),
                        /** One line under the item. */
                        label: Type.Optional(uiLabelSchema),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: MAX_UI_MEDIA },
            ),
        },
        { additionalProperties: false },
    ),
    actions: {},
});

/**
 * A `media` component's fallback line: "N images" when every item is a picture, otherwise
 * "N files", followed by the labels, joined by a spaced middle dot.
 */
export function mediaFallback(
    items: readonly { readonly kind: string; readonly label?: string }[],
): string {
    const pictures = items.every((item) => item.kind === "image");
    const noun = pictures ? "image" : "file";
    const count = `${String(items.length)} ${noun}${items.length === 1 ? "" : "s"}`;
    const labels = items.flatMap((item) => (item.label === undefined ? [] : [item.label]));
    return labels.length === 0 ? count : `${count}: ${labels.join(" · ")}`;
}
