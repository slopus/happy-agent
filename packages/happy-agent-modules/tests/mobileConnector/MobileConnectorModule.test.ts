import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { agentDatabaseRows } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

// The phone is a test-only implementation written from API.md, independent of `impl/`.
import {
    commitment,
    parseQr,
    phoneKey,
    phoneRequest,
    startPhonePairing,
    type PhoneTransport,
} from "./support/fakePhone.js";
import { moduleTransport } from "./support/moduleTransport.js";
import {
    MobileConnectorError,
    type MobileConnectorSnapshot,
} from "../../sources/mobileConnector/index.js";
import { withTeamUser, type TeamUser } from "../../sources/team/index.js";
import { pendingCallCount } from "../durableFunctions/support/durableFunctionsHarness.js";
import {
    FAKE_TAILCAT_ADDRESS,
    mobileConnectorWorld,
    UNUSED_TRANSPORT,
    type MobileConnectorWorld,
} from "./support/mobileConnectorWorld.js";

const worlds: MobileConnectorWorld[] = [];
const device = { name: "Test iPhone", platform: "ios" } as const;

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const world of worlds.splice(0).reverse()) await world.close();
});

async function world(options: Partial<Parameters<typeof mobileConnectorWorld>[0]> = {}) {
    const created = await mobileConnectorWorld(options);
    worlds.push(created);
    return created;
}

const HANDSHAKE = "/v0/mobile-connector/handshake";

function phone(target: MobileConnectorWorld): PhoneTransport {
    return moduleTransport(target.mobile, target.ctx);
}

async function storedDevices(target: MobileConnectorWorld) {
    return await agentDatabaseRows<{ id: string; owner_id: string; token_hash: string }>(
        target.ctx.db,
        sql`SELECT id, owner_id, token_hash FROM happy_agent_mobile_devices`,
    );
}

async function waitForStatus(
    target: MobileConnectorWorld,
    status: MobileConnectorSnapshot["status"],
): Promise<void> {
    await vi.waitFor(
        async () => {
            expect((await target.mobile.snapshot(target.ctx)).status).toBe(status);
        },
        { timeout: 10_000 },
    );
}

async function pairedPhone(target: MobileConnectorWorld) {
    const started = await target.mobile.startPairing(target.ctx);
    const session = await startPhonePairing(started.pairing!.qr!, phone(target));
    await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
    return await session.confirm();
}

describe("MobileConnectorModule", () => {
    it("pairs a phone over its own Tailcat socket only after both people confirm", async () => {
        const target = await world();
        const initial = await target.mobile.snapshot(target.ctx);
        expect(initial).toMatchObject({
            status: "closed",
            pairing: null,
            devices: [],
            error: null,
        });

        const started = await target.mobile.startPairing(target.ctx);
        expect(started.status).toBe("open");
        expect(started.pairing).toMatchObject({ status: "waiting", device: null, emoji: null });
        const qr = parseQr(started.pairing!.qr!);
        expect(qr).toMatchObject({ v: 1, a: FAKE_TAILCAT_ADDRESS, p: target.port, n: "Test Mac" });
        expect(qr.e).toBe(started.pairing!.expiresAt);

        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        const verifying = await target.mobile.snapshot(target.ctx);
        expect(verifying.pairing).toMatchObject({
            status: "verifying",
            qr: null,
            device,
            emoji: session.emoji,
            desktopConfirmed: false,
            mobileConfirmed: false,
        });

        const confirmed = session.confirm();
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        expect(await storedDevices(target)).toEqual([]);
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        const paired = await confirmed;

        expect(paired).toMatchObject({ address: FAKE_TAILCAT_ADDRESS, port: target.port });
        const rows = await storedDevices(target);
        expect(rows).toEqual([
            {
                id: paired.deviceId,
                owner_id: "standalone",
                token_hash: createHash("sha256")
                    .update(Buffer.from(paired.deviceToken, "base64url"))
                    .digest("hex"),
            },
        ]);
        const done = await target.mobile.snapshot(target.ctx);
        expect(done.pairing).toMatchObject({ status: "completed", desktopConfirmed: true });
        expect(done.devices).toEqual([
            {
                id: paired.deviceId,
                name: "Test iPhone",
                platform: "ios",
                createdAt: expect.any(Number),
                lastSeenAt: expect.any(Number),
            },
        ]);
        const invocations = await import("node:fs/promises").then(({ readFile }) =>
            readFile(`${target.root}/tailcat-invocations`, "utf8"),
        );
        expect(invocations).toContain("mobile.private.json serve exec -- ");
        expect(invocations).not.toContain("default.private.json");
    });

    it("completes in either order of confirmation", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        expect((await target.mobile.snapshot(target.ctx)).pairing?.desktopConfirmed).toBe(true);
        await expect(session.confirm()).resolves.toMatchObject({ address: FAKE_TAILCAT_ADDRESS });
        expect(await storedDevices(target)).toHaveLength(1);
    });

    it("knows each credential only while it can be used", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const token = parseQr(started.pairing!.qr!).t;
        await expect(target.mobile.authenticate(target.ctx, `Bearer ${token}`)).resolves.toEqual({
            kind: "pairing",
            token,
        });
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        // The token was consumed by the start, and the handshake credential replaced it.
        await expect(target.mobile.authenticate(target.ctx, `Bearer ${token}`)).resolves.toBe(
            undefined,
        );
        await expect(
            target.mobile.authenticate(target.ctx, `Bearer ${session.handshakeId}`),
        ).resolves.toEqual({ kind: "handshake", handshakeId: session.handshakeId });
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        const paired = await session.confirm();

        const device = await target.mobile.authenticate(target.ctx, `Bearer ${paired.deviceToken}`);
        expect(device).toMatchObject({
            kind: "device",
            deviceId: paired.deviceId,
            owner: "standalone",
        });
        for (const authorization of [
            undefined,
            "",
            paired.deviceToken,
            `Basic ${paired.deviceToken}`,
            `Bearer ${randomBytes(32).toString("base64url")}`,
            "Bearer local-api-token",
            ["Bearer x", `Bearer ${paired.deviceToken}`],
        ]) {
            await expect(target.mobile.authenticate(target.ctx, authorization)).resolves.toBe(
                undefined,
            );
        }
    });

    it("lets a leaked code start once and never pair without the desktop person", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const attacker = await startPhonePairing(started.pairing!.qr!, phone(target));
        await expect(startPhonePairing(started.pairing!.qr!, phone(target))).rejects.toMatchObject({
            code: "unauthorized",
            status: 401,
        });

        const confirming = attacker.confirm();
        confirming.catch(() => undefined);
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        // The desktop person sees emoji that do not match their own phone and cancels.
        await target.mobile.cancelPairing(target.ctx, started.pairing!.id);
        await expect(confirming).rejects.toMatchObject({ code: "rejected" });
        expect(await storedDevices(target)).toEqual([]);
        const cancelled = await target.mobile.snapshot(target.ctx);
        expect(cancelled.pairing).toMatchObject({ status: "cancelled", emoji: attacker.emoji });
        await waitForStatus(target, "closed");

        // A second cancel dismisses the finished pairing; a third changes nothing.
        await target.mobile.cancelPairing(target.ctx, started.pairing!.id);
        await target.mobile.cancelPairing(target.ctx, started.pairing!.id);
        expect((await target.mobile.snapshot(target.ctx)).pairing).toBeNull();
    });

    it("leaves nothing behind when the phone says the emoji differ", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        await session.reject();
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("rejected");
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await storedDevices(target)).toEqual([]);
        await waitForStatus(target, "closed");
    });

    it("fails a phone whose revealed key does not match its commitment", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const qr = parseQr(started.pairing!.qr!);
        const committed = phoneKey();
        const nonce = randomBytes(32);
        const { handshakeId } = await phoneRequest<{ handshakeId: string }>(
            phone(target),
            "POST",
            HANDSHAKE,
            qr.t,
            { commitment: commitment(committed.publicKey, nonce).toString("base64url"), device },
        );
        const other = phoneKey();
        await expect(
            phoneRequest(phone(target), "POST", `${HANDSHAKE}/reveal`, handshakeId, {
                publicKey: other.publicKey.toString("base64url"),
                nonce: nonce.toString("base64url"),
            }),
        ).resolves.toEqual({ status: "rejected" });
        expect((await target.mobile.snapshot(target.ctx)).pairing).toMatchObject({
            status: "failed",
            error: "The phone's key did not match the one it committed to.",
        });
        await expect(phoneRequest(phone(target), "GET", HANDSHAKE, handshakeId)).resolves.toEqual({
            status: "rejected",
        });
    });

    it("spends the code on a malformed start", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const qr = parseQr(started.pairing!.qr!);
        await expect(
            phoneRequest(phone(target), "POST", HANDSHAKE, qr.t, { commitment: "short", device }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("failed");
        await expect(startPhonePairing(started.pairing!.qr!, phone(target))).rejects.toMatchObject({
            status: 401,
        });
    });

    it("fails a phone that sends the wrong confirmation MAC", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const qr = parseQr(started.pairing!.qr!);
        const keys = phoneKey();
        const nonce = randomBytes(32);
        const { handshakeId } = await phoneRequest<{ handshakeId: string }>(
            phone(target),
            "POST",
            HANDSHAKE,
            qr.t,
            { commitment: commitment(keys.publicKey, nonce).toString("base64url"), device },
        );
        await phoneRequest(phone(target), "POST", `${HANDSHAKE}/reveal`, handshakeId, {
            publicKey: keys.publicKey.toString("base64url"),
            nonce: nonce.toString("base64url"),
        });
        await target.mobile.confirmPairing(target.ctx, started.pairing!.id);
        await expect(
            phoneRequest(phone(target), "POST", `${HANDSHAKE}/confirm`, handshakeId, {
                mac: randomBytes(32).toString("base64url"),
            }),
        ).resolves.toEqual({ status: "rejected" });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("failed");
        expect(await storedDevices(target)).toEqual([]);
    });

    it("expires a pairing that is not finished within five minutes", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1_000);
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).rejects.toMatchObject({ code: "conflict" });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("expired");
        await expect(session.confirm()).rejects.toMatchObject({ code: "expired" });
        expect(await storedDevices(target)).toEqual([]);
    });

    it("completes only when the device row commits with the caller's transaction", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        const confirming = session.confirm();
        confirming.catch(() => undefined);
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        await expect(
            target.ctx.inTx(async (txCtx) => {
                await target.mobile.confirmPairing(txCtx, started.pairing!.id);
                expect(await storedDevices({ ...target, ctx: txCtx })).toHaveLength(1);
                expect((await target.mobile.snapshot(txCtx)).pairing?.status).toBe("verifying");
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        expect(await storedDevices(target)).toEqual([]);
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("verifying");

        // The claimed completion cannot be repeated; the pairing ends by its deadline instead,
        // which the next access notices and the phone's waiting status read reports.
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).resolves.toMatchObject({ pairing: { status: "verifying" } });
        expect(await storedDevices(target)).toEqual([]);
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1_000);
        await expect(
            target.mobile.confirmPairing(target.ctx, started.pairing!.id),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(confirming).rejects.toMatchObject({ code: "expired" });
        expect(await storedDevices(target)).toEqual([]);
    });

    it("removes the device again when the pairing ended before its commit was seen", async () => {
        const target = await world();
        const started = await target.mobile.startPairing(target.ctx);
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        const confirming = session.confirm();
        confirming.catch(() => undefined);
        await vi.waitFor(async () => {
            expect((await target.mobile.snapshot(target.ctx)).pairing?.mobileConfirmed).toBe(true);
        });
        await target.ctx.inTx(async (txCtx) => {
            await target.mobile.confirmPairing(txCtx, started.pairing!.id);
            await target.mobile.cancelPairing(txCtx, started.pairing!.id);
        });
        await expect(confirming).rejects.toMatchObject({ code: "rejected" });
        await vi.waitFor(async () => {
            expect(await storedDevices(target)).toEqual([]);
        });
        expect((await target.mobile.snapshot(target.ctx)).pairing?.status).toBe("cancelled");
    });

    it("replaces the previous pairing when a new one starts", async () => {
        const target = await world();
        const first = await target.mobile.startPairing(target.ctx);
        const second = await target.mobile.startPairing(target.ctx);
        expect(second.pairing?.id).not.toBe(first.pairing?.id);
        await expect(startPhonePairing(first.pairing!.qr!, phone(target))).rejects.toMatchObject({
            code: "unauthorized",
        });
        await expect(
            target.mobile.confirmPairing(target.ctx, first.pairing!.id),
        ).rejects.toMatchObject({ code: "not_found" });
    });

    it("revokes a device, signalling its connections to close, then closes the unused socket", async () => {
        const target = await world();
        const paired = await pairedPhone(target);
        const device = await target.mobile.authenticate(target.ctx, `Bearer ${paired.deviceToken}`);
        if (device?.kind !== "device") throw new Error("The device token was not accepted.");
        expect(device.revoked.aborted).toBe(false);

        const revoked = await target.mobile.revokeDevice(target.ctx, paired.deviceId);
        expect(revoked.devices).toEqual([]);
        expect(device.revoked.aborted).toBe(true);
        await expect(
            target.mobile.authenticate(target.ctx, `Bearer ${paired.deviceToken}`),
        ).resolves.toBe(undefined);
        await waitForStatus(target, "closed");
        await expect(target.mobile.revokeDevice(target.ctx, paired.deviceId)).rejects.toThrow(
            MobileConnectorError,
        );
    });

    it("joins its caller's transaction when revoking, so a rollback keeps the device", async () => {
        const target = await world();
        const paired = await pairedPhone(target);
        const device = await target.mobile.authenticate(target.ctx, `Bearer ${paired.deviceToken}`);
        // The pairing's own reconciliation must have run, so only the revoke's is counted.
        await vi.waitFor(async () => {
            expect(await pendingCallCount(target.ctx)).toBe(0);
        });
        const announced = target.events.length;
        await expect(
            target.ctx.inTx(async (txCtx) => {
                await target.mobile.revokeDevice(txCtx, paired.deviceId);
                expect(await pendingCallCount(txCtx)).toBe(1);
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        expect(await storedDevices(target)).toHaveLength(1);
        expect(await pendingCallCount(target.ctx)).toBe(0);
        expect(
            target.events
                .slice(announced)
                .some((event) => event.mobileConnector.devices.length === 0),
        ).toBe(false);
        expect(device?.kind === "device" && device.revoked.aborted).toBe(false);
        await expect(
            target.mobile.authenticate(target.ctx, `Bearer ${paired.deviceToken}`),
        ).resolves.toMatchObject({ kind: "device", deviceId: paired.deviceId });
    });

    it("reopens the socket once the transport is attached when devices exist", async () => {
        const first = await world();
        const paired = await pairedPhone(first);
        await first.stop();

        const restarted = await mobileConnectorWorld({
            port: first.port,
            after: first,
            detached: true,
        });
        worlds.push({ ...restarted, close: restarted.stop });
        // Nothing can be exposed before the API listens for it.
        expect((await restarted.mobile.snapshot(restarted.ctx)).status).toBe("closed");
        restarted.mobile.attachTransport(restarted.ctx, UNUSED_TRANSPORT);
        await waitForStatus(restarted, "open");
        await expect(
            restarted.mobile.authenticate(restarted.ctx, `Bearer ${paired.deviceToken}`),
        ).resolves.toMatchObject({ kind: "device", deviceId: paired.deviceId });
        expect((await restarted.mobile.snapshot(restarted.ctx)).pairing).toBeNull();
    });

    it("fails a pairing started before the transport is attached", async () => {
        const target = await world({ detached: true });
        const started = await target.mobile.startPairing(target.ctx);
        expect(started.status).toBe("failed");
        expect(started.pairing).toMatchObject({
            status: "failed",
            qr: null,
            error: "The phone connection socket is not ready yet.",
        });
    });

    it("opens its socket and shows its port while another program holds that port", async () => {
        const target = await world();
        // Every Happy Agent on a computer shares the default, so another one may hold it.
        const occupant = createServer();
        await new Promise<void>((resolve, reject) => {
            occupant.once("error", reject);
            occupant.listen(target.port, "127.0.0.1", resolve);
        });
        try {
            const started = await target.mobile.startPairing(target.ctx);
            expect(started).toMatchObject({ status: "open", error: null });
            expect(parseQr(started.pairing!.qr!)).toMatchObject({ p: target.port });
        } finally {
            await new Promise<void>((resolve) => occupant.close(() => resolve()));
        }
    });

    it("announces each owner's snapshots with increasing versions", async () => {
        const target = await world();
        await pairedPhone(target);
        await vi.waitFor(() => {
            expect(target.events.at(-1)?.mobileConnector.pairing?.status).toBe("completed");
        });
        const versions = target.events.map((event) => event.mobileConnector.version);
        expect(target.events.every((event) => event.owner === "standalone")).toBe(true);
        expect([...versions].sort()).toEqual(versions);
        expect(new Set(versions).size).toBe(versions.length);
        expect(target.events.map((event) => event.mobileConnector.pairing?.status)).toEqual(
            expect.arrayContaining(["waiting", "verifying", "completed"]),
        );
    });

    it("refuses to pair while the feature is turned off", async () => {
        const target = await world({ enabled: false });
        expect((await target.mobile.snapshot(target.ctx)).status).toBe("disabled");
        await expect(target.mobile.startPairing(target.ctx)).rejects.toMatchObject({
            code: "unsupported",
            status: 503,
        });
    });

    it("keeps each team member's pairing and devices to themselves", async () => {
        const target = await world({ team: true });
        const alice = member(target.ctx, "alice0000000000000000001");
        const bob = member(target.ctx, "bob00000000000000000000002");
        await expect(target.mobile.snapshot(target.ctx)).rejects.toThrow();
        const started = await target.mobile.startPairing(alice);
        const session = await startPhonePairing(started.pairing!.qr!, phone(target));
        await expect(target.mobile.confirmPairing(bob, started.pairing!.id)).rejects.toMatchObject({
            code: "not_found",
        });
        await target.mobile.confirmPairing(alice, started.pairing!.id);
        const paired = await session.confirm();
        expect((await target.mobile.snapshot(bob)).devices).toEqual([]);
        expect((await target.mobile.snapshot(bob)).pairing).toBeNull();
        expect((await target.mobile.snapshot(alice)).devices).toHaveLength(1);
        await expect(target.mobile.revokeDevice(bob, paired.deviceId)).rejects.toMatchObject({
            code: "not_found",
        });
        expect((await storedDevices(target))[0]?.owner_id).toBe("alice0000000000000000001");
    });
});

function member(ctx: MobileConnectorWorld["ctx"], id: string) {
    return withTeamUser(ctx, {
        id,
        authentication: "workos",
        subject: `user_${id}`,
        firstName: "Test",
        lastName: null,
        email: `${id}@example.com`,
        isOwner: false,
        photo: null,
        createdAt: 0,
        updatedAt: 0,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    } as TeamUser);
}
