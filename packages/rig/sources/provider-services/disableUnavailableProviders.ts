import type { ConfigProviders } from "../config/types.js";
import type { ProviderModelCatalog } from "../protocol/index.js";

export function disableUnavailableProviders(
    providers: ConfigProviders,
    disabledReasons: ReadonlyMap<string, NonNullable<ProviderModelCatalog["disabledReason"]>>,
): ConfigProviders {
    return Object.fromEntries(
        Object.entries(providers).map(([id, config]) => [
            id,
            disabledReasons.has(id) ? { ...config, enabled: false } : config,
        ]),
    );
}
