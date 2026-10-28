import { Type, type Static } from "@sinclair/typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/** In display order: the vendor's own routes first, local model servers last. */
export const PROVIDER_ROUTE_KINDS = [
    "direct",
    "desktop_app",
    "api_key",
    "local_proxy",
    "router",
    "cloud",
    "local_models",
] as const;

export const providerRouteIdSchema = Type.String({
    minLength: 1,
    maxLength: 200,
    pattern: "^[\\x21-\\x7e]+$",
});

export const providerRouteSchema = Type.Object(
    {
        id: providerRouteIdSchema,
        kind: Type.Union(PROVIDER_ROUTE_KINDS.map((kind) => Type.Literal(kind))),
        name: Type.String({ minLength: 1 }),
        vendors: Type.Array(Type.String({ minLength: 1 })),
        billing: Type.Union([
            Type.Literal("subscription"),
            Type.Literal("pay_per_token"),
            Type.Literal("local"),
            Type.Literal("unknown"),
        ]),
        account: Type.Union([
            Type.Object(
                {
                    label: nullableString,
                    email: nullableString,
                    plan: nullableString,
                    count: Type.Union([Type.Integer({ minimum: 2 }), Type.Null()]),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        endpoint: nullableString,
        status: Type.Union([
            Type.Literal("ready"),
            Type.Literal("needs_sign_in"),
            Type.Literal("not_running"),
            Type.Literal("unauthorized"),
            Type.Literal("unknown"),
        ]),
        models: Type.Union([
            Type.Array(
                Type.Object(
                    { id: Type.String({ minLength: 1 }), vendor: nullableString },
                    { additionalProperties: false },
                ),
                { maxItems: 500 },
            ),
            Type.Null(),
        ]),
        overlaps: Type.Array(providerRouteIdSchema),
        recommended: Type.Boolean(),
        warning: nullableString,
        providerId: nullableString,
        use: Type.Union([
            Type.Object(
                {
                    providerId: Type.String({ minLength: 1 }),
                    type: Type.String({ minLength: 1 }),
                    summary: Type.String({ minLength: 1 }),
                    restartRequired: Type.Boolean(),
                },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
    },
    { additionalProperties: false },
);
export type ProviderRoute = Static<typeof providerRouteSchema>;
export type ProviderRouteKind = ProviderRoute["kind"];

export const providerRouteUseRequestSchema = Type.Object(
    { mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) },
    { additionalProperties: false },
);

/** Why a route cannot be used, with the route as it is now when there is one. */
export class ProviderRouteRequestError extends Error {
    readonly code: "conflict" | "not_found";
    readonly route: ProviderRoute | null;

    constructor(
        code: ProviderRouteRequestError["code"],
        message: string,
        route: ProviderRoute | null,
    ) {
        super(message);
        this.name = "ProviderRouteRequestError";
        this.code = code;
        this.route = route;
    }
}
