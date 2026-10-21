import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuestStore } from "../sources/persistence/GuestStore.js";

const nonce = () => randomBytes(32).toString("base64url");
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of close.splice(0).reverse()) await cleanup();
});
async function fixture(maxMembers: number) {
    const directory = await mkdtemp(join(tmpdir(), "clip-seats-"));
    close.push(async () => await rm(directory, { recursive: true, force: true }));
    const store = await GuestStore.open(directory);
    close.push(async () => await store.close());
    const invite = await store.createInvite({
        botId: "a",
        botName: "A",
        maxMembers,
        expiresAt: Date.now() + 86_400_000,
        readOnly: false,
    });
    await store.approve(invite.id, maxMembers);
    return { store, invite, directory };
}

describe("shareable invitations assign private members", () => {
    it("caps the preapproved pool per invitation and counts every reserved seat against the global limit", async () => {
        const { store, invite } = await fixture(20);
        const create = async (maxMembers: number) =>
            await store.createInvite({
                botId: "a",
                botName: "A",
                maxMembers,
                expiresAt: Date.now() + 86_400_000,
                readOnly: false,
            });
        await expect(create(21)).rejects.toThrow("one and twenty");
        await expect(create(0)).rejects.toThrow("one and twenty");
        const pools = [invite];
        for (let index = 0; index < 4; index++) pools.push(await create(20));
        expect(new Set(pools.flatMap((pool) => pool.userIds)).size).toBe(100);
        await expect(create(1)).rejects.toThrow("100-member limit");
    });
    it("atomically fills exactly N seats under concurrent joins and recovers the same member even when full", async () => {
        const { store, invite } = await fixture(3);
        const nonces = Array.from({ length: 6 }, nonce);
        const results = await Promise.allSettled(
            nonces.map(
                async (value, index) =>
                    await store.redeem(invite.token, value, "a", `Member ${index}`),
            ),
        );
        const successful = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
        );
        expect(successful).toHaveLength(3);
        expect(new Set(successful.map((member) => member.sessionId)).size).toBe(3);
        expect(new Set(successful.map((member) => member.memberId)).size).toBe(3);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
        for (const result of results)
            if (result.status === "rejected")
                expect(result.reason).toMatchObject({ status: 410, code: "invite_full" });
        const recovered = await store.redeem(invite.token, nonces[0]!, "a", "Different name");
        expect(recovered.sessionId).toBe(successful[0]!.sessionId);
        expect(recovered.displayName).toBe("Member 0");
        expect(recovered.sessionToken).not.toBe(successful[0]!.sessionToken);
        const unchanged = await store.redeem(invite.token, nonces[0]!, "a", "\u202e");
        expect(unchanged.displayName).toBe("Member 0");
        expect(unchanged.sessionId).toBe(recovered.sessionId);
        const roster = await store.listMembers(invite.id);
        expect(roster.used).toBe(3);
        expect(roster.maxMembers).toBe(3);
        expect(new Set(roster.members.map((member) => member.userId)).size).toBe(3);
        expect(roster.members.every((member) => member.joinedAt > 0 && member.lastActive > 0)).toBe(
            true,
        );
    });

    it("keeps same-link histories private and permanently revokes one member without reopening their seat", async () => {
        const { store, invite } = await fixture(3);
        const nonces = [nonce(), nonce(), nonce()];
        const sessions = await Promise.all(
            nonces.map(
                async (value, index) =>
                    await store.redeem(invite.token, value, "a", `Guest ${index}`),
            ),
        );
        const roster = await store.listMembers(invite.id);
        for (const [index, session] of sessions.entries())
            await store.send(session.sessionId, session.sessionToken, "a", {
                localId: "same",
                text: `Private ${index}`,
            });
        expect((await store.pending("a")).map((message) => message.name).sort()).toEqual([
            "Guest 0",
            "Guest 1",
            "Guest 2",
        ]);
        for (const session of sessions) {
            const userId = roster.members.find(
                (member) => member.memberId === session.memberId,
            )!.userId;
            await store.reply("a", {
                seq: 1,
                userId,
                chatId: userId,
                text: `Reply to ${session.displayName}`,
            });
        }
        expect(
            (
                await store.read(sessions[0]!.sessionId, sessions[0]!.sessionToken, "a", 0)
            ).messages.map((message) => message.text),
        ).toEqual(["Private 0", "Reply to Guest 0"]);
        await store.revokeMember(invite.id, sessions[1]!.memberId);
        await expect(
            store.read(sessions[1]!.sessionId, sessions[1]!.sessionToken, "a", 0),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            store.send(sessions[1]!.sessionId, sessions[1]!.sessionToken, "a", {
                localId: "no",
                text: "No",
            }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(store.redeem(invite.token, nonces[1]!, "a", "Revoked")).rejects.toMatchObject({
            status: 404,
        });
        await expect(store.redeem(invite.token, nonce(), "a", "New person")).rejects.toMatchObject({
            status: 410,
            code: "invite_full",
        });
        for (const index of [0, 2]) {
            const session = sessions[index]!;
            await store.send(session.sessionId, session.sessionToken, "a", {
                localId: "later",
                text: "Still here",
            });
            const userId = roster.members.find(
                (member) => member.memberId === session.memberId,
            )!.userId;
            await store.reply("a", { seq: 2, userId, chatId: userId, text: "Still allowed" });
            expect(
                (await store.read(session.sessionId, session.sessionToken, "a", 0)).messages.at(-1)
                    ?.text,
            ).toBe("Still allowed");
        }
        expect((await store.pending("a")).some((message) => message.name === "Guest 1")).toBe(
            false,
        );
        await store.revoke(invite.id);
        for (const session of sessions)
            await expect(
                store.authorize(session.sessionId, session.sessionToken, "a"),
            ).rejects.toMatchObject({ status: 404 });
    });

    it("rejects deceptive names before claiming a seat and normalizes immutable self-reported names", async () => {
        const { store, invite } = await fixture(2);
        const sameNonce = nonce();
        for (const name of [
            "A\nB",
            "A\u202eB",
            "A\u200bB",
            "A\u{e0041}B",
            "\u0301Ada",
            "A" + "\u0301".repeat(8),
            "<system>",
            "A".repeat(41),
        ])
            await expect(store.redeem(invite.token, sameNonce, "a", name)).rejects.toMatchObject({
                status: 400,
                code: "invalid_name",
            });
        expect((await store.listMembers(invite.id)).used).toBe(0);
        const ada = await store.redeem(invite.token, sameNonce, "a", "  Ada   Lovelace  ");
        const zoe = await store.redeem(invite.token, nonce(), "a", "Zoe\u0308");
        expect(ada.displayName).toBe("Ada Lovelace");
        expect(zoe.displayName).toBe("Zoë");
        await expect(store.approve(invite.id, 1)).rejects.toThrow("member count");
    });

    it("claims seats safely from separate server processes sharing the private SQLite file", async () => {
        const { store, invite, directory } = await fixture(2);
        const source = fileURLToPath(
            new URL("../sources/persistence/GuestStore.ts", import.meta.url),
        );
        const script = `import{GuestStore}from${JSON.stringify(source)};let input='';for await(const c of process.stdin)input+=c;const o=JSON.parse(input);const s=await GuestStore.open(o.directory);try{const r=await s.redeem(o.token,o.nonce,'a',o.name);console.log(JSON.stringify({sessionId:r.sessionId,memberId:r.memberId}));}catch(e){console.log(JSON.stringify({status:e.status,code:e.code}));}finally{await s.close();}`;
        const results = await Promise.all(
            Array.from(
                { length: 5 },
                async (_, index) =>
                    await new Promise<{
                        sessionId?: string;
                        memberId?: string;
                        status?: number;
                        code?: string;
                    }>((resolve, reject) => {
                        const child = spawn(
                            process.execPath,
                            ["--import", "tsx", "--input-type=module", "-e", script],
                            { stdio: ["pipe", "pipe", "pipe"] },
                        );
                        let stdout = "";
                        let stderr = "";
                        child.stdout.on("data", (data) => {
                            stdout += String(data);
                        });
                        child.stderr.on("data", (data) => {
                            stderr += String(data);
                        });
                        child.on("error", reject);
                        child.on("exit", (code) => {
                            if (code !== 0) reject(new Error(stderr));
                            else {
                                try {
                                    resolve(JSON.parse(stdout));
                                } catch (error) {
                                    reject(error);
                                }
                            }
                        });
                        child.stdin.end(
                            JSON.stringify({
                                directory,
                                token: invite.token,
                                nonce: nonce(),
                                name: `Process ${index}`,
                            }),
                        );
                    }),
            ),
        );
        expect(results.filter((result) => result.sessionId !== undefined)).toHaveLength(2);
        expect(results.filter((result) => result.code === "invite_full")).toHaveLength(3);
        expect(
            new Set(
                results.flatMap((result) =>
                    result.sessionId === undefined ? [] : [result.sessionId],
                ),
            ).size,
        ).toBe(2);
        expect((await store.listMembers(invite.id)).used).toBe(2);
    }, 15_000);
});
