import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceAccessTokens } from "../../../sources/services/impl/ServiceAccessTokens.js";

const scope = {
    principalId: "principal-one",
    workspaceId: "workspace-one",
    serviceId: "service-one",
    executionId: "execution-one",
};

afterEach(() => vi.useRealTimers());

describe("service establishment credentials", () => {
    it("issues unpredictable credentials scoped to the same live execution", () => {
        const issuer = new ServiceAccessTokens();
        const first = issuer.issue(scope);
        const second = issuer.issue(scope);
        expect(first.accessToken).not.toBe(second.accessToken);
        expect(() => issuer.authorize(first.accessToken, scope)).not.toThrow();
        expect(() => issuer.authorize(second.accessToken, scope)).not.toThrow();
    });

    it.each(["principalId", "workspaceId", "serviceId", "executionId"])(
        "refuses a valid credential with a different %s",
        (field) => {
            const issuer = new ServiceAccessTokens();
            const { accessToken } = issuer.issue(scope);
            expect(() => issuer.authorize(accessToken, { ...scope, [field]: "another" })).toThrow(
                expect.objectContaining({ code: "forbidden" }),
            );
        },
    );

    it("expires exactly five minutes after issuance", () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_800_000_000_000);
        const issuer = new ServiceAccessTokens();
        const { accessToken, expiresAt } = issuer.issue(scope);
        expect(expiresAt).toBe(Date.now() + 300_000);
        vi.setSystemTime(expiresAt - 1);
        expect(() => issuer.authorize(accessToken, scope)).not.toThrow();
        vi.setSystemTime(expiresAt);
        expect(() => issuer.authorize(accessToken, scope)).toThrow(
            expect.objectContaining({ code: "unauthorized" }),
        );
    });

    it("invalidates credentials when the daemon-lifetime issuer is replaced", () => {
        const { accessToken } = new ServiceAccessTokens().issue(scope);
        expect(() => new ServiceAccessTokens().authorize(accessToken, scope)).toThrow(
            expect.objectContaining({ code: "unauthorized" }),
        );
    });

    it("refuses payload tampering before interpreting its scope", () => {
        const issuer = new ServiceAccessTokens();
        const { accessToken } = issuer.issue(scope);
        const [encoded, signature] = accessToken.split(".");
        const changed = Buffer.from(encoded!, "base64url")
            .toString("utf8")
            .replace("workspace-one", "workspace-two");
        const tampered = `${Buffer.from(changed).toString("base64url")}.${signature}`;
        expect(() =>
            issuer.authorize(tampered, { ...scope, workspaceId: "workspace-two" }),
        ).toThrow(expect.objectContaining({ code: "unauthorized" }));
    });

    it.each([undefined, "", "invalid", "a.b.c", "a.A", "a".repeat(6145)])(
        "refuses missing, malformed, or oversized credentials without reflecting them",
        (token) => {
            const issuer = new ServiceAccessTokens();
            expect(() => issuer.authorize(token, scope)).toThrow(
                expect.objectContaining({
                    code: "unauthorized",
                    message: "The service access credential is missing, invalid, or expired.",
                }),
            );
        },
    );
});
