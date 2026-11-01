import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    beginOAuthSignIn,
    completeOAuthSignIn,
    refreshOAuthCredential,
    type OAuthCredential,
} from "../sources/oauthSignIn.js";
import {
    oauthAuthenticationMethodSchema,
    type OAuthAuthenticationMethod,
} from "../sources/protocol/authentication.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import { EventStreamProtocolError } from "../sources/readEventStream.js";
import {
    isHappyErrorBody,
    responseRequiresSignIn,
    statusRequiresSignIn,
} from "../sources/requiresSignIn.js";
import { watchStreamIdle } from "../sources/watchStreamIdle.js";

const RESOURCE = "https://happy.acme.example";
const METHOD: OAuthAuthenticationMethod = {
    type: "oauth",
    id: "jwt",
    name: "Acme SSO",
    authorizationUrl: "https://sso.acme.example/oauth/authorize",
    tokenUrl: "https://sso.acme.example/oauth/token",
    refreshUrl: "https://sso.acme.example/oauth/token",
    clientId: "happy",
    resource: RESOURCE,
};
const REDIRECT = "happy://oauth/callback";
const CURSOR_1 = "01900000-0000-7000-8000-000000000001";

afterEach(() => {
    vi.useRealTimers();
});

function json(body: unknown, status = 200, contentType = "application/json"): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

function form(init: RequestInit | undefined): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
}

describe("RFC 8707 resource", () => {
    it("is an optional discovery field", () => {
        expect(Value.Check(oauthAuthenticationMethodSchema, METHOD)).toBe(true);
        const { resource: _resource, ...without } = METHOD;
        expect(Value.Check(oauthAuthenticationMethodSchema, without)).toBe(true);
    });

    it("is sent on authorization, code exchange, and refresh, as recorded at sign-in", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT });
        expect(new URL(signIn.url).searchParams.get("resource")).toBe(RESOURCE);

        const bodies: Record<string, string>[] = [];
        const fetch: typeof globalThis.fetch = async (_input, init) => {
            bodies.push(form(init));
            return json({ access_token: "a", token_type: "Bearer", refresh_token: "r" });
        };
        const credential = await completeOAuthSignIn(
            signIn,
            `${REDIRECT}?code=c&state=${signIn.state}`,
            { fetch },
        );
        expect(bodies[0]).toMatchObject({ resource: RESOURCE, redirect_uri: REDIRECT });
        expect(credential.resource).toBe(RESOURCE);

        const refreshed = await refreshOAuthCredential(credential, { fetch });
        expect(bodies[1]).toEqual({
            grant_type: "refresh_token",
            refresh_token: "r",
            client_id: "happy",
            resource: RESOURCE,
        });
        expect(refreshed.resource).toBe(RESOURCE);
    });

    it("is never sent when the method names none, including for older stored credentials", async () => {
        const { resource: _resource, ...method } = METHOD;
        const signIn = await beginOAuthSignIn(method, { redirectUri: REDIRECT });
        expect(new URL(signIn.url).searchParams.has("resource")).toBe(false);
        const stored: OAuthCredential = {
            accessToken: "a",
            clientId: "happy",
            expiresAt: null,
            refreshToken: "r",
            refreshUrl: METHOD.refreshUrl!,
        };
        let body: Record<string, string> = {};
        const refreshed = await refreshOAuthCredential(stored, {
            fetch: async (_input, init) => {
                body = form(init);
                return json({ access_token: "b", token_type: "Bearer" });
            },
        });
        expect(body).not.toHaveProperty("resource");
        expect(refreshed).not.toHaveProperty("resource");
    });

    it("refuses a resource that is not an absolute URI without a fragment", async () => {
        for (const resource of ["not a uri", "https://happy.acme.example/#api"]) {
            await expect(
                beginOAuthSignIn({ ...METHOD, resource }, { redirectUri: REDIRECT }),
            ).rejects.toMatchObject({ code: "invalid_response" });
        }
    });
});

describe("signing in again", () => {
    it("recognizes only the daemon's own JSON errors", () => {
        const body = { error: "Forbidden.", code: "forbidden" };
        expect(isHappyErrorBody("application/json; charset=utf-8", body)).toBe(true);
        expect(isHappyErrorBody("text/html", body)).toBe(false);
        expect(isHappyErrorBody(null, body)).toBe(false);
        expect(isHappyErrorBody("application/json", { message: "Forbidden" })).toBe(false);
        expect(isHappyErrorBody("application/json", [body])).toBe(false);
    });

    it("classifies redirects, 401s, and foreign 403s as sign-in", () => {
        expect(statusRequiresSignIn(302, false)).toBe(true);
        expect(statusRequiresSignIn(307, true)).toBe(true);
        expect(statusRequiresSignIn(0, false, true)).toBe(true);
        expect(statusRequiresSignIn(401, true)).toBe(true);
        expect(statusRequiresSignIn(401, false)).toBe(true);
        expect(statusRequiresSignIn(403, false)).toBe(true);
        expect(statusRequiresSignIn(403, true)).toBe(false);
        expect(statusRequiresSignIn(304, false)).toBe(false);
        expect(statusRequiresSignIn(404, false)).toBe(false);
        expect(statusRequiresSignIn(503, false)).toBe(false);
        expect(
            responseRequiresSignIn(json({ error: "No.", code: "forbidden" }, 403), {
                error: "No.",
                code: "forbidden",
            }),
        ).toBe(false);
        expect(responseRequiresSignIn(new Response("<html>", { status: 403 }))).toBe(true);
    });

    it("never follows redirects and reports an edge redirect as sign-in", async () => {
        let redirect: RequestRedirect | undefined;
        const client = new HappyAgentClient({
            endpoint: "https://happy.acme.example/",
            token: "t",
            fetch: async (_input, init) => {
                redirect = init?.redirect;
                return new Response(null, {
                    status: 302,
                    headers: { location: "https://sso.acme.example/login" },
                });
            },
        });

        const error = (await client
            .getHealth()
            .catch((caught: unknown) => caught)) as HappyAgentApiError;

        expect(redirect).toBe("manual");
        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect(error).toMatchObject({ status: 302, happyError: false, signInRequired: true });
        expect(error.message).toBe("The server redirected the request. Sign in again.");
    });

    it("treats an opaque browser redirect as sign-in", async () => {
        const opaque = new Response(null, { status: 200 });
        Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
        Object.defineProperty(opaque, "status", { value: 0 });
        Object.defineProperty(opaque, "ok", { value: false });
        const client = new HappyAgentClient({
            endpoint: "https://happy.acme.example/",
            token: "t",
            fetch: async () => opaque,
        });

        await expect(client.getHealth()).rejects.toMatchObject({ signInRequired: true });
    });

    it("keeps the sign-in for the daemon's own 403 but not for an edge 403", async () => {
        const answers = [
            json({ error: "Only owners may do that.", code: "forbidden" }, 403),
            new Response("<html>Access denied</html>", {
                status: 403,
                headers: { "content-type": "text/html" },
            }),
        ];
        const client = new HappyAgentClient({
            endpoint: "https://happy.acme.example/",
            token: "t",
            fetch: async () => answers.shift()!,
        });

        await expect(client.getHealth()).rejects.toMatchObject({
            code: "forbidden",
            happyError: true,
            signInRequired: false,
        });
        await expect(client.getHealth()).rejects.toMatchObject({
            code: null,
            happyError: false,
            signInRequired: true,
        });
    });

    it("tells a following feed that the stream needs a new sign-in, then recovers", async () => {
        vi.useFakeTimers();
        const responses = [
            new Response(null, { status: 302, headers: { location: "https://sso.example/" } }),
            new Response(null, { status: 302, headers: { location: "https://sso.example/" } }),
            new Response(
                `event: hello\ndata: ${JSON.stringify({ connectedAt: 1, cursor: CURSOR_1, gap: false, resumed: false })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
        ];
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "https://happy.acme.example/",
            token: "t",
            fetch: async () => responses.shift()!,
        });
        const updates = client.updates({ signal: controller.signal });

        await expect(updates.next()).resolves.toEqual({
            done: false,
            value: { kind: "disconnected", signInRequired: true },
        });
        const reconnected = updates.next();
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(200);
        await expect(reconnected).resolves.toEqual({
            done: false,
            value: { kind: "connected", cursor: CURSOR_1 },
        });
        controller.abort();
    });
});

describe("stream keepalive", () => {
    it("passes bytes through and fails a stream that goes quiet", async () => {
        vi.useFakeTimers();
        let push: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
        let cancelled = false;
        const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                push = controller;
            },
            cancel() {
                cancelled = true;
            },
        });
        const reader = watchStreamIdle(source, 45_000, () => new Error("quiet")).getReader();

        push!.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        await expect(reader.read()).resolves.toMatchObject({ done: false });
        await vi.advanceTimersByTimeAsync(44_000);
        push!.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        await expect(reader.read()).resolves.toMatchObject({ done: false });
        const quiet = expect(reader.read()).rejects.toThrow("quiet");
        await vi.advanceTimersByTimeAsync(44_000);
        expect(cancelled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);

        await quiet;
        expect(cancelled).toBe(true);
    });

    it("ends the event stream after 45 seconds without a heartbeat", async () => {
        vi.useFakeTimers();
        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        `event: hello\ndata: ${JSON.stringify({ connectedAt: 1, cursor: CURSOR_1, gap: false, resumed: false })}\n\n`,
                    ),
                );
            },
        });
        const client = new HappyAgentClient({
            endpoint: "https://happy.acme.example/",
            token: "t",
            fetch: async () =>
                new Response(body, { headers: { "content-type": "text/event-stream" } }),
        });
        const stream = client.streamEvents();

        await expect(stream.next()).resolves.toMatchObject({ value: { kind: "hello" } });
        const dead = expect(stream.next()).rejects.toBeInstanceOf(EventStreamProtocolError);
        await vi.advanceTimersByTimeAsync(45_000);
        await dead;
    });
});

describe("WebSocket tunnels", () => {
    it("addresses the WebSocket twin of every proxy tunnel", () => {
        const client = new HappyAgentClient({ endpoint: "https://happy.acme.example/base" });
        const paths = [
            client.workspaceProxyWebSocketUrl("w1"),
            client.workspaceAgentProxyWebSocketUrl("w1", "a1"),
            client.networkProxyWebSocketUrl("host"),
            client.artifactProxyWebSocketUrl("x1"),
            client.connection("remote").workspaceProxyWebSocketUrl("w1"),
        ].map((url) => new URL(url).pathname);

        expect(paths).toEqual([
            "/base/v0/workspaces/w1/proxy/websocket",
            "/base/v0/workspaces/w1/agents/a1/proxy/websocket",
            "/base/v0/networks/host/proxy/websocket",
            "/base/v0/artifacts/x1/proxy/websocket",
            "/base/v0/connections/remote/api/v0/workspaces/w1/proxy/websocket",
        ]);
        expect(() => client.networkProxyWebSocketUrl("Bad ID")).toThrow(
            "The network ID is invalid.",
        );
    });

    it("reads the health capability", () => {
        expect(
            Value.Check(healthResponseSchema, {
                capabilities: { webSocketTunnels: true },
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 33, daemon: "1.0.0" },
            }),
        ).toBe(true);
    });
});
