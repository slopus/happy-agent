import { type Static, Type } from "@sinclair/typebox";

const nullableString = Type.Union([Type.String(), Type.Null()]);

/**
 * One assistant's command-line program on the daemon's machine; see "Provider CLIs" in API.md.
 * This is the live state the `provider_sign_in` chat UI component is drawn from. Sets that may
 * grow (`id`, `installation.source`, the sign-in `methods`) are open strings.
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
         * Whether a pasted setup token or API key can sign this assistant in, which is when
         * `provider_sign_in` offers its `submit_token` control. Absent means `false`.
         */
        acceptsToken: Type.Optional(Type.Boolean()),
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

/** `GET /v0/provider-clis/:cliId` */
export const providerCliResponseSchema = Type.Object({ providerCli: providerCliSchema });
export type ProviderCliResponse = Static<typeof providerCliResponseSchema>;

/** `provider_cli.updated`: one assistant's complete provider CLI object. */
export interface ProviderCliUpdatedPayload {
    providerCli: ProviderCli;
    mutationId?: string;
}
