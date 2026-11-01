import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    addConnectionResponseSchema,
    connectionListResponseSchema,
    connectionSignInStartResponseSchema,
    connectionStatusListResponseSchema,
    connectionStatusSchema,
} from "../sources/protocol/connections.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";
import { connectionsStatusUpdatedPayloadSchema } from "../sources/protocol/events.js";

const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const VERSION = "01900000-0000-7000-8000-000000000001";
const SERVER = {
    id: "happy-example-com",
    name: "happy.example.com",
    orderKey: "3",
    authentication: "oauth" as const,
    url: "https://happy.example.com/",
    instanceId: INSTANCE,
};

interface Recorded {
    method: string;
    url: string;
    ifMatch: string | null;
    body: unknown;
}

function recordingClient(answer: (request: Recorded) => Response) {
    const requests: Recorded[] = [];
    const client = new HappyAgentClient({
        endpoint: "http://main/",
        token: "owner-token",
        fetch: async (input, init) => {
            const text = typeof init?.body === "string" ? init.body : undefined;
            const request = {
                method: init?.method ?? "GET",
                url: input.toString(),
                ifMatch: new Headers(init?.headers).get("if-match"),
                body: text === undefined ? undefined : (JSON.parse(text) as unknown),
            };
            requests.push(request);
            return answer(request);
        },
    });
    return { client, requests };
}

describe("server connections by URL", () => {
    it("accepts oauth roster entries and an optional instance ID on every kind", () => {
        const roster = {
            version: VERSION,
            connections: [
                SERVER,
                {
                    id: "mac",
                    name: "Mac",
                    orderKey: "1",
                    authentication: "bearer",
                    instanceId: INSTANCE,
                },
                {
                    id: "team",
                    name: "Team",
                    orderKey: "2",
                    authentication: "workos",
                    organizationId: "o",
                },
            ],
        };
        expect(Value.Check(connectionListResponseSchema, roster)).toBe(true);
        const { url: _url, ...withoutUrl } = SERVER;
        expect(Value.Check(connectionListResponseSchema, { connections: [withoutUrl] })).toBe(
            false,
        );
        expect(
            Value.Check(connectionListResponseSchema, {
                connections: [{ ...SERVER, instanceId: "K3X9Q2M7P0A4B8C1D5E6F7G2" }],
            }),
        ).toBe(false);
    });

    it("adds and removes a server, honoring an optional If-Match", async () => {
        const added = { connection: SERVER, connections: [SERVER], version: VERSION };
        expect(Value.Check(addConnectionResponseSchema, added)).toBe(true);
        const { client, requests } = recordingClient((request) =>
            request.method === "POST"
                ? Response.json(added, { status: 201 })
                : Response.json({ connections: [], version: VERSION }),
        );
        await expect(
            client.addConnection({ url: "https://happy.example.com", mutationId: "m1" }),
        ).resolves.toEqual(added);
        await expect(
            client.removeConnection(SERVER.id, { ifMatch: VERSION, mutationId: "m2" }),
        ).resolves.toEqual({ connections: [], version: VERSION });
        expect(requests).toEqual([
            {
                method: "POST",
                url: "http://main/v0/connections",
                ifMatch: null,
                body: { url: "https://happy.example.com", mutationId: "m1" },
            },
            {
                method: "DELETE",
                url: "http://main/v0/connections/happy-example-com?mutationId=m2",
                ifMatch: VERSION,
                body: undefined,
            },
        ]);
    });

    it("drives the sign-in through start, complete, and cancel", async () => {
        const started = {
            authorizationUrl: "https://idp.example.com/authorize?state=s1",
            state: "s1",
            expiresAt: 1755400600000,
        };
        expect(Value.Check(connectionSignInStartResponseSchema, started)).toBe(true);
        const status = { id: SERVER.id, status: "ready", updatedAt: 1755400000000 };
        const { client, requests } = recordingClient((request) => {
            if (request.url.endsWith("/auth/start")) return Response.json(started);
            if (request.url.endsWith("/auth/complete")) return Response.json({ status });
            return new Response(null, { status: 204 });
        });
        await expect(client.startConnectionSignIn(SERVER.id)).resolves.toEqual(started);
        const callbackUrl = "happy://oauth/callback?code=c1&state=s1";
        await expect(client.completeConnectionSignIn(SERVER.id, { callbackUrl })).resolves.toEqual({
            status,
        });
        await expect(client.cancelConnectionSignIn(SERVER.id, { state: "s1" })).resolves.toBe(
            undefined,
        );
        expect(requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
            {
                method: "POST",
                url: "http://main/v0/connections/happy-example-com/auth/start",
                body: {},
            },
            {
                method: "POST",
                url: "http://main/v0/connections/happy-example-com/auth/complete",
                body: { callbackUrl },
            },
            {
                method: "POST",
                url: "http://main/v0/connections/happy-example-com/auth/cancel",
                body: { state: "s1" },
            },
        ]);
    });

    it("reads one status, every status, and the status event", async () => {
        const ready = { id: SERVER.id, status: "ready", updatedAt: 1 };
        const signIn = {
            id: "other",
            status: "needs_sign_in",
            message: "Sign in again.",
            updatedAt: 2,
        };
        for (const status of [ready, signIn]) {
            expect(Value.Check(connectionStatusSchema, status)).toBe(true);
            expect(Value.Check(connectionsStatusUpdatedPayloadSchema, status)).toBe(true);
        }
        expect(Value.Check(connectionStatusSchema, { ...ready, status: "signed_in" })).toBe(false);
        const statuses = { statuses: [ready, signIn] };
        expect(Value.Check(connectionStatusListResponseSchema, statuses)).toBe(true);
        const { client, requests } = recordingClient((request) =>
            Response.json(request.url.endsWith("/status") ? ready : statuses),
        );
        await expect(client.getConnectionStatus(SERVER.id)).resolves.toEqual(ready);
        await expect(client.listConnectionStatuses()).resolves.toEqual(statuses);
        expect(requests.map((request) => request.url)).toEqual([
            "http://main/v0/connections/happy-example-com/status",
            "http://main/v0/connection-statuses",
        ]);
    });

    it("refuses an invalid connection ID before sending anything", async () => {
        const { client, requests } = recordingClient(() => Response.json({}));
        await expect(client.removeConnection("../health")).rejects.toThrow(
            "The remote connection ID is invalid.",
        );
        await expect(client.startConnectionSignIn("Bad")).rejects.toThrow(
            "The remote connection ID is invalid.",
        );
        expect(requests).toEqual([]);
    });

    it("reads the installation's instance ID from health", () => {
        const health = {
            healthy: true,
            ready: true,
            status: "ready",
            version: { protocol: 22, daemon: "1.2.3" },
        };
        expect(Value.Check(healthResponseSchema, health)).toBe(true);
        expect(Value.Check(healthResponseSchema, { ...health, instanceId: INSTANCE })).toBe(true);
        expect(Value.Check(healthResponseSchema, { ...health, instanceId: "short" })).toBe(false);
    });
});
