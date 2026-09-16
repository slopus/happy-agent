import type { ComputeServiceStartOptions } from "../ComputeServices.js";
import type { ManagedNetworkRule } from "../network/ManagedNetworkPolicy.js";

/** Intersect requested service destinations with both this action and the user's network policy. */
export function resolveServiceOutbound(options: ComputeServiceStartOptions): {
    hostname: string;
    port: number;
}[] {
    const requested = options.sandbox.outbound;
    if (requested.length === 0) return [];
    if (!options.permissions.network.egress) {
        throw new Error("This action does not permit outbound service traffic.");
    }
    const allowed = options.networkPolicy?.allowedDomains ?? [];
    const denied = options.networkPolicy?.deniedDomains ?? [];
    const actionHosts = options.permissions.network.allowedHosts ?? [];
    const destinations = new Map<string, { hostname: string; port: number }>();
    for (const request of requested) {
        const hostname = request.hostname.toLowerCase().replace(/\.$/u, "");
        if (
            !allowed.some((rule) => matchesRule(rule, hostname, request.port)) ||
            denied.some((rule) => matchesRule(rule, hostname, request.port)) ||
            (actionHosts.length > 0 && !actionHosts.some((host) => matchesHost(host, hostname)))
        ) {
            throw new Error(
                `The user's network policy does not permit service access to ${hostname}:${String(request.port)}.`,
            );
        }
        destinations.set(`${hostname}:${String(request.port)}`, { hostname, port: request.port });
    }
    return [...destinations.values()];
}

function matchesRule(rule: ManagedNetworkRule, hostname: string, port: number): boolean {
    return (
        matchesHost(rule.domain, hostname) &&
        (rule.ports === undefined || rule.ports.includes(port))
    );
}

function matchesHost(pattern: string, hostname: string): boolean {
    const normalized = pattern.toLowerCase().replace(/\.$/u, "");
    if (normalized === "*") return false;
    return normalized.startsWith("*.")
        ? hostname.endsWith(normalized.slice(1)) && hostname.length > normalized.length - 1
        : normalized === hostname;
}
