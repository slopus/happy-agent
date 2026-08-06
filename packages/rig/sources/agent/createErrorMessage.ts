import type { ErrorMessage } from "./types.js";

export function createErrorMessage(
    id: string,
    reason: string,
    outcome: ErrorMessage["outcome"],
    attempt?: number,
    context?: ErrorMessage["context"],
    diagnostics?: Pick<ErrorMessage, "providerError" | "providerId" | "requestedModelId">,
): ErrorMessage {
    return {
        blocks: [{ text: reason, type: "text" }],
        ...(context === undefined ? {} : { context }),
        id,
        outcome,
        role: "error",
        ...(attempt === undefined ? {} : { attempt }),
        ...(diagnostics?.providerError === undefined
            ? {}
            : { providerError: diagnostics.providerError }),
        ...(diagnostics?.providerId === undefined ? {} : { providerId: diagnostics.providerId }),
        ...(diagnostics?.requestedModelId === undefined
            ? {}
            : { requestedModelId: diagnostics.requestedModelId }),
    };
}
