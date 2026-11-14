import {
    createRemoteJWKSet,
    decodeProtectedHeader,
    errors,
    jwtVerify,
    type JWTPayload,
    type JWTVerifyGetKey,
} from "jose";

const MAX_TOKEN_LENGTH = 8_192;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;

/** The one identity a forwarded request must prove: this machine and the account that owns it. */
export interface LinkedIdentity {
    readonly accountId: string;
    readonly endpointId: string;
}

/**
 * Why a relay token was refused. `unauthenticated` is a token that proves nothing (absent,
 * malformed, forged, expired); `forbidden` is a genuine accounts token that is not the owner's
 * relay token for this machine; `unverifiable` means the signing keys could not be fetched.
 */
export type RelayTokenRefusal = "unauthenticated" | "forbidden" | "unverifiable";

export type RelayTokenDecision =
    | { readonly allowed: true; readonly expiresAt: number }
    | { readonly allowed: false; readonly refusal: RelayTokenRefusal };

/**
 * Verifies accounts-issued tokens against the accounts key set. This is the daemon's own check:
 * the relay verified the same token, but the relay is not trusted to decide who the owner is.
 */
export class AccountTokenVerifier {
    readonly #issuer: string;
    readonly #keys: JWTVerifyGetKey;
    readonly #relayUrl: string;

    constructor(accountsUrl: string, relayUrl: string) {
        this.#issuer = accountsUrl;
        this.#relayUrl = relayUrl;
        this.#keys = createRemoteJWKSet(new URL("/.well-known/jwks.json", accountsUrl), {
            cacheMaxAge: 600_000,
            cooldownDuration: 30_000,
            timeoutDuration: 5_000,
        });
    }

    /**
     * Decide whether an `Authorization` header carries the owner's relay token for `identity`.
     * Every claim is compared exactly; nothing here is inferred from the token's shape.
     */
    async verifyRelayAuthorization(
        authorization: string | readonly string[] | undefined,
        identity: LinkedIdentity,
    ): Promise<RelayTokenDecision> {
        const token =
            typeof authorization === "string" ? BEARER_PATTERN.exec(authorization)?.[1] : undefined;
        if (token === undefined) return { allowed: false, refusal: "unauthenticated" };
        let payload: JWTPayload;
        try {
            payload = await this.#verify(token, `${this.#relayUrl}/e/${identity.endpointId}`);
        } catch (error) {
            return { allowed: false, refusal: verificationRefusal(error) };
        }
        if (
            payload.typ !== "relay" ||
            payload.eid !== identity.endpointId ||
            payload.sub !== identity.accountId ||
            // A token exchanged for a third party acts for the owner but is not the owner.
            "act" in payload
        ) {
            return { allowed: false, refusal: "forbidden" };
        }
        return { allowed: true, expiresAt: expiryMs(payload) };
    }

    /** Verify this machine's own endpoint token and read who it says the machine belongs to. */
    async verifyEndpointToken(
        token: string,
    ): Promise<LinkedIdentity & { readonly expiresAt: number }> {
        const payload = await this.#verify(token, `${this.#relayUrl}/`);
        if (
            payload.typ !== "endpoint" ||
            typeof payload.eid !== "string" ||
            payload.eid === "" ||
            typeof payload.sub !== "string" ||
            payload.sub === ""
        ) {
            throw new Error("Happy accounts returned a token that is not an endpoint token.");
        }
        return { accountId: payload.sub, endpointId: payload.eid, expiresAt: expiryMs(payload) };
    }

    async #verify(token: string, audience: string): Promise<JWTPayload> {
        if (token.length > MAX_TOKEN_LENGTH) throw new errors.JWTInvalid("The token is too long.");
        // Refuse before any key lookup: only EdDSA, and only a key the token names. Without a
        // `kid`, a key set holding a single key would be tried for whatever token arrived.
        const header = decodeProtectedHeader(token);
        if (header.alg !== "EdDSA" || typeof header.kid !== "string" || header.kid === "") {
            throw new errors.JOSEAlgNotAllowed("Only EdDSA tokens naming their key are accepted.");
        }
        const { payload } = await jwtVerify(token, this.#keys, {
            algorithms: ["EdDSA"],
            audience,
            issuer: this.#issuer,
            requiredClaims: ["aud", "exp", "iss", "sub"],
        });
        // jose accepts an audience list that merely contains ours; a relay token names one.
        if (payload.aud !== audience) {
            throw new errors.JWTClaimValidationFailed("The audience is not exact.", payload, "aud");
        }
        return payload;
    }
}

function expiryMs(payload: JWTPayload): number {
    // `requiredClaims` and jose's own check guarantee a numeric, unexpired `exp`.
    return (payload.exp ?? 0) * 1_000;
}

function verificationRefusal(error: unknown): RelayTokenRefusal {
    if (error instanceof errors.JWTClaimValidationFailed) {
        // The signature is genuine; the token is for someone or something else.
        return error.claim === "aud" || error.claim === "iss" ? "forbidden" : "unauthenticated";
    }
    // jose reports a key set it could not load as a timeout, an invalid set, or its base error.
    if (
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid ||
        (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC")
    ) {
        return "unverifiable";
    }
    if (error instanceof errors.JOSEError) return "unauthenticated";
    // Anything else is the key set request itself failing.
    return "unverifiable";
}
