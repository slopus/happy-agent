import type { Model } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";

/** Curated metadata used to assemble Rig's model picker without constructing a provider. */
export interface ModelCatalogProfile {
    hidden?: boolean;
    id: string;
    model: Model;
    providerId: string;
    providerType: ProviderModelCompatibilityType;
}