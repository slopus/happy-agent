import { withAgentPermissionMode, type AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import type { StoriesModule } from "../../sources/stories/StoriesModule.js";
import { setStoryTool } from "../../sources/stories/tools/set_story.js";

describe("set_story", () => {
    it("takes down the story its first run found, even when replayed after a newer post", async () => {
        const live = ["first", "newer"];
        const targets: string[] = [];
        const stories = {
            liveOf: async () => live.shift(),
            post: async (_ctx: unknown, _scope: unknown, id: string) => {
                targets.push(id);
                return { story: null, replaced: id };
            },
        } as unknown as StoriesModule;
        const tool = setStoryTool(stories, { agent: { id: "poster" } } as AgentModuleScope);
        const kept = new Map<string, unknown>();
        const kv = {
            getOrCreate: async (_ctx: unknown, key: string, create: () => Promise<unknown>) => {
                if (!kept.has(key)) kept.set(key, await create());
                return kept.get(key);
            },
        };
        const ctx = withAgentPermissionMode(createRootContext().named("set-story-test"), "auto");
        for (let run = 0; run < 2; run += 1)
            await tool.execute(ctx, { story: null }, { id: "call", kv } as never);
        expect(targets).toEqual(["first", "first"]);
    });
});
