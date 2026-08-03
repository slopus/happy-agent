import { HOSTED_CAPABILITIES, type HostedCapability } from "@slopus/rig-execution";

import type { PermissionMode } from "../permissions/index.js";

export interface GrantableCapabilityOptions {
    /** What the agent doing the granting already holds. */
    held: readonly HostedCapability[];
    permissionMode: PermissionMode;
}

/**
 * Which provider-executed searches an agent may hand to a child.
 *
 * Two rules, both narrowing. An agent that cannot reach outside Rig's sandbox itself cannot grant
 * a search that runs outside it, so Read only and Workspace write grant nothing — otherwise a
 * restricted session could reach the network by delegating. And an agent that already holds one
 * grants nothing either: the grant was reviewed once, for one agent, and a chain of re-grants
 * would carry that single approval arbitrarily far from the person who gave it.
 */
export function grantableCapabilities(
    options: GrantableCapabilityOptions,
): readonly HostedCapability[] {
    if (options.held.length > 0) return [];
    return options.permissionMode === "auto" || options.permissionMode === "full_access"
        ? HOSTED_CAPABILITIES
        : [];
}

/**
 * An agent holding a search Rig cannot intercept is the end of the line.
 *
 * Depth-1 is what keeps the grant reviewable. The spawn that granted it is the only place anyone
 * saw the decision, and it named one agent and one task; a child of that agent would inherit the
 * reach without inheriting the review.
 */
export function canSpawnWithCapabilities(held: readonly HostedCapability[]): boolean {
    return held.length === 0;
}

export interface AssertGrantOptions {
    /** What the parent may hand out, from `grantableCapabilities`. */
    grantable: readonly HostedCapability[];
    requested: readonly HostedCapability[];
}

/**
 * Rejects a spawn that asks for more than the parent may give, naming what was refused.
 *
 * A spawn may only narrow. Failing loudly matters more than usual here: a grant quietly reduced to
 * nothing would leave the child unable to search and the parent unable to see why.
 */
export function assertGrantIsNarrowing(options: AssertGrantOptions): void {
    if (options.requested.length === 0) return;
    const refused = options.requested.filter(
        (capability) => !options.grantable.includes(capability),
    );
    if (refused.length === 0) return;
    throw new Error(
        options.grantable.length === 0
            ? `This agent cannot grant ${refused.join(", ")}. A capability that runs on the provider's backend can only be granted by an agent that holds none itself and is in Auto or Full access.`
            : `This agent cannot grant ${refused.join(", ")}. It may grant ${options.grantable.join(", ")}.`,
    );
}
