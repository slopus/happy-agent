import { createPublicKey } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;

const asymmetricAlgorithms = [
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
    "EdDSA",
] as const;
const symmetricAlgorithms = ["HS256", "HS384", "HS512"] as const;

const algorithmSchema = Type.Union(
    [...asymmetricAlgorithms, ...symmetricAlgorithms].map((algorithm) => Type.Literal(algorithm)),
);
const algorithmsSchema = Type.Array(algorithmSchema, { maxItems: 13, minItems: 1 });
const urlSchema = Type.String({ maxLength: 2_048, minLength: 1 });
const nonEmptySchema = Type.String({ maxLength: 2_048, minLength: 1 });
const printable = "^[^\\u0000-\\u001f\\u007f-\\u009f]+$";
const clientIdSchema = Type.String({ maxLength: 256, minLength: 1, pattern: printable });
const scopeSchema = Type.String({ maxLength: 1_024, minLength: 1, pattern: printable });

/** Printable display name for the sign-in method. */
export const teamJwtNameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

/** A user ID, as configured for the deployment owner. */
export const teamOwnerUserIdSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});

/** `[feature.team.jwt]` as written in machine configuration. */
export const teamJwtTomlSchema = Type.Object(
    {
        algorithms: algorithmsSchema,
        audience: nonEmptySchema,
        issuer: nonEmptySchema,
        authorization_url: urlSchema,
        client_id: clientIdSchema,
        jwks_url: Type.Optional(urlSchema),
        name: teamJwtNameSchema,
        public_key: Type.Optional(Type.String({ maxLength: 16_384, minLength: 1 })),
        secret_env: Type.Optional(
            Type.String({ maxLength: 256, minLength: 1, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
        ),
        refresh_url: Type.Optional(urlSchema),
        scope: Type.Optional(scopeSchema),
        token_url: urlSchema,
        user_id_claim: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
    },
    exact,
);
export type TeamJwtToml = Static<typeof teamJwtTomlSchema>;

/** Resolved JWT team authentication settings. Secrets stay in the environment. */
export const teamJwtConfigSchema = Type.Object(
    {
        algorithms: algorithmsSchema,
        audience: nonEmptySchema,
        authorizationUrl: urlSchema,
        clientId: clientIdSchema,
        issuer: nonEmptySchema,
        key: Type.Union([
            Type.Object({ type: Type.Literal("jwks"), url: urlSchema }, exact),
            Type.Object(
                {
                    pem: Type.String({ maxLength: 16_384, minLength: 1 }),
                    type: Type.Literal("public_key"),
                },
                exact,
            ),
            Type.Object(
                {
                    env: Type.String({ maxLength: 256, minLength: 1 }),
                    type: Type.Literal("secret"),
                },
                exact,
            ),
        ]),
        name: teamJwtNameSchema,
        refreshUrl: Type.Optional(urlSchema),
        scope: Type.Optional(scopeSchema),
        tokenUrl: urlSchema,
        userIdClaim: Type.String({ maxLength: 256, minLength: 1 }),
    },
    exact,
);
export type TeamJwtConfig = Static<typeof teamJwtConfigSchema>;

/** Validate one JWT table's cross-field rules and resolve it, with human-readable failures. */
export function resolveTeamJwtConfig(value: TeamJwtToml): TeamJwtConfig {
    assertBrowserUrl(value.authorization_url, "feature.team.jwt.authorization_url");
    assertBrowserUrl(value.token_url, "feature.team.jwt.token_url");
    if (value.refresh_url !== undefined) {
        assertBrowserUrl(value.refresh_url, "feature.team.jwt.refresh_url");
    }
    const sources = [value.jwks_url, value.public_key, value.secret_env].filter(
        (source) => source !== undefined,
    );
    if (sources.length !== 1) {
        throw new Error(
            "feature.team.jwt must configure exactly one of jwks_url, public_key, or secret_env.",
        );
    }
    let key: TeamJwtConfig["key"];
    if (value.secret_env !== undefined) {
        assertAlgorithms(
            value.algorithms,
            symmetricAlgorithms,
            "secret_env",
            "HS256, HS384, HS512",
        );
        key = { env: value.secret_env, type: "secret" };
    } else {
        assertAlgorithms(
            value.algorithms,
            asymmetricAlgorithms,
            value.jwks_url === undefined ? "public_key" : "jwks_url",
            "RS, PS, ES, and EdDSA",
        );
        if (value.jwks_url !== undefined) {
            assertBrowserUrl(value.jwks_url, "feature.team.jwt.jwks_url");
            key = { type: "jwks", url: value.jwks_url };
        } else {
            try {
                createPublicKey(value.public_key!);
            } catch {
                throw new Error("feature.team.jwt.public_key must be a PEM-encoded public key.");
            }
            key = { pem: value.public_key!, type: "public_key" };
        }
    }
    return {
        algorithms: [...new Set(value.algorithms)],
        audience: value.audience,
        authorizationUrl: value.authorization_url,
        clientId: value.client_id,
        issuer: value.issuer,
        key,
        name: value.name,
        ...(value.refresh_url === undefined ? {} : { refreshUrl: value.refresh_url }),
        ...(value.scope === undefined ? {} : { scope: value.scope }),
        tokenUrl: value.token_url,
        userIdClaim: value.user_id_claim ?? "sub",
    };
}

function assertAlgorithms(
    algorithms: readonly string[],
    allowed: readonly string[],
    source: string,
    description: string,
): void {
    if (!algorithms.every((algorithm) => allowed.includes(algorithm))) {
        throw new Error(`feature.team.jwt.${source} accepts only the ${description} algorithms.`);
    }
}

function assertBrowserUrl(value: string, name: string): void {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} must be an absolute URL.`);
    }
    const loopback =
        url.hostname === "localhost" ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
    ) {
        throw new Error(
            `${name} must use https, or http only for a loopback host, without credentials or a fragment.`,
        );
    }
}
