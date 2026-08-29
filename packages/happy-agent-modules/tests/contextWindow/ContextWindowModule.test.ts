import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { ContextWindowModule } from "../../sources/contextWindow/index.js";

const ctx = createRootContext().named("context-window-module-test");
const scope = {
    agent: {
        id: "agent-1",
        model: "model-1",
        provider: "provider-1",
    },
} as AgentModuleScope;

describe("ContextWindowModule", () => {
    it("checks the persisted context only while preparing inference", async () => {
        const config = {
            modelContext: () => ({ autoCompactWindow: 750, contextWindow: 1_000 }),
        } as unknown as ConfigModule;
        const hooks = await new ContextWindowModule(config).beforeStart?.();
        if (hooks === undefined) throw new Error("The context-window hooks did not start.");

        expect(hooks.beforeTurn).toBeUndefined();
        expect(hooks.afterInference).toBeUndefined();
        expect(
            await hooks.prepareInference?.(ctx, scope, {
                contextTokens: 800,
                loopId: "loop-1",
                turnId: "turn-1",
            }),
        ).toEqual([{ type: "compact" }]);
        expect(
            await hooks.prepareInference?.(ctx, scope, {
                contextTokens: 749,
                loopId: "loop-1",
                turnId: "turn-2",
            }),
        ).toBeUndefined();
    });
});
