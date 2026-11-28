import { type Static, Type } from "@sinclair/typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/**
 * An install or sign-in the daemon runs with a vendor's program; see "The operation object"
 * under Provider CLIs in API.md. Provider sign-in reports the same object.
 */
export const providerCliOperationSchema = Type.Object({
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
    error: Type.Union([Type.Object({ code: Type.String(), message: Type.String() }), Type.Null()]),
    startedAt: Type.Integer({ minimum: 0 }),
    finishedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export type ProviderCliOperation = Static<typeof providerCliOperationSchema>;

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
        /**
         * Whether the daemon accepts a pasted Claude setup token through
         * `POST /v0/provider-clis/claude/setup-token`. Absent means `false`.
         */
        acceptsToken: Type.Optional(Type.Boolean()),
        /**
         * Whether the program's sign-in can be finished by pasting the vendor page's code into
         * `POST /v0/provider-clis/:cliId/sign-in/code`. Absent means `false`; a waiting sign-in's
         * `authorization.acceptsCode` still decides for that attempt.
         */
        acceptsCode: Type.Optional(Type.Boolean()),
    }),
    operation: Type.Union([providerCliOperationSchema, Type.Null()]),
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

/** `GET /v0/provider-clis/:cliId` */
export const providerCliResponseSchema = Type.Object({ providerCli: providerCliSchema });
export type ProviderCliResponse = Static<typeof providerCliResponseSchema>;

/** `POST /v0/provider-clis/claude/setup-token` request. */
export const claudeSetupTokenRequestSchema = Type.Object({
    /** The daemon removes all whitespace before validating the token's shape and saving it. */
    token: Type.String(),
    mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export type ClaudeSetupTokenRequest = Static<typeof claudeSetupTokenRequestSchema>;

/** `provider_cli.updated`: one assistant's complete provider CLI object. */
export interface ProviderCliUpdatedPayload {
    providerCli: ProviderCli;
    mutationId?: string;
}
