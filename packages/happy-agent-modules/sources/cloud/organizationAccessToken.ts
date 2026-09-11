import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decodeJwt } from "jose";

const claimsSchema = Type.Object(
    {
        client_id: Type.String(),
        exp: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000 }),
        iat: Type.Integer({ minimum: 0 }),
        iss: Type.String(),
        org_id: Type.String(),
        sub: Type.String(),
    },
    { additionalProperties: true },
);

/** Inspect only a credential already authenticated by Cloud's refresh-and-verify boundary. */
export function organizationAccessToken(
    accessToken: string,
    organizationId: string,
    userId: string,
    clientId: string,
) {
    let claims: unknown;
    try {
        claims = decodeJwt(accessToken);
    } catch {
        return undefined;
    }
    const now = Date.now() / 1_000;
    if (
        !Value.Check(claimsSchema, claims) ||
        claims.org_id !== organizationId ||
        claims.sub !== userId ||
        claims.client_id !== clientId ||
        claims.iss !== `https://api.workos.com/user_management/${clientId}` ||
        claims.iat > now ||
        claims.exp <= now ||
        claims.exp <= claims.iat
    ) {
        return undefined;
    }
    return { accessToken, expiresAt: claims.exp * 1_000, issuedAt: claims.iat * 1_000 };
}

export type OrganizationAccessToken = NonNullable<ReturnType<typeof organizationAccessToken>>;
