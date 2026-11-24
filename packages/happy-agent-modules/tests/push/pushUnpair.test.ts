import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { pushMigrations } from "../../sources/push/PushMigrations.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

import {
    ALICE,
    BOB,
    id,
    member,
    notice,
    NOW,
    phone,
    startWorld,
    stubRelay,
    THIRTY_DAYS,
    token,
} from "./support/pushWorld.js";

const ALICE_PHONE = "alicephone00000000000001";
const ALICE_TABLET = "alicetablet0000000000002";
const BOB_PHONE = "bobphone0000000000000003";

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("forgets where to notify a phone the moment it is unpaired, and keeps every other phone", async () => {
    const world = await startWorld("push-unpair", { team: true });
    try {
        const alice = member(world.ctx, ALICE);
        const bob = member(world.ctx, BOB);
        await world.push.register(alice, id(1), phone(1), ALICE_PHONE);
        await world.push.register(alice, id(2), phone(2), ALICE_TABLET);
        // Registered with her own sign-in rather than through a paired phone.
        await world.push.register(alice, id(3), phone(3));
        await world.push.register(bob, id(4), phone(4), BOB_PHONE);
        const relay = stubRelay();

        await world.unpair(world.ctx, ALICE, ALICE_PHONE);

        await world.send(ALICE, notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(2), token(3)]);
        await world.send(BOB, notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(2), token(3), token(4)]);
        expect(world.logs.join("\n")).toContain(
            `push:registration outcome=device_removed deviceId=${ALICE_PHONE} removed=1`,
        );
        expect(world.logs.join("\n")).not.toContain("HappyPushToken[");
    } finally {
        world.close();
    }
});

it("never removes one person's registrations for another person's phone", async () => {
    const world = await startWorld("push-unpair-owner", { team: true });
    try {
        await world.push.register(member(world.ctx, ALICE), id(1), phone(1), ALICE_PHONE);
        const relay = stubRelay();

        // The connector names the owner it removed the phone from; Bob never held this one.
        await world.unpair(world.ctx, BOB, ALICE_PHONE);

        await world.send(ALICE, notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);
    } finally {
        world.close();
    }
});

it("follows a registration to the phone that renewed it last", async () => {
    const world = await startWorld("push-unpair-renew", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1), ALICE_PHONE);
        // The same app, paired again under a new device, renews its registration.
        await world.push.register(world.ctx, id(1), phone(1), ALICE_TABLET);
        const relay = stubRelay();

        await world.unpair(world.ctx, "standalone", ALICE_PHONE);
        await world.send("standalone", notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);

        await world.unpair(world.ctx, "standalone", ALICE_TABLET);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(1);
        expect(world.logs.join("\n")).toContain("push:delivery outcome=no_phones");
    } finally {
        world.close();
    }
});

it("keeps the registration when the unpairing rolls back", async () => {
    const world = await startWorld("push-unpair-rollback", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1), ALICE_PHONE);
        const relay = stubRelay();

        await expect(
            world.ctx.inTx(async (txCtx) => {
                await world.unpair(txCtx, "standalone", ALICE_PHONE);
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");

        await world.send("standalone", notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);
    } finally {
        world.close();
    }
});

it("does not start a request to a phone unpaired while the notification was going out", async () => {
    const world = await startWorld("push-unpair-race", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1), ALICE_PHONE);
        await world.push.register(world.ctx, id(2), phone(2), ALICE_TABLET);
        // The second phone is unpaired while the relay is still answering for the first.
        const relay = stubRelay(async () => {
            if (relay.length === 1) await world.unpair(world.ctx, "standalone", ALICE_TABLET);
            return Response.json({ data: [{ status: "ok", id: "ticket-1" }] });
        });

        await world.send("standalone", notice);

        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);
    } finally {
        world.close();
    }
});

it("does not send a notification queued before the unpairing", async () => {
    const world = await startWorld("push-unpair-queued", { team: false });
    try {
        await world.push.register(world.ctx, id(1), phone(1), ALICE_PHONE);
        const relay = stubRelay();

        // One transaction asks for the notification and removes the phone: the send was accepted
        // while the phone was still paired, and runs only after it is gone.
        await world.ctx.inTx(async (txCtx) => {
            await world.push.send(txCtx, "standalone", notice);
            await world.unpair(txCtx, "standalone", ALICE_PHONE);
        });
        await world.settle();

        expect(relay).toEqual([]);
    } finally {
        world.close();
    }
});

it("upgrades a database that already holds registrations without losing or orphaning them", async () => {
    // The database as the first push release left it: one table version, rows with no device.
    const durable = new DurableFunctionsModule();
    const [first, ...later] = pushMigrations;
    const database = moduleDatabase([...durable.migrations, first!], "push-unpair-upgrade");
    await database.ready;
    await agentDatabaseRun(
        database.database,
        sql`INSERT INTO happy_agent_push_registrations
            (id, owner_id, version, token, platform, app_id, locale, expires_at)
            VALUES (${id(1)}, 'standalone', '0197f0c2-7d1e-4c3a-b0a5-2a4b6c8d0e1f', ${token(1)},
                'ios', 'com.ex3ndr.happy', NULL, ${NOW + THIRTY_DAYS})`,
    );
    expect(later).toHaveLength(1);
    for (const [, migrate] of later) await migrate(database.context, database.database);

    const world = await startWorld("push-unpair-upgrade", { team: false, database });
    try {
        const relay = stubRelay();
        // The old registration still receives, and no unpairing takes it: nobody knows its phone.
        await world.unpair(world.ctx, "standalone", ALICE_PHONE);
        await world.send("standalone", notice);
        expect(relay.map((request) => request.body.to)).toEqual([token(1)]);
        expect(
            await agentDatabaseRows(
                database.database,
                sql`SELECT id, device_id FROM happy_agent_push_registrations`,
            ),
        ).toEqual([{ id: id(1), device_id: null }]);

        // Its phone renews as phones do, and from then on unpairing that phone removes it.
        await world.push.register(world.ctx, id(1), phone(1), ALICE_PHONE);
        await world.unpair(world.ctx, "standalone", ALICE_PHONE);
        await world.send("standalone", notice);
        expect(relay).toHaveLength(1);
    } finally {
        world.close();
    }
});
