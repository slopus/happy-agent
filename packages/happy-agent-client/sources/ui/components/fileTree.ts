import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";

/** Places drawn as a file tree, from slash-separated paths. Nothing in it is pressable. */
export const fileTreeComponent = defineUiComponent({
    type: "file_tree",
    description: "Slash-separated paths drawn as a file tree.",
    props: Type.Object(
        {
            paths: Type.Array(
                Type.String({
                    minLength: 1,
                    maxLength: 1_024,
                    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]*$",
                }),
                { minItems: 1, maxItems: 200 },
            ),
        },
        { additionalProperties: false },
    ),
    actions: {},
});
