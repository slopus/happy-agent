import type { HappyAgentConfigValues } from "../../config/index.js";
import type { ComputePermissions } from "../Compute.js";

/** The port allowed domains are reached on when the policy names none. */
const DEFAULT_ALLOWED_PORTS = [443];

/**
 * One command's permissions with the person's configured `[network]` policy applied.
 *
 * Only Auto and Workspace write commands change. Read only never reaches the network and Full
 * access is already unrestricted, so the policy has nothing to add to either. A caller that already
 * chose network permissions of its own keeps them.
 *
 * `allowed_loopback_ports` is not applied: the supervisor's proxy refuses loopback destinations
 * that are not named literally, and has no per-port loopback forwarding.
 */
export function withConfiguredNetwork(
    permissions: ComputePermissions,
    policy: HappyAgentConfigValues["network"],
): ComputePermissions {
    if (policy === undefined) return permissions;
    if (permissions.mode !== "auto" && permissions.mode !== "workspace_write") return permissions;
    if (permissions.network.egress || permissions.network.localBinding) return permissions;
    const allowedHosts = policy.allowedDomains ?? [];
    const allowedPorts = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
    const deniedHosts = policy.deniedDomains ?? [];
    const egress = allowedHosts.length > 0 && allowedPorts.length > 0;
    const localBinding = policy.allowLocalBinding === true;
    if (!egress && !localBinding) return permissions;
    return {
        ...permissions,
        network: egress
            ? {
                  egress,
                  localBinding,
                  allowedHosts: [...allowedHosts],
                  allowedPorts: [...allowedPorts],
                  ...(deniedHosts.length === 0 ? {} : { deniedHosts: [...deniedHosts] }),
              }
            : { egress, localBinding },
    };
}
