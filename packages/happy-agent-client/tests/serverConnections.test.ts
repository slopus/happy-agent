import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { connectionListResponseSchema } from "../sources/protocol/connections.js";
import { healthResponseSchema } from "../sources/protocol/daemon.js";

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
    authorization: string | null;
    remoteAuthorization: string | null;
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
                authorization: new Headers(init?.headers).get("authorization"),
                remoteAuthorization: new Headers(init?.headers).get("happy-remote-authorization"),
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

    it("sends the remote token only through a connection client, in its own header", async () => {
        let current = "jwt-1";
        const { client, requests } = recordingClient(() =>
            Response.json({ connections: [], version: VERSION }),
        );
        const remote = client.connection(SERVER.id, { remoteToken: () => current });
        await remote.listConnections();
        current = "jwt-2";
        await remote.listConnections();
        await client.listConnections();
        await client.connection(SERVER.id).listConnections();
        expect(
            requests.map(({ url, authorization, remoteAuthorization }) => ({
                url,
                authorization,
                remoteAuthorization,
            })),
        ).toEqual([
            {
                url: "http://main/v0/connections/happy-example-com/api/v0/connections",
                authorization: "Bearer owner-token",
                remoteAuthorization: "Bearer jwt-1",
            },
            {
                url: "http://main/v0/connections/happy-example-com/api/v0/connections",
                authorization: "Bearer owner-token",
                remoteAuthorization: "Bearer jwt-2",
            },
            {
                url: "http://main/v0/connections",
                authorization: "Bearer owner-token",
                remoteAuthorization: null,
            },
            {
                url: "http://main/v0/connections/happy-example-com/api/v0/connections",
                authorization: "Bearer owner-token",
                remoteAuthorization: null,
            },
        ]);
        expect(requests.every((request) => !request.url.includes("jwt"))).toBe(true);
    });

    it("refuses an invalid connection ID before sending anything", async () => {
        const { client, requests } = recordingClient(() => Response.json({}));
        expect(() => client.connection("../health")).toThrow(
            "The remote connection ID is invalid.",
        );
        expect(() => client.connection("Bad", { remoteToken: "jwt" })).toThrow(
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
