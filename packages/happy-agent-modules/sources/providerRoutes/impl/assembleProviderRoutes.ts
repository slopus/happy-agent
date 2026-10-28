import { PROVIDER_ROUTE_KINDS, type ProviderRoute } from "../ProviderRoute.js";
import type { ConfiguredProviders, DetectedRoute } from "./DetectedRoute.js";

const VENDOR_ROUTES: readonly ProviderRoute["kind"][] = ["direct", "desktop_app"];

/**
 * Order the detected routes, mark which reach the same vendor, suggest the initial selection, and
 * say what choosing each would set up. Every ready sign-in of a vendor's own starts selected; any
 * other route starts selected only when it brings a vendor nothing before it already does, so the
 * same vendor is not reached through two routes by default.
 */
export function assembleProviderRoutes(
    detected: readonly DetectedRoute[],
    providers: ConfiguredProviders,
): ProviderRoute[] {
    const sorted = [...detected].sort(
        (left, right) =>
            PROVIDER_ROUTE_KINDS.indexOf(left.kind) - PROVIDER_ROUTE_KINDS.indexOf(right.kind) ||
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
    );
    return sorted.map((route) => {
        const others = sorted.filter(
            (other) =>
                other.id !== route.id &&
                other.vendors.some((vendor) => route.vendors.includes(vendor)),
        );
        const index = sorted.indexOf(route);
        // Another route already brings this vendor: the vendor's own sign-in, or an earlier route.
        const served = (vendor: string) =>
            others.some(
                (other) =>
                    other.vendors.includes(vendor) &&
                    other.status === "ready" &&
                    (VENDOR_ROUTES.includes(other.kind) ||
                        (other.kind !== "local_models" && sorted.indexOf(other) < index)),
            );
        const recommended =
            route.status === "ready" &&
            route.kind !== "local_models" &&
            (VENDOR_ROUTES.includes(route.kind) || route.vendors.some((vendor) => !served(vendor)));
        return {
            ...publicFields(route),
            overlaps: others.map((other) => other.id),
            recommended,
            ...configuration(route, providers),
        };
    });
}

/** The route as detected, without what only the daemon may see. */
function publicFields(
    route: DetectedRoute,
): Omit<ProviderRoute, "overlaps" | "recommended" | "providerId" | "use"> {
    return {
        id: route.id,
        kind: route.kind,
        name: route.name,
        vendors: [...route.vendors],
        billing: route.billing,
        account: route.account === null ? null : { ...route.account },
        endpoint: route.endpoint,
        status: route.status,
        models: route.models === null ? null : route.models.map((model) => ({ ...model })),
        warning: route.warning,
    };
}

function configuration(
    route: DetectedRoute,
    providers: ConfiguredProviders,
): Pick<ProviderRoute, "providerId" | "use"> {
    if (route.providerId !== undefined) {
        const enabled = providers.isEnabled(route.providerId);
        return {
            providerId: route.providerId,
            use:
                enabled || !usable(route)
                    ? null
                    : {
                          providerId: route.providerId,
                          type: providers.typeOf(route.providerId) ?? route.providerId,
                          summary: `Turns on ${route.name}.`,
                          restartRequired: false,
                      },
        };
    }
    if (route.provider === undefined) return { providerId: null, use: null };
    const baseUrl = route.provider.table["base_url"];
    const existing = providers.has(route.provider.id)
        ? route.provider.id
        : typeof baseUrl === "string"
          ? providers.at(baseUrl)
          : undefined;
    if (existing !== undefined) return { providerId: existing, use: null };
    return {
        providerId: null,
        use: usable(route)
            ? {
                  providerId: route.provider.id,
                  type: route.provider.table.type,
                  summary: route.provider.summary,
                  restartRequired: true,
              }
            : null,
    };
}

/**
 * Whether choosing the route can set it up. A route detection cannot vouch for, such as a sign-in
 * kept in the keychain, may still be chosen: setting it up only writes configuration.
 */
function usable(route: DetectedRoute): boolean {
    return route.status === "ready" || route.status === "unknown";
}
