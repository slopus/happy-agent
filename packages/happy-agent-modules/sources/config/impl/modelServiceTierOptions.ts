import type { ServiceTierOption } from "@slopus/happy-agent-client";

/** Curated speed labels belong beside the agent's provider capability catalog. */
const SERVICE_TIER_LABELS: ReadonlyMap<string, string> = new Map([
    ["priority", "Fast"],
    ["ultrafast", "Ultrafast"],
]);

export function modelServiceTierOptions(
    tiers: readonly string[] = [],
): readonly ServiceTierOption[] {
    return [
        { id: null, label: "Regular" },
        ...[...new Set(tiers)].map((id) => {
            const label = SERVICE_TIER_LABELS.get(id);
            if (label === undefined) {
                throw new Error(`The service tier "${id}" has no configured display label.`);
            }
            return { id, label };
        }),
    ];
}
