import type { SessionTokenCount, Usage } from "../../protocol/index.js";

type SessionTokenCountUpdate =
    | { type: "compaction"; contextTokens: number }
    | { type: "invalidate_context" }
    | { type: "reset" }
    | { type: "usage"; contextTokens: number; usage: Usage };

const ZERO_SESSION_TOKEN_COUNT: SessionTokenCount = {
    lastContextTokens: 0,
    totalTokens: 0,
};

export function updateSessionTokenCount(
    current: SessionTokenCount | undefined,
    update: SessionTokenCountUpdate,
): SessionTokenCount {
    if (update.type === "reset") return ZERO_SESSION_TOKEN_COUNT;

    const previous = current ?? ZERO_SESSION_TOKEN_COUNT;
    if (update.type === "invalidate_context") {
        return { ...previous, lastContextTokens: 0 };
    }
    const contextTokens = Math.max(0, update.contextTokens);

    return {
        lastContextTokens: contextTokens,
        totalTokens:
            previous.totalTokens +
            (update.type === "compaction" ? 0 : Math.max(0, update.usage.totalTokens)),
    };
}
