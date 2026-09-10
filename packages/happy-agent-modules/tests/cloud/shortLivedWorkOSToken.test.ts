import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";

import { shortLivedWorkOSToken } from "../../sources/cloud/shortLivedWorkOSToken.js";
import { WorkOSAccessTokenVerifier } from "../../sources/team/WorkOSAccessTokenVerifier.js";

const now = 1_800_000_000;
const clientId = "client_test";
const claims = {
    client_id: clientId,
    exp: now + 300,
    iat: now,
    iss: `https://api.workos.com/user_management/${clientId}`,
    org_id: "org_target",
    sid: "session_test",
    sub: "user_TEST123",
};

// Cloud verification is a precondition of this helper, not something decodeJwt provides.
function token(overrides: Record<string, unknown> = {}): string {
    return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
        JSON.stringify({ ...claims, ...overrides }),
    ).toString("base64url")}.test-signature`;
}

afterEach(() => vi.useRealTimers());

describe("shortLivedWorkOSToken", () => {
    it("returns the actual expiry, including time already spent verifying the token", () => {
        vi.useFakeTimers({ now: (now + 12) * 1_000 });
        const accessToken = token();
        expect(shortLivedWorkOSToken(accessToken, "org_target", claims.sub, clientId)).toEqual({
            accessToken,
            expiresAt: (now + 300) * 1_000,
        });
    });

    it.each([
        { exp: now + 301 },
        { iat: now - 301, exp: now + 1 },
        { exp: now },
        { exp: now - 1 },
        { iat: now + 1 },
        { iat: undefined },
        { exp: undefined },
        { exp: "1800000300" },
        { exp: now + 0.5 },
        { org_id: "org_other" },
        { org_id: undefined },
        { sub: "user_OTHER" },
        { client_id: "client_other" },
        { iss: "https://untrusted.example/" },
        { sid: "" },
    ])("withholds invalid or overly long-lived credentials: %j", (overrides) => {
        vi.useFakeTimers({ now: now * 1_000 });
        const accessToken = token(overrides);
        try {
            shortLivedWorkOSToken(accessToken, "org_target", claims.sub, clientId);
            expect.fail("An invalid token was released.");
        } catch (error) {
            expect(String(error)).toContain("no token was released");
            expect(String(error)).not.toContain(accessToken);
        }
    });

    it("withholds malformed tokens without exposing the input", () => {
        expect(() => shortLivedWorkOSToken("secret", "org_target", claims.sub, clientId)).toThrow(
            "invalid access token; no token was released",
        );
    });

    it("releases a signed token accepted by a team node and rejected at its five-minute expiry", async () => {
        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const accessToken = await new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256" })
            .sign(privateKey);
        const verifier = new WorkOSAccessTokenVerifier({
            clientId,
            organizationId: "org_target",
            jwks: async () => publicKey,
        });
        vi.useFakeTimers({ now: now * 1_000 });
        const result = shortLivedWorkOSToken(accessToken, "org_target", claims.sub, clientId);
        await expect(verifier.verify(result.accessToken)).resolves.toEqual({
            organizationId: "org_target",
            userId: claims.sub,
        });
        vi.setSystemTime(result.expiresAt);
        await expect(verifier.verify(result.accessToken)).rejects.toThrow();
    });
});
