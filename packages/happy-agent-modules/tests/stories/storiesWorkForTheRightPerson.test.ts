import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    GUEST_MESSAGE_ORIGIN_METADATA,
    USER_MESSAGE_ORIGIN_METADATA,
} from "../../sources/impl/messageOrigin.js";
import { StoriesModule } from "../../sources/stories/index.js";

const ctx = createRootContext().named("stories-test");

/**
 * The stories module over stand-in tasks, bots, team, and settings: agent `task` is a task owned
 * by `alice`, agent `bot` is a bot, and `on` lists who has stories on (`standalone` for the one
 * person of a standalone installation).
 */
function harness(teamEnabled: boolean, on: readonly string[]) {
    const reader = new WeakMap<object, string>();
    const stories = new StoriesModule(
        {} as never,
        {} as never,
        {} as never,
        {
            forAgent: async (_ctx: Context, agentId: string) =>
                agentId === "task" ? { id: "taskid", ownerUserId: "alice" } : undefined,
        } as never,
        {
            forAgent: async (_ctx: Context, agentId: string) =>
                agentId === "bot" ? { id: "botid" } : undefined,
        } as never,
        {
            enabled: teamEnabled,
            getUser: async (_ctx: Context, id: string) => ({ id, authentication: "jwt" }),
            connectionContext: (_ctx: Context, user: { id: string }) => {
                const userCtx = createRootContext().named(user.id);
                reader.set(userCtx, user.id);
                return userCtx;
            },
        } as never,
        {
            get: async (settingsCtx: Context) => ({
                value: on.includes(reader.get(settingsCtx) ?? "standalone"),
            }),
        } as never,
    );
    const hooks = stories.beforeStart();
    function agent(agentId: string) {
        const kv = new Map<string, unknown>();
        const scope = {
            agent: { id: agentId },
            kv: {
                read: async (_ctx: Context, key: string) => kv.get(key),
                write: async (_ctx: Context, key: string, value: unknown) => kv.set(key, value),
            },
        } as unknown as AgentModuleScope;
        return {
            canPost: async () => await stories.canPost(ctx, scope),
            hears: async (metadata: Record<string, unknown>) =>
                await hooks.messageAcceptedTransact!(ctx, scope, {
                    message: { role: "user" },
                    metadata,
                } as never),
        };
    }
    return { agent };
}

describe("who a story-posting agent works for", () => {
    it("is the task's owner while only agents have written to the task", async () => {
        const task = harness(true, ["alice"]).agent("task");
        expect(await task.canPost()).toBe(true);
        await task.hears({ messageOrigin: "agent" });
        expect(await task.canPost()).toBe(true);
        expect(await harness(true, []).agent("task").canPost()).toBe(false);
    });

    it("is the person the agent last heard from once one has written", async () => {
        const task = harness(true, ["alice"]).agent("task");
        await task.hears({ ...USER_MESSAGE_ORIGIN_METADATA, userId: "bob" });
        expect(await task.canPost()).toBe(false);
        await task.hears({ ...USER_MESSAGE_ORIGIN_METADATA, userId: "alice" });
        expect(await task.canPost()).toBe(true);
        // A bot has no owner to fall back to.
        expect(await harness(true, ["alice"]).agent("bot").canPost()).toBe(false);
    });

    it("is never an exported bot's guest, standalone or in a team", async () => {
        for (const [team, person] of [
            [false, "standalone"],
            [true, "alice"],
        ] as const) {
            const bot = harness(team, [person]).agent("bot");
            await bot.hears({ ...USER_MESSAGE_ORIGIN_METADATA, userId: "alice" });
            expect(await bot.canPost()).toBe(true);
            await bot.hears({ ...GUEST_MESSAGE_ORIGIN_METADATA, userId: "guestuser" });
            expect(await bot.canPost()).toBe(false);
            await bot.hears({ ...USER_MESSAGE_ORIGIN_METADATA, userId: "alice" });
            expect(await bot.canPost()).toBe(true);
        }
    });
});
