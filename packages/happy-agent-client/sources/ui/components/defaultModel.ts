import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";

/** The default model for new conversations, drawn live from the server's configuration. */
export const defaultModelComponent = defineUiComponent({
    type: "default_model",
    description: "The default model for new conversations, live, with a control that changes it.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {
        set: {
            payload: Type.Object(
                {
                    providerId: Type.String({ minLength: 1, maxLength: 128 }),
                    modelId: Type.String({ minLength: 1, maxLength: 512 }),
                    effort: Type.String({ minLength: 1, maxLength: 64 }),
                },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "config.manage",
        },
    },
});
