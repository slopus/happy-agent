import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket, type VerifyClientCallbackSync } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuestServer } from "../sources/GuestServer.js";
import { GuestStore } from "../sources/persistence/GuestStore.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const nonce = () => randomBytes(32).toString("base64url");
async function fixture(options: { twoExports?: boolean; trustedProxyAddress?: string } = {}) {
    const path = await mkdtemp(join(tmpdir(), "clip-transport-"));
    cleanups.push(async () => await rm(path, { force: true, recursive: true }));
    const store = await GuestStore.open(path);
    cleanups.push(async () => await store.close());
    const sockets = new Set<WebSocket>();
    const frames: {
        type: string;
        id?: string;
        seq?: number;
        userId?: string;
        name?: string;
        chatId?: string;
        text?: string;
    }[] = [];
    const verifyClient: VerifyClientCallbackSync = (info) => info.req.url !== "/bad";
    const ws = new WebSocketServer({ port: 0, host: "127.0.0.1", verifyClient });
    await new Promise<void>((resolve) => ws.once("listening", resolve));
    cleanups.push(async () => {
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((resolve) => ws.close(() => resolve()));
    });
    ws.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("message", (data) => frames.push(JSON.parse(String(data))));
        socket.send(JSON.stringify({ type: "hello", protocol: 1, bot: { id: "a", name: "A" } }));
    });
    const address = ws.address();
    if (address === null || typeof address === "string") throw new Error("No WebSocket port");
    const fatal: Error[] = [];
    const gateway = createGuestServer({
        store,
        exports: [
            { botId: "a", connectUrl: `ws://127.0.0.1:${address.port}`, bridgeToken: "private" },
            ...(options.twoExports
                ? [
                      {
                          botId: "b",
                          connectUrl: `ws://127.0.0.1:${address.port}/bad`,
                          bridgeToken: "wrong",
                      },
                  ]
                : []),
        ],
        ...(options.trustedProxyAddress === undefined
            ? {}
            : { trustedProxyAddress: options.trustedProxyAddress }),
        fatal: (error) => fatal.push(error),
    });
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => await gateway.stop());
    const http = gateway.server.address();
    if (http === null || typeof http === "string") throw new Error("No HTTP port");
    gateway.start();
    await vi.waitFor(() => expect(gateway.bridges.get("a")?.online).toBe(true));
    const invite = await store.createInvite({
        botId: "a",
        botName: "A",
        maxMembers: 1,
        expiresAt: Date.now() + 86_400_000,
        readOnly: false,
    });
    await store.approve(invite.id, 1);
    const session = await store.redeem(invite.token, nonce(), "a", "Zoë");
    const headers = {
        authorization: `Bearer ${session.sessionToken}`,
        ...(options.trustedProxyAddress === undefined ? {} : { "x-forwarded-for": "192.0.2.1" }),
    };
    const origin = `http://127.0.0.1:${http.port}`;
    const url = `${origin}/v1/bot-guest/sessions/${session.sessionId}/messages`;
    return {
        store,
        frames,
        sockets,
        gateway,
        origin,
        url,
        headers,
        session,
        invite,
        fatal,
        port: http.port,
    };
}

describe("gateway failure boundaries", () => {
    it("returns 400 for malformed request targets and 500 for storage failure without stopping other requests", async () => {
        const test = await fixture();
        const raw = await new Promise<string>((resolve, reject) => {
            const socket = createConnection(test.port, "127.0.0.1");
            let output = "";
            socket.on("connect", () =>
                socket.write("GET //[x/ HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n"),
            );
            socket.on("data", (data) => {
                output += String(data);
            });
            socket.on("end", () => resolve(output));
            socket.on("error", reject);
        });
        expect(raw).toContain("400");
        const failure = vi
            .spyOn(test.store, "queryInviteBot")
            .mockRejectedValueOnce(new Error("private SQL diagnostic"));
        const response = await fetch(`${test.origin}/v1/bot-invites/redeem`, {
            method: "POST",
            body: JSON.stringify({ token: nonce(), redeemNonce: nonce(), displayName: "Guest" }),
        });
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain("private");
        failure.mockRestore();
        expect((await fetch(test.url, { headers: test.headers })).status).toBe(200);
        expect(test.fatal).toEqual([]);
    });

    it("persists a fixed reject notice, truncates oversized replies, and drains a replay burst before acking", async () => {
        const test = await fixture();
        await fetch(test.url, {
            method: "POST",
            headers: test.headers,
            body: JSON.stringify({ localId: "one", text: "Hello" }),
        });
        await vi.waitFor(() =>
            expect(test.frames.some((frame) => frame.type === "message")).toBe(true),
        );
        const message = test.frames.find((frame) => frame.type === "message")!;
        expect(message.name).toBe("Zoë");
        const socket = [...test.sockets][0]!;
        socket.send(
            JSON.stringify({
                type: "reject",
                id: message.id,
                reason: "/private/daemon/path and private credential",
            }),
        );
        await vi.waitFor(async () =>
            expect(
                (
                    await test.store.read(test.session.sessionId, test.session.sessionToken, "a", 0)
                ).messages.at(-1)?.text,
            ).toBe("This message could not be delivered."),
        );
        socket.send(
            JSON.stringify({
                type: "reply",
                seq: 1,
                userId: test.invite.userIds[0]!,
                chatId: test.invite.userIds[0]!,
                text: "X".repeat(31_949) + "😀" + "X".repeat(8_000),
                attachments: [{ path: "/private/daemon/path" }],
            }),
        );
        await vi.waitFor(() =>
            expect(test.frames.some((frame) => frame.type === "ack" && frame.seq === 1)).toBe(true),
        );
        const page = await test.store.read(
            test.session.sessionId,
            test.session.sessionToken,
            "a",
            0,
        );
        expect(page.messages.at(-1)?.text.length).toBeLessThanOrEqual(32_000);
        expect(page.messages.at(-1)?.text).toContain("[Message shortened.]");
        const shortened = page.messages.at(-1)!.text;
        expect(Buffer.from(shortened, "utf8").toString("utf8")).toBe(shortened);
        expect(shortened.includes("\uFFFD")).toBe(false);
        expect(JSON.stringify(page)).not.toContain("/private");
        // Repeat one durable reply more than the former 64-frame queue limit.
        for (let index = 0; index < 100; index++)
            socket.send(
                JSON.stringify({
                    type: "reply",
                    seq: 2,
                    userId: test.invite.userIds[0]!,
                    chatId: test.invite.userIds[0]!,
                    text: "Once",
                }),
            );
        await vi.waitFor(
            () =>
                expect(
                    test.frames.filter((frame) => frame.type === "ack" && frame.seq === 2),
                ).toHaveLength(100),
            { timeout: 10_000 },
        );
        expect(
            (
                await test.store.read(test.session.sessionId, test.session.sessionToken, "a", 0)
            ).messages.filter((entry) => entry.text === "Once"),
        ).toHaveLength(1);
        expect(test.gateway.bridges.get("a")?.online).toBe(true);
    });

    it("replays an unacknowledged send with the same identity after reconnect", async () => {
        const test = await fixture();
        await fetch(test.url, {
            method: "POST",
            headers: test.headers,
            body: JSON.stringify({ localId: "one", text: "Replay" }),
        });
        await vi.waitFor(() =>
            expect(test.frames.filter((frame) => frame.type === "message")).toHaveLength(1),
        );
        [...test.sockets][0]!.close();
        await vi.waitFor(
            () => expect(test.frames.filter((frame) => frame.type === "message")).toHaveLength(2),
            { timeout: 5_000 },
        );
        const messages = test.frames.filter((frame) => frame.type === "message");
        expect(messages[1]?.id).toBe(messages[0]?.id);
    });

    it("keeps another export alive after credential refusal and waits offline instead of spinning", async () => {
        const test = await fixture({ twoExports: true });
        await vi.waitFor(() => expect(test.fatal).toHaveLength(1));
        expect((await fetch(test.url, { headers: test.headers })).status).toBe(200);
        await test.gateway.bridges.get("a")!.stop();
        const read = vi.spyOn(test.store, "read");
        const start = Date.now();
        const waiting = fetch(`${test.url}?wait=1`, { headers: test.headers });
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        const conflict = await fetch(`${test.url}?wait=1`, { headers: test.headers });
        expect(conflict.status).toBe(429);
        expect(conflict.headers.get("retry-after")).toBe("1");
        expect((await waiting).status).toBe(200);
        expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    });

    it("trusts only the configured proxy hop and keeps valid session requests separate from public redeem limits", async () => {
        const test = await fixture({ trustedProxyAddress: "127.0.0.1" });
        const redeem = async (address: string) =>
            await fetch(`${test.origin}/v1/bot-invites/redeem`, {
                method: "POST",
                headers: { "x-forwarded-for": address },
                body: JSON.stringify({
                    token: nonce(),
                    redeemNonce: nonce(),
                    displayName: "Guest",
                }),
            });
        for (let index = 0; index < 10; index++)
            expect((await redeem("192.0.2.1")).status).toBe(404);
        expect((await redeem("192.0.2.1")).status).toBe(429);
        expect((await redeem("192.0.2.2")).status).toBe(404);
        expect((await redeem("192.0.2.1, 192.0.2.2")).status).toBe(400);
        expect((await fetch(test.url, { headers: test.headers })).status).toBe(200);
    });
});
