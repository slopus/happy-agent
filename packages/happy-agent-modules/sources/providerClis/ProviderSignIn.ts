import { Type, type Static } from "@sinclair/typebox";

import { providerCredentialSourceSchema } from "../config/index.js";
import {
    providerCliOperationSchema,
    providerCliSignInMethodSchema,
    type ProviderCliId,
} from "./ProviderCli.js";

/** The assistants whose programs can sign one configured account in to its own credential. */
export const PROVIDER_SIGN_IN_CLI_IDS = [
    "claude",
    "codex",
    "grok",
] as const satisfies readonly ProviderCliId[];
export type ProviderSignInCliId = (typeof PROVIDER_SIGN_IN_CLI_IDS)[number];

const nullableString = Type.Union([Type.String(), Type.Null()]);
const mutationIdSchema = Type.String({ minLength: 1, maxLength: 512 });

/** Where an account's credential comes from and how it can sign in. */
export const providerCredentialSchema = Type.Object(
    {
        source: providerCredentialSourceSchema,
        methods: Type.Array(providerCliSignInMethodSchema),
        acceptsToken: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type ProviderCredential = Static<typeof providerCredentialSchema>;

/** One account's sign-in into a credential this installation owns; see Provider sign-in. */
export const providerSignInSchema = Type.Object(
    {
        providerId: Type.String({ minLength: 1 }),
        cliId: Type.Union(PROVIDER_SIGN_IN_CLI_IDS.map((id) => Type.Literal(id))),
        installed: Type.Boolean(),
        credential: providerCredentialSchema,
        account: Type.Union([
            Type.Object(
                { email: nullableString, plan: nullableString },
                { additionalProperties: false },
            ),
            Type.Null(),
        ]),
        operation: Type.Union([providerCliOperationSchema, Type.Null()]),
        version: Type.String({ minLength: 1 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ProviderSignIn = Static<typeof providerSignInSchema>;

export const providerSignInStartRequestSchema = Type.Object(
    {
        method: Type.Optional(providerCliSignInMethodSchema),
        mutationId: Type.Optional(mutationIdSchema),
    },
    { additionalProperties: false },
);

export const providerTokenRequestSchema = Type.Object(
    { token: Type.String(), mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);

/** Why a provider sign-in request could not be served, with the object as it is now when known. */
export class ProviderSignInRequestError extends Error {
    readonly code: "conflict" | "invalid_request" | "not_found" | "not_installed" | "not_supported";
    readonly providerSignIn: ProviderSignIn | undefined;

    constructor(
        code: ProviderSignInRequestError["code"],
        message: string,
        providerSignIn?: ProviderSignIn,
    ) {
        super(message);
        this.name = "ProviderSignInRequestError";
        this.code = code;
        this.providerSignIn = providerSignIn;
    }
}
