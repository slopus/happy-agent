import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const exact = { additionalProperties: false } as const;
const identity = Type.String({ minLength: 1, maxLength: 512 });
const scopeSchema = Type.Object(
    { principalId: identity, workspaceId: identity, serviceId: identity, executionId: identity },
    exact,
);
type ServiceAccessScope = Static<typeof scopeSchema>;
const payloadSchema = Type.Object(
    {
        ...scopeSchema.properties,
        version: Type.Literal(1),
        issuedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        nonce: Type.String({ pattern: "^[A-Za-z0-9_-]{22}$" }),
    },
    exact,
);
const tokenSchema = Type.String({
    maxLength: 6144,
    pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$",
});
const codeSchema = Type.Union([Type.Literal("unauthorized"), Type.Literal("forbidden")]);
const ESTABLISHMENT_LIFETIME_MS = 5 * 60_000;

/** No credential or decoded payload is included in the error. */
export class ServiceAccessError extends Error {
    constructor(readonly code: Static<typeof codeSchema>) {
        super(
            code === "unauthorized"
                ? "The service access credential is missing, invalid, or expired."
                : "The service access credential belongs to a different scope.",
        );
        this.name = "ServiceAccessError";
    }
}

/**
 * One daemon-lifetime issuer. Stateless tokens have bounded size and five-minute establishment
 * expiry. The owner must also check live admission immediately before attaching: a valid signature
 * is not a grant to revive a stopped execution. Never expose this issuer to tools or page code.
 */
export class ServiceAccessTokens {
    readonly #key = randomBytes(32);

    issue(scope: ServiceAccessScope): { accessToken: string; expiresAt: number } {
        if (!Value.Check(scopeSchema, scope)) throw new ServiceAccessError("forbidden");
        const issuedAt = Date.now();
        const expiresAt = issuedAt + ESTABLISHMENT_LIFETIME_MS;
        const payload: Static<typeof payloadSchema> = {
            ...scope,
            version: 1,
            issuedAt,
            expiresAt,
            nonce: randomBytes(16).toString("base64url"),
        };
        const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
        const accessToken = `${encoded}.${this.#signature(encoded).toString("base64url")}`;
        if (!Value.Check(tokenSchema, accessToken)) throw new ServiceAccessError("forbidden");
        return { accessToken, expiresAt };
    }

    authorize(accessToken: string | undefined, scope: ServiceAccessScope): void {
        if (!Value.Check(scopeSchema, scope)) throw new ServiceAccessError("forbidden");
        if (!Value.Check(tokenSchema, accessToken)) throw new ServiceAccessError("unauthorized");
        const separator = accessToken.indexOf(".");
        const encoded = accessToken.slice(0, separator);
        const signature = accessToken.slice(separator + 1);
        const decodedSignature = Buffer.from(signature, "base64url");
        if (
            decodedSignature.toString("base64url") !== signature ||
            decodedSignature.length !== 32 ||
            !timingSafeEqual(decodedSignature, this.#signature(encoded))
        ) {
            throw new ServiceAccessError("unauthorized");
        }
        let payload: unknown;
        try {
            payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        } catch {
            throw new ServiceAccessError("unauthorized");
        }
        const now = Date.now();
        if (
            !Value.Check(payloadSchema, payload) ||
            payload.issuedAt > now ||
            payload.expiresAt <= now ||
            payload.expiresAt - payload.issuedAt !== ESTABLISHMENT_LIFETIME_MS
        ) {
            throw new ServiceAccessError("unauthorized");
        }
        if (
            payload.principalId !== scope.principalId ||
            payload.workspaceId !== scope.workspaceId ||
            payload.serviceId !== scope.serviceId ||
            payload.executionId !== scope.executionId
        ) {
            throw new ServiceAccessError("forbidden");
        }
    }

    #signature(encoded: string): Buffer {
        return createHmac("sha256", this.#key).update(encoded).digest();
    }
}
