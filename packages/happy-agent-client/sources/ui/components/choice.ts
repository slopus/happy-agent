import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { uiLabelSchema, uiSlugSchema } from "../uiValues.js";

/** Up to six buttons. A press sends the option's label as the person's message. */
export const choiceComponent = defineUiComponent({
    type: "choice",
    description: "Up to six buttons; a press sends the option's label as the person's message.",
    props: Type.Object(
        {
            options: Type.Array(
                Type.Object(
                    {
                        id: uiSlugSchema,
                        label: uiLabelSchema,
                        /** The one recommended option; at most one option is primary. */
                        primary: Type.Optional(Type.Boolean()),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 6 },
            ),
        },
        { additionalProperties: false },
    ),
    actions: {
        choose: {
            payload: Type.Object({ optionId: uiSlugSchema }, { additionalProperties: false }),
            transcript: "message",
            once: true,
        },
    },
});
