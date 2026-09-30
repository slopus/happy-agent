import type { CodexResponseRequest } from "./CodexResponseRequest.js";

/** Native ChatGPT routing is also selected before the response body reaches inference. */
export function createCodexRoutingHint(
    request: Pick<CodexResponseRequest, "model" | "service_tier">,
): string {
    return request.service_tier == null
        ? `model=${request.model}`
        : `model=${request.model};tier=${request.service_tier}`;
}
