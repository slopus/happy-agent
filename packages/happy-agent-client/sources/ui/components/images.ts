import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { uiDetailSchema } from "../uiValues.js";

/** The most images one `images` component shows. */
export const MAX_UI_IMAGES = 12;

/**
 * Images already on the agent's machine, shown in the order given. The model writes paths; the
 * daemon snapshots each file into the `show_ui` presentation's `items` and stores its index.
 * Only `show_ui` can show images, because only its presentation carries media.
 */
export const imagesComponent = defineUiComponent({
    type: "images",
    description: "Images shown in a grid of one to three columns.",
    props: Type.Object(
        {
            images: Type.Array(
                Type.Object(
                    {
                        /** The item's index in the presentation's `items`. */
                        mediaIndex: Type.Integer({ minimum: 0, maximum: MAX_UI_IMAGES - 1 }),
                        alt: Type.Optional(uiDetailSchema),
                        caption: Type.Optional(uiDetailSchema),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: MAX_UI_IMAGES },
            ),
            columns: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])),
        },
        { additionalProperties: false },
    ),
    input: Type.Object(
        {
            images: Type.Array(
                Type.Object(
                    {
                        /** An image file on the agent's machine, absolute or workspace-relative. */
                        path: Type.String({ minLength: 1, maxLength: 4_096 }),
                        alt: Type.Optional(uiDetailSchema),
                        caption: Type.Optional(uiDetailSchema),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: MAX_UI_IMAGES },
            ),
            columns: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])),
        },
        { additionalProperties: false },
    ),
    actions: {},
});
