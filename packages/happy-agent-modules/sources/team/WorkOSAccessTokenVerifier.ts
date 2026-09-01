import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Value } from "@sinclair/typebox/value";

import { workOSUserIdSchema } from "./TeamUser.js";

export const HAPPY_CLOUD_PRODUCTION_WORKOS_CLIENT_ID = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
export const HAPPY_CLOUD_PRODUCTION_WORKOS_ISSUER = `https://api.workos.com/user_management/${HAPPY_CLOUD_PRODUCTION_WORKOS_CLIENT_ID}`;
export const HAPPY_CLOUD_PRODUCTION_WORKOS_JWKS_URL = `https://api.workos.com/sso/jwks/${HAPPY_CLOUD_PRODUCTION_WORKOS_CLIENT_ID}`;

export interface WorkOSAccessTokenVerifierOptions {
    readonly clientId?: string;
    readonly issuer?: string;
    readonly jwks?: JWTVerifyGetKey;
    readonly organizationId: string;
}

export interface WorkOSIdentity {
    readonly organizationId: string;
    readonly userId: string;
}

/** Verify a WorkOS access token locally, returning its user and organization identity. */
export class WorkOSAccessTokenVerifier {
    readonly #clientId: string;
    readonly #issuer: string;
    readonly #jwks: JWTVerifyGetKey;
    readonly #organizationId: string;

    constructor(options: WorkOSAccessTokenVerifierOptions) {
        this.#clientId = options.clientId ?? HAPPY_CLOUD_PRODUCTION_WORKOS_CLIENT_ID;
        this.#issuer =
            options.issuer ??
            `https://api.workos.com/user_management/${encodeURIComponent(this.#clientId)}`;
        this.#jwks =
            options.jwks ??
            createRemoteJWKSet(
                new URL(`https://api.workos.com/sso/jwks/${encodeURIComponent(this.#clientId)}`),
            );
        this.#organizationId = options.organizationId;
    }

    async verify(accessToken: string): Promise<WorkOSIdentity> {
        const { payload } = await jwtVerify(accessToken, this.#jwks, {
            algorithms: ["RS256"],
            issuer: this.#issuer,
            requiredClaims: ["exp", "iat", "sub", "client_id", "sid", "org_id"],
        });
        if (
            payload.client_id !== this.#clientId ||
            payload.org_id !== this.#organizationId ||
            !Value.Check(workOSUserIdSchema, payload.sub) ||
            typeof payload.sid !== "string"
        ) {
            throw new Error("The WorkOS access token claims are invalid.");
        }
        return { organizationId: this.#organizationId, userId: payload.sub };
    }
}
