import type {
    SessionMessage,
    SessionToolCallBlock,
    SessionToolResultMessage,
} from "@/core/SessionContext.js";

/** Provider-native replay identity retained only inside one context tool-call block. */
export interface SessionToolCallVendor {
    readonly providerCallId: string;
    readonly [key: string]: unknown;
}

/** Attach a provider-native ID without exposing it through the context block's primary ID. */
export function withProviderToolCallId(
    vendor: unknown,
    providerCallId: string,
): SessionToolCallVendor {
    if (typeof vendor === "object" && vendor !== null && !Array.isArray(vendor)) {
        return { ...vendor, providerCallId };
    }
    return { providerCallId, ...(vendor === undefined ? {} : { value: vendor }) };
}

/** Read the provider-native ID from the only context location allowed to retain it. */
export function providerToolCallId(call: SessionToolCallBlock): string {
    const vendor: unknown = call.vendor;
    if (
        typeof vendor !== "object" ||
        vendor === null ||
        !("providerCallId" in vendor) ||
        typeof vendor.providerCallId !== "string" ||
        vendor.providerCallId.length === 0
    ) {
        throw new Error(`Tool call "${call.callId}" is missing its provider replay identity.`);
    }
    return vendor.providerCallId;
}

/**
 * Resolve Base tool-call IDs back to provider-native IDs for one self-contained context.
 *
 * Tool results deliberately do not duplicate provider identity. Providers look backward to the
 * corresponding assistant tool-call block when constructing their native request instead.
 */
export function createProviderToolCallIdResolver(
    messages: readonly SessionMessage[],
): (callId: string) => string {
    const providerCallIds = new Map<string, string>();
    for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
            if (block.type !== "tool_call") continue;
            const providerCallId = providerToolCallId(block);
            const existing = providerCallIds.get(block.callId);
            if (existing !== undefined && existing !== providerCallId) {
                throw new Error(`Tool call "${block.callId}" has conflicting provider identities.`);
            }
            providerCallIds.set(block.callId, providerCallId);
        }
    }
    return (callId) => {
        const providerCallId = providerCallIds.get(callId);
        if (providerCallId === undefined) {
            throw new Error(`Tool result "${callId}" has no provider tool call in context.`);
        }
        return providerCallId;
    };
}

/** Convert a caller-owned result to the native identity expected by a live provider bridge. */
export function toProviderToolResultMessage(
    resolveProviderCallId: (callId: string) => string,
    message: SessionToolResultMessage,
): SessionToolResultMessage {
    return { ...message, callId: resolveProviderCallId(message.callId) };
}
