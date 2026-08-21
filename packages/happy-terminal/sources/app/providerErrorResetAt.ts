import type { ProviderError } from "../protocol/index.js";

export function providerErrorResetAt(error: ProviderError | undefined): number | undefined {
    if (error === undefined || !("resetAt" in error)) return undefined;
    return error.resetAt;
}
