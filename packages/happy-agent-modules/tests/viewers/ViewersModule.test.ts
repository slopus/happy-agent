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
            frames,
            view: async (streamId: string, userId: string, targets: ViewerTarget[]) =>
                await viewers.view(ctx, streamId, userId, targets),
            erase: async (agentId: string) =>
                await ctx.inTx((txCtx) =>
                    hooks.agentErasedTransact!(txCtx, {} as never, { id: agentId } as never),
                ),
        };
    };
    return { start };
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
});
