import type { Model } from "../protocol/index.js";
import { humanizeProviderId } from "./humanizeProviderId.js";
import { humanizeReasoningLevel } from "./humanizeReasoningLevel.js";

export function describeModelChoice(
    model: Model,
    providerId: string,
    isCurrent: boolean,
    options: { unavailable?: boolean } = {},
): string {
    const providerName = humanizeProviderId(providerId);
    return [
        options.unavailable === true
            ? "Unavailable in this session"
            : isCurrent
              ? "Current model"
              : `${providerName} model`,
        `Default reasoning: ${humanizeReasoningLevel(model.defaultThinkingLevel)}`,
    ].join(" • ");
}
