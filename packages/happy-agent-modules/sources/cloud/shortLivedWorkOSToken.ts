import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decodeJwt } from "jose";

const claimsSchema = Type.Object(
    {
        client_id: Type.String(),
        exp: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000 }),
        iat: Type.Integer({ minimum: 0 }),
        iss: Type.String(),
        org_id: Type.String(),
        sid: Type.String({ minLength: 1 }),
        sub: Type.String(),
    },
    { additionalProperties: true },
);

export const shortLivedWorkOSTokenSchema = Type.Object(
    {
        accessToken: Type.String({ minLength: 1, maxLength: 32_768 }),
        expiresAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type ShortLivedWorkOSToken = Static<typeof shortLivedWorkOSTokenSchema>;

/** Inspect only a token already authenticated through Cloud's refresh-and-verify boundary. */
export function shortLivedWorkOSToken(
    accessToken: string,
    organizationId: string,
    userId: string,
    clientId: string,
): ShortLivedWorkOSToken {
    let claims: unknown;
    try {
        claims = decodeJwt(accessToken);
    } catch {
        throw new Error("WorkOS returned an invalid access token; no token was released.");
    }
    if (
        !Value.Check(claimsSchema, claims) ||
        claims.org_id !== organizationId ||
        claims.sub !== userId ||
        claims.client_id !== clientId ||
        claims.iss !== `https://api.workos.com/user_management/${clientId}`
    ) {
        throw new Error("WorkOS returned unexpected access token claims; no token was released.");
    }
    const now = Date.now() / 1_000;
    if (claims.iat > now || claims.exp <= now || claims.exp <= claims.iat) {
        throw new Error(
            "WorkOS returned an access token that is not currently valid; no token was released.",
        );
    }
    if (claims.exp - claims.iat > 300 || claims.exp - now > 300) {
        throw new Error(
            "WorkOS issued an access token lasting longer than five minutes; no token was released. Set Access token duration to five minutes or less in the WorkOS application's Sessions settings before trying again.",
        );
    }
    return { accessToken, expiresAt: claims.exp * 1_000 };
}
