import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { organizationAccessToken } from "../../sources/cloud/organizationAccessToken.js";

const claims = {
    client_id: "client_test",
    exp: 1_300,
    iat: 1_000,
    iss: "https://api.workos.com/user_management/client_test",
    org_id: "org_test",
    sub: "user_test",
};

function token(overrides: Record<string, unknown> = {}) {
    return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
        JSON.stringify({ ...claims, ...overrides }),
    ).toString("base64url")}.test-signature`;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
});

afterEach(() => vi.useRealTimers());

describe("organizationAccessToken", () => {
    it("retains the actual lifetime of an already verified token without a five-minute restriction", () => {
        const accessToken = token({ exp: 4_600 });
        expect(
            organizationAccessToken(accessToken, "org_test", "user_test", "client_test"),
        ).toEqual({
            accessToken,
            issuedAt: 1_000_000,
            expiresAt: 4_600_000,
        });
    });

    it.each([
        { org_id: "org_other" },
        { sub: "user_other" },
        { client_id: "client_other" },
        { iss: "https://untrusted.example" },
        { exp: undefined },
        { exp: "1300" },
        { exp: 1_000 },
        { exp: 999 },
        { iat: 1_001 },
        { iat: -1 },
        { iat: undefined },
    ])("rejects unexpected or invalid claims: %j", (overrides) => {
        expect(
            organizationAccessToken(token(overrides), "org_test", "user_test", "client_test"),
        ).toBeUndefined();
    });

    it("rejects malformed tokens without exposing their contents", () => {
        expect(
            organizationAccessToken(
                "private-invalid-token",
                "org_test",
                "user_test",
                "client_test",
            ),
        ).toBeUndefined();
    });
});
