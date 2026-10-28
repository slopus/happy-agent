import { Type, type Static } from "@sinclair/typebox";

/** The assistants whose command-line programs the daemon can find, install, and sign in. */
export const PROVIDER_CLI_IDS = ["claude", "codex", "grok", "antigravity"] as const;
export const providerCliIdSchema = Type.Union(PROVIDER_CLI_IDS.map((id) => Type.Literal(id)));
export type ProviderCliId = Static<typeof providerCliIdSchema>;

const nullableString = Type.Union([Type.String(), Type.Null()]);

export const providerCliSignInMethodSchema = Type.Union([
    Type.Literal("browser"),
    Type.Literal("device"),
]);
export type ProviderCliSignInMethod = Static<typeof providerCliSignInMethodSchema>;

export const providerCliInstallationSchema = Type.Object(
    {
        status: Type.Union([Type.Literal("installed"), Type.Literal("missing")]),
        path: nullableString,
        version: nullableString,
        source: Type.Union([
            Type.Literal("standalone"),
            Type.Literal("desktop_app"),
            Type.Literal("package_manager"),
            Type.Literal("other"),
            Type.Null(),
        ]),
        desktopApp: nullableString,
    },
    { additionalProperties: false },
);
export type ProviderCliInstallation = Static<typeof providerCliInstallationSchema>;

export const providerCliInstallerSchema = Type.Object(
    {
        command: Type.String({ minLength: 1 }),
        sourceUrl: Type.String({ minLength: 1 }),
        sourceHost: Type.String({ minLength: 1 }),
        vendorSite: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type ProviderCliInstaller = Static<typeof providerCliInstallerSchema>;

export const providerCliSignInSchema = Type.Object(
    {
        status: Type.Union([
            Type.Literal("signed_in"),
            Type.Literal("signed_out"),
            Type.Literal("unknown"),
        ]),
        account: Type.Union([
            Type.Object(
                { email: nullableString, plan: nullableString },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        methods: Type.Array(providerCliSignInMethodSchema),
    },
    { additionalProperties: false },
);
export type ProviderCliSignIn = Static<typeof providerCliSignInSchema>;

export const providerCliAuthorizationSchema = Type.Object(
    {
        method: providerCliSignInMethodSchema,
        url: Type.String({ minLength: 1 }),
        userCode: nullableString,
        openedByProgram: Type.Boolean(),
        acceptsCode: Type.Boolean(),
        expiresAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ProviderCliAuthorization = Static<typeof providerCliAuthorizationSchema>;

export const providerCliOperationErrorSchema = Type.Object(
    { code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type ProviderCliOperationError = Static<typeof providerCliOperationErrorSchema>;

export const providerCliOperationStatusSchema = Type.Union([
    Type.Literal("running"),
    Type.Literal("waiting"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
]);
export type ProviderCliOperationStatus = Static<typeof providerCliOperationStatusSchema>;

export const providerCliOperationSchema = Type.Object(
    {
        id: Type.String({ minLength: 1 }),
        kind: Type.Union([Type.Literal("install"), Type.Literal("sign_in")]),
        status: providerCliOperationStatusSchema,
        message: Type.String({ minLength: 1 }),
        authorization: Type.Union([providerCliAuthorizationSchema, Type.Null()]),
        output: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 }),
        error: Type.Union([providerCliOperationErrorSchema, Type.Null()]),
        startedAt: Type.Integer({ minimum: 0 }),
        finishedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    },
    { additionalProperties: false },
);
export type ProviderCliOperation = Static<typeof providerCliOperationSchema>;

export const providerCliSchema = Type.Object(
    {
        id: providerCliIdSchema,
        name: Type.String({ minLength: 1 }),
        vendor: Type.String({ minLength: 1 }),
        website: Type.String({ minLength: 1 }),
        providerId: nullableString,
        installation: providerCliInstallationSchema,
        installer: Type.Union([providerCliInstallerSchema, Type.Null()]),
        commands: Type.Object(
            { run: Type.String({ minLength: 1 }), signIn: Type.String({ minLength: 1 }) },
            { additionalProperties: false },
        ),
        signIn: providerCliSignInSchema,
        operation: Type.Union([providerCliOperationSchema, Type.Null()]),
        version: Type.String({ minLength: 1 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ProviderCli = Static<typeof providerCliSchema>;

const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });

export const providerCliMutationRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);

export const providerCliSignInRequestSchema = Type.Object(
    {
        method: Type.Optional(providerCliSignInMethodSchema),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const providerCliSignInCodeRequestSchema = Type.Object(
    {
        code: Type.String({ minLength: 1, maxLength: 2_048, pattern: "^[\\x21-\\x7e]+$" }),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

/** Why a provider CLI request could not start, with the object as it is now. */
export class ProviderCliRequestError extends Error {
    readonly code:
        | "already_installed"
        | "busy"
        | "conflict"
        | "invalid_request"
        | "no_installer"
        | "not_installed";
    readonly providerCli: ProviderCli;

    constructor(code: ProviderCliRequestError["code"], message: string, providerCli: ProviderCli) {
        super(message);
        this.name = "ProviderCliRequestError";
        this.code = code;
        this.providerCli = providerCli;
    }
}
