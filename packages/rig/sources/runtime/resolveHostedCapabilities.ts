import type { HostedCapability } from "@slopus/rig-execution";

import type { ConfigProvider } from "../config/types.js";
import type { PermissionMode } from "../agent/index.js";

export interface ResolveHostedCapabilitiesOptions {
    /** What the reviewed spawn granted this agent, when it is a subagent. */
    granted?: readonly HostedCapability[];
    isSubagent: boolean;
    permissionMode?: PermissionMode;
    providerConfig?: ConfigProvider;
}

/**
 * Decides which provider-executed searches an agent actually declares.
 *
 * A subagent declares exactly what its spawn granted, and nothing else: that grant was reviewed
 * once, against the parent's permission mode, and holds for the child's whole life so a followup
 * does not have to re-earn it.
 *
 * A root agent has no such review to point at, so it declares only what the user turned on in
 * configuration, and only while its permission mode already allows reaching outside the sandbox.
 * Read only means the session does not touch anything it cannot take back, and a search that runs
 * on the provider's backend is not something Rig can take back.
 */
export function resolveHostedCapabilities(
    options: ResolveHostedCapabilitiesOptions,
): readonly HostedCapability[] {
    if (options.isSubagent) return options.granted ?? [];
    if (options.granted !== undefined && options.granted.length > 0) return options.granted;
    const config = options.providerConfig;
    if (config === undefined || config.type !== "grok") return [];
    const configured = config.hostedSearch ?? [];
    if (configured.length === 0) return [];
    return options.permissionMode === "auto" || options.permissionMode === "full_access"
        ? configured
        : [];
}
