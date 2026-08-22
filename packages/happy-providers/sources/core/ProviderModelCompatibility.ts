import { providerModelFamily } from "@/core/providerModelFamily.js";

export type ProviderModelCompatibilityType = "bedrock" | "claude" | "codex" | "grok" | "gym";

export type ProviderModelFamily = "claude" | "codex" | "grok";

export interface ProviderModelSelection {
    modelId: string;
    providerId: string;
    /** Resolved AWS region for a Bedrock route, when the caller knows it. */
    providerRegion?: string;
    providerType: ProviderModelCompatibilityType;
}

type CompatibilityRule = readonly ProviderModelFamily[];

export const PROVIDER_MODEL_COMPATIBILITY_MATRIX: Readonly<
    Record<
        ProviderModelCompatibilityType,
        Partial<Record<ProviderModelCompatibilityType, CompatibilityRule>>
    >
> = {
    bedrock: {
        bedrock: ["claude", "codex"],
    },
    claude: {
        claude: ["claude"],
    },
    codex: {
        codex: ["codex"],
    },
    grok: {
        grok: ["grok"],
    },
    gym: {
        gym: ["claude", "codex", "grok"],
    },
};

export function areProviderModelsCompatible(
    left: ProviderModelSelection,
    right: ProviderModelSelection,
): boolean {
    const leftFamily = providerModelFamily(left.modelId);
    const rightFamily = providerModelFamily(right.modelId);
    if (leftFamily === undefined || leftFamily !== rightFamily) return false;
    const compatibleFamilies =
        PROVIDER_MODEL_COMPATIBILITY_MATRIX[left.providerType][right.providerType];
    if (compatibleFamilies?.includes(leftFamily) !== true) return false;

    // Bedrock's GPT continuation state is scoped to the region that produced it. Callers that
    // cannot resolve both regions may still continue inside the exact same registered route, but
    // must not guess that two separately named accounts are colocated.
    if (left.providerType === "bedrock" && leftFamily === "codex") {
        const leftRegion = left.providerRegion?.trim() || undefined;
        const rightRegion = right.providerRegion?.trim() || undefined;
        return leftRegion === undefined || rightRegion === undefined
            ? left.providerId === right.providerId
            : leftRegion === rightRegion;
    }

    return true;
}
