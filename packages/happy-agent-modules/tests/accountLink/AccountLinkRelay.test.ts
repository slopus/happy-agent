import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    createAccountLinkWorld,
    LOCAL_TOKEN,
    removeAccountLinkWorlds,
    type AccountLinkWorld,
} from "./support/accountLinkWorld.js";
import { FakeAccounts, type TokenOverrides } from "./support/fakeAccounts.js";
import { FakeLocalApi } from "./support/fakeLocalApi.js";
import { FakeRelay } from "./support/fakeRelay.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

let accounts: FakeAccounts;
let relay: FakeRelay;
let local: FakeLocalApi;
let world: AccountLinkWorld;
let endpointId: string;

beforeEach(async () => {
    relay = await FakeRelay.start();
    accounts = await FakeAccounts.start(relay.url);
    world = await createAccountLinkWorld({ accountsUrl: accounts.url, relayUrl: relay.url });
    local = await FakeLocalApi.start(join(world.root, "agent.sock"));
    const started = await world.run("link_happy_account");
    if (started.state !== "linking") throw new Error("Linking did not start.");
    accounts.approve(started.userCode, OWNER);
    const linked = await world.waitFor((status) => status.state === "linked");
    if (linked.state !== "linked") throw new Error("Unreachable.");
    endpointId = linked.endpointId;
});

afterEach(async () => {
    await world.close();
    await local.close();
    await relay.close();
    await accounts.close();
    await removeAccountLinkWorlds();
});

async function reach(): Promise<void> {
    await world.run("set_happy_account_reachable", { reachable: true });
    await relay.waitForAttach();
}

async function ownerHeaders(overrides: TokenOverrides = {}): Promise<[string, string][]> {
    return [["authorization", `Bearer ${await accounts.relayToken(endpointId, overrides)}`]];
}

describe("becoming reachable", () => {
    it("stays off the relay until asked, then attaches with its endpoint token and tells accounts", async () => {
        expect(relay.attachments).toEqual([]);
        expect(accounts.endpoint(endpointId).reachable).toBe(false);

        const status = await world.run("set_happy_account_reachable", { reachable: true });

        expect(status).toEqual({
            accountId: OWNER,
            endpointId,
            reachable: true,
            relay: "attached",
            state: "linked",
        });
        const attachment = await relay.waitForAttach();
        const claims = JSON.parse(
            Buffer.from(
                (attachment.authorization ?? "").split(".")[1] ?? "",
                "base64url",
            ).toString(),
        ) as Record<string, unknown>;
        expect(claims).toMatchObject({
            aud: `${relay.url}/`,
            eid: endpointId,
            sub: OWNER,
            typ: "endpoint",
        });
        expect(accounts.endpoint(endpointId).reachable).toBe(true);
        await expect.poll(() => accounts.endpoint(endpointId).seen).toBe(1);
        expect(world.invoke).toHaveBeenCalledTimes(1);
        expect(JSON.parse(await readFile(world.credentialsPath, "utf8"))).toMatchObject({
            reachable: true,
        });
    });

    it("attaches again after a restart without being asked", async () => {
        await reach();
        await world.close();
        await relay.waitForDetach();

        world = await createAccountLinkWorld({
            accountsUrl: accounts.url,
            relayUrl: relay.url,
            root: world.root,
        });

        await relay.waitForAttach(2);
        expect(world.module.currentStatus()).toMatchObject({ reachable: true, relay: "attached" });
    });

    it("closes the socket at once and tells accounts when reachability is turned off", async () => {
        await reach();

        const status = await world.run("set_happy_account_reachable", { reachable: false });

        expect(status).toMatchObject({ reachable: false, relay: "off" });
        await relay.waitForDetach();
        expect(accounts.endpoint(endpointId).reachable).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(relay.attachments).toHaveLength(1);
    });

    it("drops the socket, marks the computer unreachable, and revokes its credential on unlink", async () => {
        await reach();

        await expect(world.run("unlink_happy_account")).resolves.toEqual({ state: "unlinked" });

        await relay.waitForDetach();
        expect(accounts.endpoint(endpointId)).toMatchObject({ reachable: false, revoked: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(relay.attachments).toHaveLength(1);
    });

    it("drops the socket and unlinks itself when accounts refuses its refresh token", async () => {
        await reach();
        // What "sign out everywhere" or removing the device does at accounts.
        accounts.revoke(endpointId);
        accounts.accessTtlSeconds = 30;

        // The relay keeps an attached socket whatever happens at accounts; a reconnect is the
        // next moment the daemon needs a token.
        relay.refuseAttachWith = 401;
        relay.drop();

        await world.waitFor((status) => status.state === "unlinked", 15_000);
        expect(world.module.currentStatus()).toEqual({
            error: "Happy accounts no longer recognizes this computer. Link it again.",
            state: "unlinked",
        });
        await expect(readFile(world.credentialsPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
        const attempts = relay.attachments.length;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(relay.attachments).toHaveLength(attempts);
        expect(relay.current).toBeUndefined();
    }, 20_000);
});

describe("requests forwarded by the relay", () => {
    beforeEach(reach);

    it("serves the owner's request against the local API as the local owner", async () => {
        const response = await relay.request({
            headers: [
                ...(await ownerHeaders()),
                ["accept", "application/json"],
                ["x-request-id", "abc"],
                ["cf-connecting-ip", "203.0.113.9"],
            ],
            path: "/v0/health?verbose=1",
        }).done;

        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString("utf8"))).toEqual({
            ok: true,
            query: "?verbose=1",
        });
        expect(response.headers.filter(([name]) => name === "set-cookie")).toEqual([
            ["set-cookie", "a=1"],
            ["set-cookie", "b=2"],
        ]);
        expect(local.requests).toHaveLength(1);
        expect(local.requests[0]).toMatchObject({ method: "GET", url: "/v0/health?verbose=1" });
        expect(local.requests[0]?.headers).toMatchObject({
            accept: "application/json",
            authorization: `Bearer ${LOCAL_TOKEN}`,
            host: "localhost",
            "x-request-id": "abc",
        });
    });

    it.each<[string, () => Promise<[string, string][]>, number, string]>([
        ["no token", async () => [], 401, "unauthorized"],
        [
            "the local owner token itself",
            async () => [["authorization", `Bearer ${LOCAL_TOKEN}`]],
            401,
            "unauthorized",
        ],
        [
            "an expired relay token",
            async () => await ownerHeaders({ expiresInSeconds: -5 }),
            401,
            "unauthorized",
        ],
        [
            "a forged relay token",
            async () => await ownerHeaders({ foreignKey: true }),
            401,
            "unauthorized",
        ],
        [
            "a relay token for another account",
            async () => await ownerHeaders({ claims: { sub: STRANGER } }),
            403,
            "forbidden",
        ],
        [
            "a gateway token acting for the owner",
            async () => await ownerHeaders({ claims: { act: { cid: "c1" } } }),
            403,
            "forbidden",
        ],
        [
            "a token of another type",
            async () => await ownerHeaders({ claims: { typ: "mcp" } }),
            403,
            "forbidden",
        ],
        [
            "the owner's token beside a second Authorization header",
            async () => [...(await ownerHeaders()), ["Authorization", "Bearer x.y.z"]],
            401,
            "unauthorized",
        ],
    ])("refuses %s without touching the local API", async (_name, headers, status, code) => {
        for (const [method, body] of [
            ["GET", undefined],
            ["POST", Buffer.from("{}")],
            ["DELETE", undefined],
        ] as const) {
            const response = await relay.request({
                ...(body === undefined ? {} : { body }),
                headers: await headers(),
                method,
                path: "/v0/health",
            }).done;

            expect(response.status).toBe(status);
            expect(JSON.parse(response.body.toString("utf8"))).toEqual({ code });
        }
        const stream = await relay.openStream({ headers: await headers(), path: "/v0/stream" })
            .opened;
        expect(stream).toMatchObject({ accepted: false, response: { status } });
        expect(local.requests).toEqual([]);
    });

    it("refuses another account's genuine relay token for its own computer", async () => {
        const other = await createAccountLinkWorld({
            accountsUrl: accounts.url,
            relayUrl: relay.url,
        });
        try {
            const started = await other.run("link_happy_account");
            if (started.state !== "linking") throw new Error("Linking did not start.");
            accounts.approve(started.userCode, STRANGER);
            const linked = await other.waitFor((status) => status.state === "linked");
            if (linked.state !== "linked") throw new Error("Unreachable.");

            const response = await relay.request({
                headers: [
                    ["authorization", `Bearer ${await accounts.relayToken(linked.endpointId)}`],
                ],
                path: "/v0/health",
            }).done;

            expect(response.status).toBe(403);
            expect(local.requests).toEqual([]);
        } finally {
            await other.close();
        }
    });

    it("carries a large upload and its streamed response intact within the body windows", async () => {
        const body = randomBytes(3 * 1_048_576 + 12_345);

        const response = await relay.request({
            body,
            headers: await ownerHeaders(),
            method: "POST",
            path: "/v0/echo",
        }).done;

        expect(response.outcome).toBe("ended");
        expect(response.status).toBe(200);
        expect(response.body.equals(body)).toBe(true);
        expect(relay.overrun).toBe(false);
        expect(relay.current).toBeDefined();
    });

    it("stops sending a response at the window until the relay grants more", async () => {
        relay.autoCredit = false;
        const body = randomBytes(2 * 1_048_576);

        const exchange = relay.request({
            body,
            headers: await ownerHeaders(),
            method: "POST",
            path: "/v0/echo",
        });
        await exchange.head;
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Whole frames only: the next one would not fit in what is left of the window.
        const held = exchange.received().byteLength;
        expect(held).toBeLessThanOrEqual(1_048_576);
        expect(held).toBeGreaterThan(1_048_576 - 65_536);
        expect(relay.overrun).toBe(false);
        relay.grant(exchange.id, 1_048_576);
        const response = await exchange.done;
        expect(response.body.equals(body)).toBe(true);
        expect(relay.overrun).toBe(false);
    });

    it("answers a bodiless status without a body", async () => {
        const response = await relay.request({ headers: await ownerHeaders(), path: "/v0/empty" })
            .done;

        expect(response).toMatchObject({ outcome: "ended", status: 204 });
        expect(response.body.byteLength).toBe(0);
    });

    it("streams events as they happen and stops the local request when the client leaves", async () => {
        const exchange = relay.request({ headers: await ownerHeaders(), path: "/v0/events" });

        expect(await exchange.head).toMatchObject({ status: 200 });
        await expect.poll(() => exchange.received().toString("utf8")).toContain("data: tick");
        expect(local.aborted).toBe(0);
        exchange.abort();

        await expect.poll(() => local.aborted).toBe(1);
    });

    it("cuts an open response when the token that opened it expires", async () => {
        const exchange = relay.request({
            headers: await ownerHeaders({ expiresInSeconds: 2 }),
            path: "/v0/events",
        });
        expect(await exchange.head).toMatchObject({ status: 200 });
        const startedAt = Date.now();

        const response = await exchange.done;

        expect(response.outcome).toBe("aborted");
        expect(Date.now() - startedAt).toBeLessThan(3_000);
        await expect.poll(() => local.aborted).toBe(1);
    });

    it("answers 502 when the local API is not listening", async () => {
        await local.close();

        const response = await relay.request({ headers: await ownerHeaders(), path: "/v0/health" })
            .done;

        expect(response.status).toBe(502);
        expect(JSON.parse(response.body.toString("utf8"))).toEqual({
            code: "local_api_unavailable",
        });
        local = await FakeLocalApi.start(join(world.root, "agent2.sock"));
    });
});

describe("client WebSockets forwarded by the relay", () => {
    beforeEach(reach);

    it("accepts the owner's stream with the negotiated subprotocol and carries messages both ways", async () => {
        const stream = relay.openStream({
            headers: [...(await ownerHeaders()), ["sec-websocket-protocol", "other, happy.v1"]],
            path: "/v0/stream?session=1",
        });

        await expect(stream.opened).resolves.toEqual({ accepted: true, protocol: "happy.v1" });
        expect(local.requests[0]).toMatchObject({ url: "/v0/stream?session=1" });
        expect(local.requests[0]?.headers.authorization).toBe(`Bearer ${LOCAL_TOKEN}`);
        stream.send("hello");
        stream.send(Buffer.from([0, 1, 2, 255]));
        await expect.poll(() => stream.messages).toEqual(["hello", Buffer.from([0, 1, 2, 255])]);

        stream.close(1000);
        await expect.poll(() => local.sockets[0]?.readyState).toBe(3);
    });

    it("never lets the relay's path choose another socket to send the owner token to", async () => {
        const decoy = await FakeLocalApi.start(join(world.root, "decoy.sock"));
        try {
            const stream = relay.openStream({
                headers: await ownerHeaders(),
                path: `/../../../../../../../..${join(world.root, "decoy.sock")}:/v0/stream`,
            });

            await stream.opened;
            expect(decoy.requests).toEqual([]);
            expect(local.requests).toHaveLength(1);
        } finally {
            await decoy.close();
        }
    });

    it("survives a close reason longer than a WebSocket allows", async () => {
        const stream = relay.openStream({ headers: await ownerHeaders(), path: "/v0/stream" });
        await stream.opened;

        stream.close(1000, "\u{1F600}".repeat(60));

        await expect.poll(() => local.sockets[0]?.readyState).toBe(3);
        const response = await relay.request({ headers: await ownerHeaders(), path: "/v0/health" })
            .done;
        expect(response.status).toBe(200);
    });

    it("tells the client when the local side closes", async () => {
        const stream = relay.openStream({ headers: await ownerHeaders(), path: "/v0/stream" });
        await stream.opened;

        local.sockets[0]?.close(4001, "done");

        await expect(stream.closed).resolves.toEqual({ code: 4001, reason: "done" });
    });

    it("passes on the local API's refusal of an upgrade", async () => {
        const stream = relay.openStream({ headers: await ownerHeaders(), path: "/v0/nothing" });

        await expect(stream.opened).resolves.toMatchObject({
            accepted: false,
            response: { status: 404 },
        });
    });

    it("closes an open stream when the token that opened it expires", async () => {
        const stream = relay.openStream({
            headers: await ownerHeaders({ expiresInSeconds: 2 }),
            path: "/v0/stream",
        });
        await expect(stream.opened).resolves.toMatchObject({ accepted: true });

        await expect(stream.closed).resolves.toEqual({ code: 4401, reason: "token_expired" });
        await expect.poll(() => local.sockets[0]?.readyState).toBe(3);
    });

    it("closes a stream whose client cannot keep up instead of queueing without bound", async () => {
        const stream = relay.openStream({ headers: await ownerHeaders(), path: "/v0/stream" });
        await stream.opened;
        relay.stall(true);

        stream.send("flood");

        await expect.poll(() => local.sockets[0]?.readyState, { timeout: 10_000 }).toBe(3);
        relay.stall(false);
        await expect(stream.closed).resolves.toEqual({ code: 4408, reason: "stream_too_slow" });
        // The daemon held at most its bound; the rest of the 32 MiB flood was never forwarded.
        const delivered = stream.messages.reduce((total, message) => total + message.length, 0);
        expect(delivered).toBeLessThan(20 * 1_048_576);
    }, 20_000);

    it("closes local streams and requests when the relay socket drops, then attaches again", async () => {
        const stream = relay.openStream({ headers: await ownerHeaders(), path: "/v0/stream" });
        await stream.opened;
        const events = relay.request({ headers: await ownerHeaders(), path: "/v0/events" });
        await events.head;

        relay.drop();

        await expect.poll(() => local.sockets[0]?.readyState).toBe(3);
        await expect.poll(() => local.aborted).toBe(1);
        await relay.waitForAttach(2);
        const response = await relay.request({ headers: await ownerHeaders(), path: "/v0/health" })
            .done;
        expect(response.status).toBe(200);
    });
});
