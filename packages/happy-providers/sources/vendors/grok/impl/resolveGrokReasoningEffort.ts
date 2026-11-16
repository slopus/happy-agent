import type { ReasoningEffort } from "openai/resources/shared.js";

import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import { toOpenAIReasoningEffort } from "@/protocol/responses/toOpenAIReasoningEffort.js";

export function resolveGrokReasoningEffort(
    apiModelId: string,
    effort: SessionReasoningEffort | undefined,
): ReasoningEffort | undefined {
    const resolved = effort === undefined ? undefined : toOpenAIReasoningEffort(effort);
    if (apiModelId === "grok-build" || apiModelId === "grok-composer-2.5-fast") {
        return undefined;
    }
    return resolved;
}
