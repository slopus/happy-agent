import { agentDatabaseRows, ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import type { ViewerTarget, ViewersUpdatedFrame } from "@slopus/happy-agent-client";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ViewersModule } from "../../sources/viewers/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const closers: (() => void)[] = [];
afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
});

const agent: ViewerTarget = { type: "agent", id: "agentone" };

async function world() {
    const database = moduleDatabase(new ViewersModule().migrations, "viewers-test");
    // Transactions queue as they do in the daemon, so an erase can land between two of them.
    ensureAgentDatabaseConnection(database.database);
    closers.push(database.close);
    await database.ready;
    const ctx = database.context;
    /** A daemon process: a fresh module over the same stored rows. */
    const start = () => {
        const viewers = new ViewersModule();
        const hooks = viewers.beforeStart(ctx);
        const frames: [string, ViewersUpdatedFrame][] = [];
        viewers.onFrame((streamId, frame) => frames.push([streamId, frame]));
        return {
            viewers,
            frames,
            /** Open a stream for `userId` and say what it views, with access checked by `canView`. */
            view: async (
                streamId: string,
                userId: string,
                targets: ViewerTarget[],
                canView = async (_target: ViewerTarget) => true,
            ) => {
                viewers.openStream(streamId, userId);
                return await viewers.view(ctx, streamId, userId, targets, canView);
            },
            /** Erase an agent, its transaction holding the database until `held` settles. */
            erase: async (agentId: string, held?: Promise<void>) =>
                await ctx.inTx(async (txCtx) => {
                    await held;
                    await hooks.agentErasedTransact!(txCtx, {} as never, { id: agentId } as never);
                }),
        };
    };
    /** The erasures kept for requests that may still be checking access. */
    const erasures = async () =>
        (
            await agentDatabaseRows<{ target_id: string }>(
                ctx.db,
                sql`SELECT target_id FROM happy_agent_viewer_erasures`,
            )
        ).map((row) => row.target_id);
    return { start, ctx, erasures };
}

describe("ViewersModule", () => {
    it("stores a staying person's last visit at most once a minute", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const { start } = await world();
        const before = start();
        await before.view("alicestream", "alice", [agent]);
        for (const at of [1_015_000, 1_061_000, 1_076_000]) {
            vi.setSystemTime(at);
            await before.view("alicestream", "alice", [agent]);
        }

        // The process ends without Alice leaving; the next one knows only what was stored.
        vi.setSystemTime(1_090_000);
        const after = start();
        expect(await after.view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [{ userId: "alice", here: false, lastSeenAt: 1_061_000 }] },
        ]);
    });

    it("forgets an erased agent's visitors without announcing anyone leaving", async () => {
        const { start } = await world();
        const daemon = start();
        await daemon.view("alicestream", "alice", [agent]);
        await daemon.view("alicestream", "alice", []);
        await daemon.view("bobstream", "bob", [agent]);
        await daemon.view("carolstream", "carol", [agent]);
        expect(daemon.frames.map(([streamId, frame]) => [streamId, frame.viewer.userId])).toEqual([
            ["bobstream", "carol"],
        ]);

        await daemon.erase(agent.id);
        // A stale window naming it again finds nobody, and nothing of the old visits remains.
        expect(await daemon.view("bobstream", "bob", [])).toEqual([]);
        expect(await daemon.view("davestream", "dave", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
        expect(daemon.frames).toHaveLength(1);
    });

    it("neither stores nor shows a visit whose access was checked before the agent's erase", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const { start } = await world();
        const daemon = start();
        await daemon.view("carolstream", "carol", [agent]);
        // Alice's request finds the agent readable, and the erase commits before it writes.
        expect(
            await daemon.view("alicestream", "alice", [agent], async () => {
                await daemon.erase(agent.id);
                return true;
            }),
        ).toEqual([{ target: agent, viewers: [] }]);
        expect(daemon.frames).toEqual([]);
        // Nobody is here or remembered, in this process or the next.
        vi.setSystemTime(1_000_030);
        expect(await daemon.view("davestream", "dave", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [{ userId: "dave", here: false, lastSeenAt: 1_000_030 }] },
        ]);
    });

    it("ends a stream's view when the agent is erased while its refresh checks access", async () => {
        const { start } = await world();
        const daemon = start();
        await daemon.view("alicestream", "alice", [agent]);
        await daemon.view("carolstream", "carol", [agent]);
        expect(daemon.frames).toHaveLength(1);
        expect(
            await daemon.view("alicestream", "alice", [agent], async () => {
                await daemon.erase(agent.id);
                return true;
            }),
        ).toEqual([{ target: agent, viewers: [] }]);
        expect(await daemon.view("davestream", "dave", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
        expect(daemon.frames).toHaveLength(1);
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            {
                target: agent,
                viewers: [{ userId: "dave", here: false, lastSeenAt: expect.any(Number) }],
            },
        ]);
    });

    it("ends a stream's view when the erase commits after its refresh took the lock", async () => {
        const { start } = await world();
        const daemon = start();
        await daemon.view("alicestream", "alice", [agent]);
        await daemon.view("carolstream", "carol", [agent]);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let erasing!: Promise<void>;
        const refresh = daemon.view("alicestream", "alice", [agent], async () => {
            erasing = daemon.erase(agent.id, held);
            return true;
        });
        // The refresh takes the lock and waits for the database the erase holds.
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await erasing;
        expect(await refresh).toEqual([{ target: agent, viewers: [] }]);
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
    });

    it("stores no departure from an agent erased while the departure waited", async () => {
        const { start } = await world();
        const daemon = start();
        await daemon.view("alicestream", "alice", [agent]);
        await daemon.view("carolstream", "carol", [agent]);
        let release!: () => void;
        const erasing = daemon.erase(agent.id, new Promise<void>((resolve) => (release = resolve)));
        // Alice's departure is recorded while the erase holds the database.
        daemon.viewers.closeStream("alicestream");
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await erasing;
        await daemon.view("davestream", "dave", []);
        expect(daemon.frames).toHaveLength(1);
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
    });

    it("keeps nothing of a request racing the agent's erase, whichever lands first", async () => {
        const { start } = await world();
        const daemon = start();
        await daemon.view("carolstream", "carol", [agent]);
        const [answer] = await Promise.all([
            daemon.view("alicestream", "alice", [agent]),
            daemon.erase(agent.id),
        ]);
        expect(answer).toHaveLength(1);
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
    });

    it("keeps an erasure while a request that started before it is checking access", async () => {
        const { start, erasures } = await world();
        const daemon = start();
        let checked!: () => void;
        const checking = new Promise<void>((resolve) => (checked = resolve));
        let started!: () => void;
        const starting = new Promise<void>((resolve) => (started = resolve));
        const slow = daemon.view("alicestream", "alice", [agent], async () => {
            started();
            await checking;
            return true;
        });
        await starting;
        await daemon.erase(agent.id);
        // Other requests finishing meanwhile leave the erasure Alice's request still needs.
        await daemon.view("bobstream", "bob", [agent]);
        await daemon.view("bobstream", "bob", []);
        expect(await erasures()).toEqual([agent.id]);
        checked();
        expect(await slow).toEqual([{ target: agent, viewers: [] }]);
        await daemon.view("bobstream", "bob", []);
        expect(await erasures()).toEqual([]);
        // Bob's visit came after the erase and stays; Alice's never happened.
        expect(await daemon.view("carolstream", "carol", [agent])).toEqual([
            {
                target: agent,
                viewers: [{ userId: "bob", here: false, lastSeenAt: expect.any(Number) }],
            },
        ]);
    });

    it("keeps only the latest erasure while no request is checking access", async () => {
        const { start, erasures } = await world();
        const daemon = start();
        for (const agentId of ["agentone", "agenttwo", "agentthree"]) await daemon.erase(agentId);
        expect(await erasures()).toEqual(["agentthree"]);
    });

    it("counts visits to a re-created agent with the same ID once checked after its erase", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const { start, erasures } = await world();
        const daemon = start();
        await daemon.view("alicestream", "alice", [agent]);
        vi.setSystemTime(1_000_010);
        await daemon.erase(agent.id);
        vi.setSystemTime(1_000_020);
        await daemon.view("alicestream", "alice", [agent]);
        expect(await daemon.view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [{ userId: "alice", here: true, lastSeenAt: 1_000_020 }] },
        ]);
        // Alice hears Bob arrive; nothing announced the erase.
        expect(daemon.frames).toEqual([
            [
                "alicestream",
                { target: agent, viewer: { userId: "bob", here: true, lastSeenAt: 1_000_020 } },
            ],
        ]);
        expect(await erasures()).toEqual([]);
        await daemon.view("alicestream", "alice", []);
        expect(await start().view("carolstream", "carol", [agent])).toEqual([
            {
                target: agent,
                viewers: [
                    { userId: "alice", here: false, lastSeenAt: 1_000_020 },
                    { userId: "bob", here: false, lastSeenAt: 1_000_020 },
                ],
            },
        ]);
    });

    it("refuses a stream that closed while its request was checking targets", async () => {
        const { start, ctx } = await world();
        const daemon = start();
        await daemon.view("carolstream", "carol", [agent]);
        daemon.viewers.openStream("alicestream", "alice");
        daemon.viewers.closeStream("alicestream");
        const canView = async () => true;
        expect(
            await daemon.viewers.view(ctx, "alicestream", "alice", [agent], canView),
        ).toBeUndefined();
        // Another person's open stream is refused the same way.
        expect(
            await daemon.viewers.view(ctx, "carolstream", "alice", [agent], canView),
        ).toBeUndefined();
        expect(daemon.frames).toEqual([]);
    });

    it("stamps a person's departure with their latest moment on any device", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(0);
        const { start } = await world();
        const daemon = start();
        await daemon.view("carolstream", "carol", [agent]);
        await daemon.view("bobphone", "bob", [agent]);
        await vi.advanceTimersByTimeAsync(15_000);
        await daemon.view("boblaptop", "bob", [agent]);
        await vi.advanceTimersByTimeAsync(5_000);
        await daemon.view("boblaptop", "bob", []);
        await daemon.view("carolstream", "carol", [agent]);
        // The phone went quiet at 0 and expires at 30 s; Bob was last seen on his laptop at 20 s.
        await vi.advanceTimersByTimeAsync(11_000);
        await vi.waitFor(() => expect(daemon.frames).toHaveLength(2));
        expect(daemon.frames[1]).toEqual([
            "carolstream",
            { target: agent, viewer: { userId: "bob", here: false, lastSeenAt: 20_000 } },
        ]);
    });

    it("records everyone here as leaving when it closes, and nothing after", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000_000);
        const { start } = await world();
        const daemon = start();
        await daemon.view("alicestream", "alice", [agent]);
        vi.setSystemTime(1_040_000);
        await daemon.viewers.close();
        daemon.viewers.closeStream("alicestream");
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [{ userId: "alice", here: false, lastSeenAt: 1_040_000 }] },
        ]);
    });

    it("lists at most 50 people, here first, then the most recent", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { start } = await world();
        const daemon = start();
        for (let index = 0; index < 45; index += 1) {
            vi.setSystemTime(1_000_000 + index * 1000);
            await daemon.view(`gone${String(index)}`, `gone${String(index)}`, [agent]);
            await daemon.view(`gone${String(index)}`, `gone${String(index)}`, []);
        }
        vi.setSystemTime(2_000_000);
        for (let index = 0; index < 10; index += 1)
            await daemon.view(`here${String(index)}`, `here${String(index)}`, [agent]);
        const viewers = (await daemon.view("me", "me", [agent]))![0]!.viewers;
        expect(viewers).toHaveLength(50);
        expect(viewers.slice(0, 10).every((viewer) => viewer.here)).toBe(true);
        expect(viewers.slice(10).map((viewer) => viewer.userId)).toEqual(
            Array.from({ length: 40 }, (_, index) => `gone${String(44 - index)}`),
        );
    });
});
