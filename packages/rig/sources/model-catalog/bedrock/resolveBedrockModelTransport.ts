import type { BedrockModelOverride } from "../../config/bedrock-model-overrides.js";
import type { BedrockModelRoute, BedrockModelTransport } from "./bedrock-model-routes.js";

export function resolveBedrockModelTransport(
    route: BedrockModelRoute,
    region: string,
    override: BedrockModelOverride | undefined,
): BedrockModelTransport | undefined {
    const requestedTransport = override?.transport;
    const routes =
        requestedTransport === undefined
            ? route.transports
            : route.transports.filter(({ transport }) => transport === requestedTransport);
    if (override?.endpoint?.trim()) return routes[0]?.transport;
    return routes.find(({ regions }) => regions.includes(region))?.transport;
}
