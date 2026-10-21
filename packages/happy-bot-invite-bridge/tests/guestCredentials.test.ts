import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestStore } from "../sources/persistence/GuestStore.js";

const nonce = () => randomBytes(32).toString("base64url");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
    const path = await mkdtemp(join(tmpdir(), "clip-guests-"));
    cleanups.push(async () => await rm(path, { recursive: true, force: true }));
    const store = await GuestStore.open(path);
    cleanups.push(async () => await store.close());
    const invite = await store.createInvite({
        botId: "a",
        botName: "A",
        maxMembers: 1,
        expiresAt: Date.now() + 86_400_000,
        readOnly: false,
    });
    await store.approve(invite.id, invite.groupUserId);
    return { store, invite, path };
}

describe("invitation credentials and isolated history", () => {
    it("bounds retained history without discarding accepted replies or breaking pagination", async () => {
        const { store, invite } = await fixture();
        const session = await store.redeem(invite.token, nonce(), "a", "Guest");
        const start = Date.now();
        const clock = vi.spyOn(Date, "now");
        for (let index = 0; index < 100; index++) {
            clock.mockReturnValue(start + index * 6_001);
            await store.send(session.sessionId, session.sessionToken, "a", {
                localId: String(index),
                text: `Message ${index}`,
            });
            await store.reply("a", {
                seq: index + 1,
                userId: invite.groupUserId,
                chatId: invite.groupUserId,
                text: `Reply ${index}`,
            });
        }
        await expect(
            store.send(session.sessionId, session.sessionToken, "a", {
                localId: "over-limit",
                text: "One more",
            }),
        ).rejects.toMatchObject({ status: 429 });
        const firstPage = await store.read(session.sessionId, session.sessionToken, "a", 0);
        const secondPage = await store.read(
            session.sessionId,
            session.sessionToken,
            "a",
            Number(firstPage.cursor),
        );
        expect(firstPage.messages).toHaveLength(100);
        expect(secondPage.messages).toHaveLength(100);
        expect(secondPage.messages.at(-1)?.text).toBe("Reply 99");
        expect(Number(secondPage.cursor)).toBeGreaterThan(Number(firstPage.cursor));
        expect(
            (
                await store.read(
                    session.sessionId,
                    session.sessionToken,
                    "a",
                    Number(secondPage.cursor),
                )
            ).messages,
        ).toEqual([]);
    });
    it("atomically binds one redeem nonce, recovers a lost response, rotates the bearer, and revokes recovery", async () => {
        const { store, invite, path } = await fixture();
        const redeemNonce = nonce();
        const first = await store.redeem(invite.token, redeemNonce, "a", "Guest");
        const recovered = await store.redeem(invite.token, redeemNonce, "a", "Changed name");
        expect(recovered.sessionId).toBe(first.sessionId);
        expect(recovered.sessionToken).not.toBe(first.sessionToken);
        expect(recovered.expiresAt).toBe(first.expiresAt);
        await expect(
            store.authorize(first.sessionId, first.sessionToken, "a"),
        ).rejects.toMatchObject({ status: 404 });
        await expect(store.redeem(invite.token, nonce(), "a", "Guest")).rejects.toMatchObject({
            status: 410,
            code: "invite_full",
        });
        await store.authorize(recovered.sessionId, recovered.sessionToken, "a");
        // Neither bearer nor invitation secret is in SQLite or its WAL.
        for (const file of ["guests-v3.sqlite", "guests-v3.sqlite-wal"]) {
            const data = await readFile(join(path, file)).catch(() => Buffer.alloc(0));
            for (const value of [
                invite.token,
                redeemNonce,
                first.sessionToken,
                recovered.sessionToken,
            ])
                expect(data.includes(value)).toBe(false);
        }
        await store.revoke(invite.id);
        await expect(
            store.read(recovered.sessionId, recovered.sessionToken, "a", 0),
        ).rejects.toMatchObject({ status: 404 });
        await expect(store.redeem(invite.token, redeemNonce, "a", "Guest")).rejects.toMatchObject({
            status: 404,
        });
    });

    it("allows one winning person under concurrent redemption requests", async () => {
        const { store, invite } = await fixture();
        const results = await Promise.allSettled([
            store.redeem(invite.token, nonce(), "a", "Guest"),
            store.redeem(invite.token, nonce(), "a", "Guest"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const failure = results.find((result) => result.status === "rejected");
        expect(failure).toMatchObject({
            status: "rejected",
            reason: { status: 410, code: "invite_full" },
        });
    });

    it("keeps sessions independent of the redeem window and enforces session expiry on reads and queued delivery", async () => {
        const { store, invite } = await fixture();
        const start = Date.now();
        const session = await store.redeem(invite.token, nonce(), "a", "Guest");
        await store.send(session.sessionId, session.sessionToken, "a", {
            localId: "one",
            text: "Hello",
        });
        vi.spyOn(Date, "now").mockReturnValue(start + 2 * 86_400_000);
        await store.authorize(session.sessionId, session.sessionToken, "a");
        expect(await store.pending("a")).toHaveLength(1);
        await expect(store.redeem(invite.token, nonce(), "a", "Guest")).rejects.toMatchObject({
            status: 410,
        });
        vi.spyOn(Date, "now").mockReturnValue(session.expiresAt + 1);
        await expect(
            store.read(session.sessionId, session.sessionToken, "a", 0),
        ).rejects.toMatchObject({ status: 410 });
        await expect(
            store.send(session.sessionId, session.sessionToken, "a", {
                localId: "two",
                text: "Again",
            }),
        ).rejects.toMatchObject({ status: 410 });
        expect(await store.pending("a")).toHaveLength(0);
    });

    it("isolates bots and people, deduplicates sends and replies, and stores no attachment paths", async () => {
        const { store, invite } = await fixture();
        const otherInvite = await store.createInvite({
            botId: "b",
            botName: "B",
            maxMembers: 1,
            expiresAt: Date.now() + 86_400_000,
            readOnly: false,
        });
        await store.approve(otherInvite.id, otherInvite.groupUserId);
        const a = await store.redeem(invite.token, nonce(), "a", "Guest");
        const b = await store.redeem(otherInvite.token, nonce(), "b", "Other");
        await expect(store.read(a.sessionId, b.sessionToken, "a", 0)).rejects.toMatchObject({
            status: 404,
        });
        await store.send(a.sessionId, a.sessionToken, "a", { localId: "same", text: "A only" });
        await store.send(a.sessionId, a.sessionToken, "a", { localId: "same", text: "A only" });
        await expect(
            store.send(a.sessionId, a.sessionToken, "a", { localId: "same", text: "Changed" }),
        ).rejects.toMatchObject({ status: 409 });
        await store.send(b.sessionId, b.sessionToken, "b", { localId: "same", text: "B only" });
        expect(await store.pending("a")).toHaveLength(1);
        await store.reply("b", {
            seq: 1,
            userId: invite.groupUserId,
            chatId: invite.groupUserId,
            text: "Wrong bot",
        });
        await store.reply("a", {
            seq: 1,
            userId: invite.groupUserId,
            chatId: otherInvite.groupUserId,
            text: "Wrong chat",
        });
        const reply = {
            seq: 1,
            userId: invite.groupUserId,
            chatId: invite.groupUserId,
            text: "For A",
        };
        await store.reply("a", reply);
        await store.reply("a", reply);
        await store.reply("b", {
            seq: 1,
            userId: otherInvite.groupUserId,
            chatId: otherInvite.groupUserId,
        });
        expect(
            (await store.read(a.sessionId, a.sessionToken, "a", 0)).messages.map(
                (message) => message.text,
            ),
        ).toEqual(["A only", "For A"]);
        const history = await store.read(b.sessionId, b.sessionToken, "b", 0);
        expect(history.messages.map((message) => message.text)).toEqual([
            "B only",
            "The bot shared a file. Files are not available in this chat.",
        ]);
        expect(await store.read(b.sessionId, b.sessionToken, "b", Number(history.cursor))).toEqual({
            messages: [],
            cursor: history.cursor,
        });
    });

    it("enforces read-only sessions, report metadata, block, and per-session send limits", async () => {
        const { store, invite } = await fixture();
        const readonlyInvite = await store.createInvite({
            botId: "a",
            botName: "A",
            maxMembers: 1,
            expiresAt: Date.now() + 86_400_000,
            readOnly: true,
        });
        await expect(
            store.redeem(readonlyInvite.token, nonce(), "a", "Reader"),
        ).rejects.toMatchObject({
            status: 503,
        });
        await store.approve(readonlyInvite.id, readonlyInvite.groupUserId);
        const reader = await store.redeem(readonlyInvite.token, nonce(), "a", "Reader");
        await expect(
            store.send(reader.sessionId, reader.sessionToken, "a", { localId: "one", text: "No" }),
        ).rejects.toMatchObject({ status: 403 });
        const session = await store.redeem(invite.token, nonce(), "a", "Guest");
        for (let i = 0; i < 10; i++)
            await store.send(session.sessionId, session.sessionToken, "a", {
                localId: String(i),
                text: "Hello",
            });
        await expect(
            store.send(session.sessionId, session.sessionToken, "a", {
                localId: "limit",
                text: "Hello",
            }),
        ).rejects.toMatchObject({ status: 429 });
        await store.abuse(session.sessionId, session.sessionToken, "a", "report");
        expect(await store.reports()).toEqual([
            { inviteId: invite.id, memberId: session.memberId, reportedAt: expect.any(Number) },
        ]);
        await store.abuse(session.sessionId, session.sessionToken, "a", "block");
        await expect(
            store.authorize(session.sessionId, session.sessionToken, "a"),
        ).rejects.toMatchObject({ status: 404 });
        expect(await store.pending("a")).toEqual([]);
    });
});
