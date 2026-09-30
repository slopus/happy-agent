import type { KeyObject } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import { jwtVerify, type JWTVerifyGetKey } from "jose";

import { teamSubjectSchema } from "./TeamUser.js";

/** Time comparisons tolerate this much clock skew between the issuer and the daemon. */
const CLOCK_TOLERANCE_SECONDS = 30;

export interface JwtAccessTokenVerifierOptions {
    readonly algorithms: readonly string[];
    readonly audience: string;
    readonly issuer: string;
    /** A remote key set, a static public key, or a shared secret. */
    readonly key: JWTVerifyGetKey | KeyObject | Uint8Array;
    readonly userIdClaim: string;
}

/** Verify a deployer-issued JWT locally, returning the user ID from its configured claim. */
export class JwtAccessTokenVerifier {
    readonly #options: JwtAccessTokenVerifierOptions;

    constructor(options: JwtAccessTokenVerifierOptions) {
        this.#options = options;
    }

    async verify(accessToken: string): Promise<string> {
        const options = {
            algorithms: [...this.#options.algorithms],
            audience: this.#options.audience,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            issuer: this.#options.issuer,
            requiredClaims: ["exp"],
        };
        const key = this.#options.key;
        const { payload } =
            typeof key === "function"
                ? await jwtVerify(accessToken, key, options)
                : await jwtVerify(accessToken, key, options);
        if (
            payload.iat !== undefined &&
            payload.iat > Date.now() / 1_000 + CLOCK_TOLERANCE_SECONDS
        ) {
            throw new Error("The JWT was issued in the future.");
        }
        const subject = payload[this.#options.userIdClaim];
        if (!Value.Check(teamSubjectSchema, subject)) {
            throw new Error("The JWT user ID claim is invalid.");
        }
        return subject;
    }
}
