import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { StoriesModule } from "../../sources/stories/index.js";
import { TeamAuthenticationError, withTeamUser } from "../../sources/team/index.js";

const ctx = createRootContext().named("stories-test");

/**
 * The stories module over stand-in tasks, team, and settings: agent `task` is a task owned
 * by `alice`, agent `bot` is a bot, and `on` lists who has stories on (`standalone` for the one
 * person of a standalone installation).
 */
function harness(teamEnabled: boolean, on: readonly string[], botStories = false) {
    const reader = new WeakMap<object, string>();
    const stories = new StoriesModule(
        {} as never,
        {} as never,
        { resolve: async () => undefined } as never,
        {
            forAgent: async (_ctx: Context, agentId: string) =>
                agentId === "task" ? { id: "taskid", ownerUserId: "alice" } : undefined,
        } as never,
        {
            forAgent: async (_ctx: Context, agentId: string) =>
                agentId === "bot" ? { id: "botid" } : undefined,
            settings: async () => ({ stories: botStories }),
        } as never,
        {
            enabled: teamEnabled,
            getUser: async (_ctx: Context, id: string) => ({ id, authentication: "jwt" }),
            connectionContext: (_ctx: Context, user: { id: string }) => {
                const userCtx = withTeamUser(createRootContext().named(user.id), {
                    ...user,
                    authentication: "jwt",
                } as never);
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
    const hooks = stories.beforeStart(ctx, {} as never);
    function agent(agentId: string) {
        const scope = {
            agent: { id: agentId },
        } as unknown as AgentModuleScope;
        return {
            canPost: async () => await stories.canPost(ctx, scope),
            tools: async () => await hooks.tools!(ctx, scope),
        };
    }
    return { agent, stories };
}

describe("story tools follow the task owner", () => {
    it("requires an onboarded team reader before checking their setting", async () => {
        await expect(harness(true, ["standalone"]).stories.enabled(ctx)).rejects.toBeInstanceOf(
            TeamAuthenticationError,
        );
    });
    it("offers tools according to the owner's setting when they are assembled", async () => {
        const on = ["alice"];
        const { agent, stories } = harness(true, on);
        const task = agent("task");
        const offered = await task.tools();
        expect(offered.map((tool) => tool.name)).toEqual(["delete_story", "list_stories"]);
        on.length = 0;
        vi.spyOn(stories, "deleteOwn").mockResolvedValue(true);
        vi.spyOn(stories, "ofAgent").mockResolvedValue([]);
        expect(await offered[0]!.execute(ctx, { id: "story" } as never, {} as never)).toEqual({
            deleted: true,
        });
        expect(await offered[1]!.execute(ctx, {} as never, {} as never)).toEqual([]);
        expect(await task.tools()).toEqual([]);
    });

    it("depends on the task owner, not another member", async () => {
        const task = harness(true, ["alice"]).agent("task");
        expect(await task.canPost()).toBe(true);
        expect(await harness(true, ["bob"]).agent("task").canPost()).toBe(false);
        expect(await harness(false, ["standalone"]).agent("task").canPost()).toBe(true);
        expect(await harness(false, []).agent("task").canPost()).toBe(false);
    });

    it("offers bot tools only when the bot's own Stories switch is on", async () => {
        for (const [team, person] of [
            [false, "standalone"],
            [true, "alice"],
        ] as const) {
            const bot = harness(team, [person]).agent("bot");
            expect(await bot.canPost()).toBe(false);
            expect(await bot.tools()).toEqual([]);
            expect(await harness(team, [], true).agent("bot").canPost()).toBe(true);
        }
    });
});
