import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { connectionListResponseSchema } from "../sources/protocol/connections.js";
import {
    connectionsUpdatedPayloadSchema,
    type HappyAgentEvent,
} from "../sources/protocol/events.js";

describe("remote connections", () => {
    it("delivers a resumable complete roster with the same version as the list response", async () => {
        const before = "01900000-0000-7000-8000-000000000000";
        const cursor = "01900000-0000-7000-8000-000000000001";
        const roster = {
            version: cursor,
            connections: [
                {
                    id: "team",
                    name: "Team",
                    authentication: "workos" as const,
                    organizationId: "org_1",
                },
            ],
        };
        const event: HappyAgentEvent = {
            cursor,
            type: "connections.updated",
            occurredAt: 1,
            payload: roster,
        };
        expect(Value.Check(connectionsUpdatedPayloadSchema, event.payload)).toBe(true);
        expect(Value.Check(connectionsUpdatedPayloadSchema, { token: "private" })).toBe(false);
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "main-token",
            fetch: async (input) => {
                if (input.toString().endsWith("/v0/connections")) return Response.json(roster);
                expect(input.toString()).toBe(`http://main/v0/events/stream?after=${before}`);
                return new Response(
                    `event: hello\ndata: ${JSON.stringify({ cursor, gap: false, resumed: true, connectedAt: 1 })}\n\n` +
                        `id: ${cursor}\nevent: connections.updated\ndata: ${JSON.stringify(event)}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                );
            },
        });
        const updates = client.updates({ after: before, signal: controller.signal });
        try {
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "connected", cursor: before },
            });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event },
            });
            await expect(client.listConnections()).resolves.toEqual(roster);
        } finally {
            controller.abort();
            await updates.return(undefined);
        }
    });

    it("accepts complete empty-roster updates but requires their version", () => {
        expect(
            Value.Check(connectionsUpdatedPayloadSchema, {
                connections: [],
                version: "01900000-0000-7000-8000-000000000001",
            }),
        ).toBe(true);
        expect(Value.Check(connectionsUpdatedPayloadSchema, { connections: [] })).toBe(false);
        expect(Value.Check(connectionListResponseSchema, { connections: [] })).toBe(true);
    });

    it("reads the roster with only public connection metadata", async () => {
        const roster = {
            connections: [
                { id: "mac", name: "Build Mac", authentication: "bearer" },
                {
                    id: "team",
                    name: "Engineering",
                    authentication: "workos",
                    organizationId: "org_1",
                },
            ],
        };
        expect(Value.Check(connectionListResponseSchema, roster)).toBe(true);
        let requested = "";
        const client = new HappyAgentClient({
            endpoint: "http://main/prefix?key=transport",
            token: "main-token",
            fetch: async (input, init) => {
                requested = input.toString();
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer main-token");
                return Response.json(roster);
            },
        });
        await expect(client.listConnections()).resolves.toEqual(roster);
        expect(requested).toBe("http://main/prefix/v0/connections?key=transport");
    });

    it("creates independent clients while preserving the main transport and query", async () => {
        const urls: string[] = [];
        const parent = new HappyAgentClient({
            endpoint: "http://main/prefix?key=transport",
            token: "main-token",
            fetch: async (input, init) => {
                urls.push(input.toString());
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer main-token");
                return Response.json({ projects: [] });
            },
        });
        const child = parent.connection("build-mac");
        expect(child).not.toBe(parent.connection("build-mac"));
        expect(urls).toEqual([]);
        await child.listProjects();
        await parent.listProjects();
        await child.getGreeting();
        expect(urls).toEqual([
            "http://main/prefix/v0/connections/build-mac/api/v0/projects?key=transport",
            "http://main/prefix/v0/projects?key=transport",
            "http://main/prefix/v0/connections/build-mac/api/?key=transport",
        ]);
    });

    it.each(["", "..", "a/../../health", "%2e%2e", "Mac", "a?x=1", "a#x", "a".repeat(65)])(
        "rejects invalid connection ID %s before making a request",
        (id) => {
            const client = new HappyAgentClient({ endpoint: "http://main", token: "t" });
            expect(() => client.connection(id)).toThrow("connection ID is invalid");
        },
    );

    it("does not hide errors from older daemons without the roster feature", async () => {
        const client = new HappyAgentClient({
            endpoint: "http://main",
            token: "t",
            fetch: async () =>
                Response.json({ code: "not_found", error: "Not found." }, { status: 404 }),
        });
        await expect(client.listConnections()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
    });
});
