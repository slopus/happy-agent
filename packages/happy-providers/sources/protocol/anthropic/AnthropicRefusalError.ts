import type { SessionUsage } from "@/core/SessionUsage.js";

/**
 * The stream ended with `stop_reason: "refusal"`: Anthropic's classifiers halted generation.
 *
 * The API delivers this as a graceful completion, not an error, and documents retrying it as
 * legitimate handling — the classifiers run over sampled output, so a borderline response can
 * refuse on one attempt and complete on the next. The session replays it through the same
 * rollback as other mid-stream failures, under its own small budget, and this error keeps the
 * refusal's `stop_details` so an exhausted retry still tells the user which policy category
 * fired and why.
 */
export class AnthropicRefusalError extends Error {
    readonly errorType = "refusal";
    readonly code: string | undefined;
    readonly category: string | undefined;
    readonly explanation: string | undefined;
    readonly usage: SessionUsage | undefined;

    constructor(
        details: { category?: string | null; explanation?: string | null } | null | undefined,
        usage?: SessionUsage,
    ) {
        const category = details?.category ?? undefined;
        const explanation = details?.explanation ?? undefined;
        super(refusalMessage(category, explanation));
        this.name = "AnthropicRefusalError";
        this.code = category;
        this.category = category;
        this.explanation = explanation;
        this.usage = usage;
    }
}

export function isAnthropicRefusalError(error: unknown): error is AnthropicRefusalError {
    return error instanceof AnthropicRefusalError;
}

function refusalMessage(category: string | undefined, explanation: string | undefined): string {
    const refused =
        category === undefined
            ? "The model refused to complete the request"
            : `The model refused to complete the request (category: ${category})`;
    return explanation === undefined ? `${refused}.` : `${refused}: ${explanation}`;
}
