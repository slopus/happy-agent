import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    authenticationQuerySchema,
    authenticationResponseSchema,
} from "../sources/protocol/authentication.js";
import { readAuthenticationCallback } from "../sources/readAuthenticationCallback.js";

const browser = {
    type: "browser",
    id: "jwt",
    name: "Acme SSO",
    url: "https://sso.acme.example/happy/login?redirect_uri=happy%3A%2F%2Fauth&state=k3v9",
} as const;

function recordingFetch(response: () => Response): {
    fetch: typeof globalThis.fetch;
    requests: { url: string; headers: Headers }[];
} {
    const requests: { url: string; headers: Headers }[] = [];
    return {
        requests,
        fetch: async (input, init) => {
            requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
            return response();
        },
    };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("authentication discovery", () => {
    it("asks without a token and forwards the redirect and state", async () => {
        const { fetch, requests } = recordingFetch(() =>
            json({ authenticated: false, userId: null, methods: [browser] }),
        );
        const client = new HappyAgentClient({ endpoint: "http://team.example/", fetch });

        const result = await client.getAuthentication({
            redirectUri: "happy://auth",
            state: "k3v9",
        });

        expect(result).toEqual({ authenticated: false, userId: null, methods: [browser] });
        expect(requests).toHaveLength(1);
        expect(requests[0]!.headers.has("authorization")).toBe(false);
        const url = new URL(requests[0]!.url);
        expect(url.pathname).toBe("/v0/authentication");
        expect(url.searchParams.get("redirectUri")).toBe("happy://auth");
        expect(url.searchParams.get("state")).toBe("k3v9");
    });

    it("sends the bearer token when it has one and skips unknown method types", async () => {
        const { fetch, requests } = recordingFetch(() =>
            json({
                authenticated: true,
                userId: "user-local-id",
                methods: [{ type: "device_code", id: "future", name: "Later" }, browser],
            }),
        );
        const client = new HappyAgentClient({
            endpoint: "http://team.example/",
            token: "t",
            fetch,
        });

        const result = await client.getAuthentication();

        expect(requests[0]!.headers.get("authorization")).toBe("Bearer t");
        expect(result.methods).toEqual([browser]);
    });

    it("exposes the sign-in methods offered by a 401", async () => {
        const { fetch } = recordingFetch(() =>
            json(
                {
                    error: "Unauthorized",
                    code: "unauthorized",
                    authentication: { methods: [browser, { type: "future" }] },
                },
                401,
            ),
        );
        const client = new HappyAgentClient({
            endpoint: "http://team.example/",
            token: "x",
            fetch,
        });

        const error = await client.getHealth().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect((error as HappyAgentApiError).authentication).toEqual({ methods: [browser] });
    });

    it("has no challenge on a 401 without one or on other failures", () => {
        expect(
            new HappyAgentApiError(401, "Unauthorized", "unauthorized", null).authentication,
        ).toBe(null);
        expect(
            new HappyAgentApiError(403, "Forbidden", "forbidden", {
                authentication: { methods: [browser] },
            }).authentication,
        ).toBe(null);
    });

    it("validates the documented shapes", () => {
        expect(
            Value.Check(authenticationResponseSchema, {
                authenticated: false,
                userId: null,
                methods: [browser],
            }),
        ).toBe(true);
        expect(Value.Check(authenticationQuerySchema, { state: "" })).toBe(false);
        expect(Value.Check(authenticationQuerySchema, { redirectUri: "x".repeat(2049) })).toBe(
            false,
        );
    });
});

describe("readAuthenticationCallback", () => {
    it("returns the token when the state matches", () => {
        expect(
            readAuthenticationCallback("happy://auth#token=abc.def.ghi&state=k3v9", "k3v9"),
        ).toBe("abc.def.ghi");
        expect(readAuthenticationCallback("http://127.0.0.1:5000/cb#token=abc")).toBe("abc");
    });

    it("rejects a missing token or a mismatched state", () => {
        expect(() => readAuthenticationCallback("happy://auth#state=k3v9", "k3v9")).toThrow(
            /does not contain a token/,
        );
        expect(() =>
            readAuthenticationCallback("happy://auth#token=a&state=other", "k3v9"),
        ).toThrow(/does not match/);
        expect(() => readAuthenticationCallback("happy://auth#token=a", "k3v9")).toThrow(
            /does not match/,
        );
        expect(() => readAuthenticationCallback("happy://auth?token=a")).toThrow(
            /does not contain a token/,
        );
    });
});
