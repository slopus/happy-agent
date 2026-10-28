import { Type, type Static } from "@sinclair/typebox";

import { timestampSchema } from "./common.js";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/** One way the daemon's machine can already reach models; see "Provider routes" in API.md. */
export const providerRouteSchema = Type.Object({
    /** Stable across reads; opaque to clients, which percent-encode it in paths. */
    id: Type.String({ minLength: 1, maxLength: 200 }),
    /** `direct`, `desktop_app`, `api_key`, `local_proxy`, `router`, `cloud`, `local_models`, or newer. */
    kind: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    vendors: Type.Array(Type.String()),
    /** `subscription`, `pay_per_token`, `local`, `unknown`, or newer. */
    billing: Type.String({ minLength: 1 }),
    account: Type.Union([
        Type.Object({
            label: nullableString,
            email: nullableString,
            plan: nullableString,
            count: Type.Union([Type.Integer({ minimum: 2 }), Type.Null()]),
        }),
        Type.Null(),
    ]),
    /** A `127.0.0.1` base URL for local routes, otherwise null. */
    endpoint: nullableString,
    /** `ready`, `needs_sign_in`, `not_running`, `unauthorized`, `unknown`, or newer. */
    status: Type.String({ minLength: 1 }),
    models: Type.Union([
        Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), vendor: nullableString })),
        Type.Null(),
    ]),
    /** Other route IDs in the same response that reach the same vendor. */
    overlaps: Type.Array(Type.String()),
    /** The suggested initial selection. */
    recommended: Type.Boolean(),
    /** A display sentence when this route quietly changes what another route does. */
    warning: nullableString,
    providerId: nullableString,
    use: Type.Union([
        Type.Object({
            providerId: Type.String({ minLength: 1 }),
            type: Type.String({ minLength: 1 }),
            summary: Type.String({ minLength: 1 }),
            restartRequired: Type.Boolean(),
        }),
        Type.Null(),
    ]),
});
export type ProviderRoute = Static<typeof providerRouteSchema>;

/** `GET /v0/provider-routes` */
export const providerRoutesResponseSchema = Type.Object({
    routes: Type.Array(providerRouteSchema),
    detectedAt: timestampSchema,
});
export type ProviderRoutesResponse = Static<typeof providerRoutesResponseSchema>;

/** `POST /v0/provider-routes/:routeId/use` request. */
export const providerRouteUseRequestSchema = Type.Object({
    mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export type ProviderRouteUseRequest = Static<typeof providerRouteUseRequestSchema>;

/** `POST /v0/provider-routes/:routeId/use` response. */
export const providerRouteUseResponseSchema = Type.Object({
    route: providerRouteSchema,
    /** True when the daemon must restart before the new provider is used. */
    restartRequired: Type.Boolean(),
});
export type ProviderRouteUseResponse = Static<typeof providerRouteUseResponseSchema>;
