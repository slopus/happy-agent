import type { ViewerTarget, ViewersUpdatedFrame } from "@slopus/happy-agent-client";
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
            /** Open a stream for `userId` and say what it views. */
            view: async (streamId: string, userId: string, targets: ViewerTarget[]) => {
                viewers.openStream(streamId, userId);
                return await viewers.view(ctx, streamId, userId, targets);
            },
            erase: async (agentId: string) =>
                await ctx.inTx((txCtx) =>
                    hooks.agentErasedTransact!(txCtx, {} as never, { id: agentId } as never),
                ),
        };
    };
    return { start, ctx };
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

    it("never stores a visit to an agent erased after its request was checked", async () => {
        const { start } = await world();
        const daemon = start();
        await daemon.view("carolstream", "carol", [agent]);
        await daemon.erase(agent.id);
        // Alice's request passed its read check before the erase and arrives after it.
        expect(await daemon.view("alicestream", "alice", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
        expect(daemon.frames).toEqual([]);
        expect(await start().view("bobstream", "bob", [agent])).toEqual([
            { target: agent, viewers: [] },
        ]);
    });

    it("refuses a stream that closed while its request was checking targets", async () => {
        const { start, ctx } = await world();
        const daemon = start();
        await daemon.view("carolstream", "carol", [agent]);
        daemon.viewers.openStream("alicestream", "alice");
        daemon.viewers.closeStream("alicestream");
        expect(await daemon.viewers.view(ctx, "alicestream", "alice", [agent])).toBeUndefined();
        // Another person's open stream is refused the same way.
        expect(await daemon.viewers.view(ctx, "carolstream", "alice", [agent])).toBeUndefined();
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
