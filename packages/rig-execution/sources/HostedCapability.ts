/**
 * A search the provider runs on its own backend, which Rig declares but cannot intercept.
 *
 * Every other network tool in Rig is a `ToolDefinition`: it has a schema, a handler, and a
 * permission policy, so Rig decides at call time whether it may run. A hosted capability has none
 * of that. It is declared in the request and executed by the provider during the response, so by
 * the time Rig sees anything the search has already happened. There is no call to gate.
 *
 * Rig therefore gates the grant instead of the call. An agent holds a hosted capability only
 * because it was spawned with one, or because the user turned it on for the root agent in
 * configuration. The spawn is the interception point the search itself denies.
 */
export type HostedCapability = "web_search" | "x_search";

export const HOSTED_CAPABILITIES: readonly HostedCapability[] = ["web_search", "x_search"];

/**
 * Whether a model can run a hosted search at all.
 *
 * Only Grok executes search on its own backend, so granting one to any other model would produce
 * an agent that believes it can search and silently cannot. The grant is refused instead.
 */
export function modelSupportsHostedCapabilities(modelId: string): boolean {
    return modelId.startsWith("xai/");
}

export function isHostedCapability(value: string): value is HostedCapability {
    return (HOSTED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Reads a capability list off the wire, rejecting anything unrecognized rather than dropping it.
 * A grant the caller believes it made and Rig silently ignored is worse than a failed spawn.
 */
export function parseHostedCapabilities(values: readonly string[]): readonly HostedCapability[] {
    const parsed: HostedCapability[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!isHostedCapability(trimmed)) {
            throw new Error(
                `Unknown capability '${value}'. Available capabilities: ${HOSTED_CAPABILITIES.join(", ")}.`,
            );
        }
        if (!parsed.includes(trimmed)) parsed.push(trimmed);
    }
    return parsed;
}

export function describeHostedCapability(capability: HostedCapability): string {
    return capability === "x_search"
        ? "search X (Twitter) on the provider's backend"
        : "search the web on the provider's backend";
}

/** One sentence naming what a grant lets the child reach, for a permission review. */
export function describeHostedCapabilityGrant(
    capabilities: readonly HostedCapability[],
): string | undefined {
    if (capabilities.length === 0) return undefined;
    const described = capabilities.map(describeHostedCapability);
    const joined =
        described.length === 1
            ? described[0]
            : `${described.slice(0, -1).join(", ")} and ${described[described.length - 1]}`;
    return `Start a subagent that can ${joined}. Rig cannot review those searches individually, so this grant is the only place they are approved.`;
}
