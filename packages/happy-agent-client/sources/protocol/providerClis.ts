import { type Static, Type } from "@sinclair/typebox";

import { mutationIdSchema } from "./common.js";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/**
 * One assistant's command-line program on the daemon's machine; see "Provider CLIs" in API.md.
 * Sets that may grow (`id`, `installation.source`, the sign-in `methods`) are open strings.
 */
export const providerCliSchema = Type.Object({
    /** `claude`, `codex`, `grok`, `antigravity`, or newer; skip IDs you do not know. */
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    vendor: Type.String({ minLength: 1 }),
    website: Type.String({ minLength: 1 }),
    providerId: nullableString,
    installation: Type.Object({
        status: Type.Union([Type.Literal("installed"), Type.Literal("missing")]),
        path: nullableString,
        version: nullableString,
        /** `standalone`, `desktop_app`, `package_manager`, `other`, or newer; null when missing. */
        source: nullableString,
        desktopApp: nullableString,
    }),
    installer: Type.Union([
        Type.Object({
            command: Type.String({ minLength: 1 }),
            sourceUrl: Type.String({ minLength: 1 }),
            sourceHost: Type.String({ minLength: 1 }),
            vendorSite: Type.String({ minLength: 1 }),
        }),
        Type.Null(),
    ]),
    commands: Type.Object({
        run: Type.String({ minLength: 1 }),
        signIn: Type.String({ minLength: 1 }),
    }),
    signIn: Type.Object({
        status: Type.Union([
            Type.Literal("signed_in"),
            Type.Literal("signed_out"),
            Type.Literal("unknown"),
        ]),
        account: Type.Union([
            Type.Object({ email: nullableString, plan: nullableString }),
            Type.Null(),
        ]),
        /** `browser`, `device`, or newer, in the order the daemon prefers them. */
        methods: Type.Array(Type.String()),
    }),
    operation: Type.Union([
        Type.Object({
            id: Type.String({ minLength: 1 }),
            kind: Type.Union([Type.Literal("install"), Type.Literal("sign_in")]),
            status: Type.Union([
                Type.Literal("running"),
                Type.Literal("waiting"),
                Type.Literal("succeeded"),
                Type.Literal("failed"),
                Type.Literal("cancelled"),
            ]),
            message: Type.String({ minLength: 1 }),
            authorization: Type.Union([
                Type.Object({
                    method: Type.String(),
                    url: Type.String({ minLength: 1 }),
                    userCode: nullableString,
                    openedByProgram: Type.Boolean(),
                    acceptsCode: Type.Boolean(),
                    expiresAt: Type.Integer({ minimum: 0 }),
                }),
                Type.Null(),
            ]),
            output: Type.Array(Type.String()),
            error: Type.Union([
                Type.Object({ code: Type.String(), message: Type.String() }),
                Type.Null(),
            ]),
            startedAt: Type.Integer({ minimum: 0 }),
            finishedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        }),
        Type.Null(),
    ]),
    /** UUIDv7; keep the object with the greater one. */
    version: Type.String({ minLength: 1 }),
    updatedAt: Type.Integer({ minimum: 0 }),
});
export type ProviderCli = Static<typeof providerCliSchema>;

/** `GET /v0/provider-clis` */
export const providerClisResponseSchema = Type.Object({
    providerClis: Type.Array(providerCliSchema),
});
export type ProviderClisResponse = Static<typeof providerClisResponseSchema>;

/** Every `/v0/provider-clis/:cliId` route's response. */
export const providerCliResponseSchema = Type.Object({ providerCli: providerCliSchema });
export type ProviderCliResponse = Static<typeof providerCliResponseSchema>;

/**
 * On a team server, whose connection a sign-in makes: an existing team provider, the caller's own
 * (`{ scope: "private" }`), or a provider of that name, made when there is none. The standalone
 * daemon ignores it.
 */
export const providerCliSignInTargetSchema = Type.Union([
    Type.Object({ providerId: Type.String({ minLength: 1 }) }),
    Type.Object({
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        scope: Type.Union([Type.Literal("team"), Type.Literal("private")]),
    }),
]);
export type ProviderCliSignInTarget = Static<typeof providerCliSignInTargetSchema>;

/** `POST /v0/provider-clis/:cliId/sign-in` */
export const providerCliSignInRequestSchema = Type.Object({
    method: Type.Optional(Type.String()),
    /** Without one, a team server signs in privately. */
    target: Type.Optional(providerCliSignInTargetSchema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderCliSignInRequest = Static<typeof providerCliSignInRequestSchema>;

/** `POST /v0/provider-clis/:cliId/sign-in/code`; the code is never stored or logged. */
export const providerCliSignInCodeRequestSchema = Type.Object({
    code: Type.String({ minLength: 1, maxLength: 2_048 }),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ProviderCliSignInCodeRequest = Static<typeof providerCliSignInCodeRequestSchema>;

/** `provider_cli.updated`: one assistant's complete provider CLI object. */
export interface ProviderCliUpdatedPayload {
    providerCli: ProviderCli;
    mutationId?: string;
}
