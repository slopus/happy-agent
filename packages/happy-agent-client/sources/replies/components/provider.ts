import { Type } from "@sinclair/typebox";

import { uiProviderSchema } from "../../ui/uiValues.js";
import { defineReplyComponent } from "../defineReplyComponent.js";

/**
 * An AI's mark before the option's text and a quiet note at its trailing end, read from the live
 * provider CLI state, never from the model: "Not installed", "Not signed in", "1 account", or
 * "N accounts".
 */
export const providerReply = defineReplyComponent(
    "provider",
    Type.Object({ provider: uiProviderSchema }, { additionalProperties: false }),
);
