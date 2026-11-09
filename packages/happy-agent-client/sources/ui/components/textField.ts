import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { uiLabelSchema, uiTypedTextSchema } from "../uiValues.js";

/** One field; what the person types is sent as their message. */
export const textFieldComponent = defineUiComponent({
    type: "text_field",
    description: "One text field whose submitted text is sent as the person's message.",
    props: Type.Object(
        {
            label: uiLabelSchema,
            placeholder: Type.Optional(uiLabelSchema),
            submitLabel: uiLabelSchema,
        },
        { additionalProperties: false },
    ),
    actions: {
        submit: {
            payload: Type.Object({ text: uiTypedTextSchema }, { additionalProperties: false }),
            transcript: "message",
            once: true,
        },
    },
});
