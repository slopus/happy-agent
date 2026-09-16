import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { definition, ownerId, peerId, workspaceId } from "../services/support/servicesHarness.js";
import { serviceApiHarness } from "./support/serviceApiHarness.js";

describe("workspace service HTTP API", () => {
    it("uses the published client for discovery, independent consuming input, events and idempotent stop", async () => {
        const f = await serviceApiHarness();
        try {
            const service = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, service.id)).status).toBe(
                    "running",
                ),
            );
            const before = f.api.cursor();
            expect(await f.client.listWorkspaceServices(workspaceId)).toMatchObject({
                services: [{ id: service.id }],
                nextPageCursor: null,
                cursor: before,
            });
            expect(await f.client.getWorkspaceService(workspaceId, service.id)).toMatchObject({
                service: { id: service.id, agentId: ownerId },
            });
            await expect(
                f.client.getWorkspaceService("anotherworkspace", service.id),
            ).rejects.toMatchObject({ status: 404 });
            f.running[0]!.output.stdout = "initial 🦊";
            for (const readerId of ["view-one", "view-two"])
                expect(
                    await f.client.inputWorkspaceService(workspaceId, service.id, {
                        readerId,
                        waitMs: 0,
                    }),
                ).toMatchObject({ output: "initial 🦊", truncated: false });
            expect(
                await f.client.inputWorkspaceService(workspaceId, service.id, {
                    readerId: "view-one",
                    waitMs: 0,
                    chars: "one input\n",
                }),
            ).toMatchObject({ output: "" });
            expect(f.running[0]!.service.write).toHaveBeenCalledTimes(1);
            expect(
                await f.services.inputForAgent(f.ctx, peerId, service.id, {
                    waitMs: 0,
                    maxOutputBytes: 100,
                }),
            ).toMatchObject({ output: "initial 🦊" });
            const invalid = await fetch(
                `${f.endpoint}/v0/workspaces/${workspaceId}/services/${service.id}/input`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${f.token}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ readerId: "view-one", waitMs: 20001 }),
                },
            );
            expect(invalid.status).toBe(400);
            f.holdCleanup();
            expect(
                await f.client.stopWorkspaceService(workspaceId, service.id, {
                    mutationId: "stop-service-fixture",
                }),
            ).toMatchObject({ service: { status: "stopping" } });
            f.finishCleanup();
            await vi.waitFor(async () =>
                expect(
                    (await f.client.getWorkspaceService(workspaceId, service.id)).service.status,
                ).toBe("killed"),
            );
            expect(await f.client.stopWorkspaceService(workspaceId, service.id)).toMatchObject({
                service: { status: "killed" },
            });
            expect((await f.client.listWorkspaceServices(workspaceId)).services).toEqual([]);
            expect(
                (await f.client.listWorkspaceServices(workspaceId, { includeStopped: true }))
                    .services,
            ).toHaveLength(1);
            const events = await f.client.getEvents({ after: before });
            expect(events.events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "service.updated",
                        payload: expect.objectContaining({
                            serviceId: service.id,
                            mutationId: "stop-service-fixture",
                        }),
                    }),
                ]),
            );
            expect(JSON.stringify(events)).not.toContain("one input");
            expect(JSON.stringify(events)).not.toContain("initial 🦊");
        } finally {
            f.finishCleanup();
            await f.close();
        }
    });

    it("requires daemon and exact-service credentials, forwards only the endpoint, and revokes open attachments", async () => {
        const f = await serviceApiHarness();
        const peers = new Set<Socket>();
        const app = createServer((_req, res) => res.end("private-service"));
        app.on("connection", (socket) => {
            peers.add(socket);
            socket.once("close", () => peers.delete(socket));
        });
        await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
        try {
            const service = await f.services.start(f.ctx, ownerId, definition);
            const other = await f.services.start(f.ctx, ownerId, {
                ...definition,
                name: "Other service",
            });
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, other.id)).status).toBe("running"),
            );
            vi.spyOn(f.running[0]!.service, "connect").mockImplementation(async () => {
                const endpoint = connect((app.address() as { port: number }).port, "127.0.0.1");
                await once(endpoint, "connect");
                return endpoint;
            });
            const credential = await f.client.issueWorkspaceServiceAccessToken(
                workspaceId,
                service.id,
            );
            for (const [id, headers, status] of [
                [service.id, {}, 401],
                [service.id, { authorization: `Bearer ${credential.accessToken}` }, 401],
                [service.id, { authorization: `Bearer ${f.token}` }, 401],
                [
                    other.id,
                    {
                        authorization: `Bearer ${f.token}`,
                        "x-happy-service-authorization": `Bearer ${credential.accessToken}`,
                    },
                    403,
                ],
            ] as const) {
                const result = await f.connectService(workspaceId, id, headers);
                expect(result.status).toBe(status);
                result.socket.destroy();
            }
            const connected = await f.connectService(workspaceId, service.id, {
                authorization: `Bearer ${f.token}`,
                "x-happy-service-authorization": `Bearer ${credential.accessToken}`,
            });
            expect(connected.status).toBe(200);
            const reply = once(connected.socket, "data");
            connected.socket.write("GET / HTTP/1.1\r\nHost: preview.localhost\r\n\r\n");
            expect((await reply)[0].toString()).toContain("private-service");
            const closed = once(connected.socket, "close");
            f.holdCleanup();
            await f.client.stopWorkspaceService(workspaceId, service.id);
            await closed;
            const revoked = await f.connectService(workspaceId, service.id, {
                authorization: `Bearer ${f.token}`,
                "x-happy-service-authorization": `Bearer ${credential.accessToken}`,
            });
            expect(revoked.status).toBe(409);
            revoked.socket.destroy();
            expect(JSON.stringify(await f.client.getEvents())).not.toContain(
                credential.accessToken,
            );
        } finally {
            f.finishCleanup();
            await f.close();
            for (const peer of peers) peer.destroy();
            await new Promise<void>((resolve) => app.close(() => resolve()));
        }
    });
});
