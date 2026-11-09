import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { uiDetailSchema, uiLabelSchema, uiSlugSchema } from "../uiValues.js";

/** Options to tick and one submit, sent as the person's message. */
export const checklistComponent = defineUiComponent({
    type: "checklist",
    description:
        "Options to tick, then one submit that sends the ticked labels as the person's message.",
    props: Type.Object(
        {
            options: Type.Array(
                Type.Object(
                    {
                        id: uiSlugSchema,
                        label: uiLabelSchema,
                        detail: Type.Optional(uiDetailSchema),
                        /** Ticked when the component is first drawn. */
                        checked: Type.Optional(Type.Boolean()),
                    },
                    { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 32 },
            ),
            submitLabel: uiLabelSchema,
            /** The submit's label while nothing is ticked, such as "Continue without these". */
            emptyLabel: Type.Optional(uiLabelSchema),
        },
        { additionalProperties: false },
    ),
    actions: {
        submit: {
            payload: Type.Object(
                { selected: Type.Array(uiSlugSchema, { maxItems: 32, uniqueItems: true }) },
                { additionalProperties: false },
            ),
            transcript: "message",
            once: true,
        },
    },
});
