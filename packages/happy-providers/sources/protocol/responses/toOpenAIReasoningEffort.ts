import type { ReasoningEffort } from "openai/resources/shared.js";

import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";

export function toOpenAIReasoningEffort(effort: SessionReasoningEffort): ReasoningEffort {
    if (effort === "ultra") {
        throw new Error("The Responses protocol does not support Ultra reasoning effort.");
    }
    if (effort === "off") {
        return "none";
    }
    return effort;
}
