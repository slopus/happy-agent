import type { ServiceTier } from "../protocol/ClientProtocolTypes.js";

/** Display names stay separate from the provider-owned wire identifiers. */
export function toWireServiceTier(tier: ServiceTier): string {
    return tier === "fast" ? "priority" : "ultrafast";
}

export function toTerminalServiceTier(tier: string | null): ServiceTier | undefined {
    if (tier === "priority") return "fast";
    if (tier === "ultrafast") return "ultrafast";
    return undefined;
}
