import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AutoReviewAskParentModule } from "../../sources/auto/impl/AutoReviewAskParentModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const context: Context = createRootContext().named("auto-review-ask-parent-test");

function scope(id: string): AgentModuleScope {
    return { agent: { id }, kv: undefined } as unknown as AgentModuleScope;
}

describe("AutoReviewAskParentModule", () => {
    it("offers ask_parent only to a private agent that may ask, while it may", async () => {
        const module = new AutoReviewAskParentModule();
        const hooks = await resolveModuleHooks(context, module);
        const questions: string[] = [];

        expect(await hooks.tools?.(context, scope("reviewer"))).toEqual([]);

        module.beginReview("reviewer", {
            ask: async (_ctx, question) => {
                questions.push(question);
                return "unknown: Nobody knows.";
            },
        });
        const tools = (await hooks.tools?.(context, scope("reviewer"))) ?? [];
        expect(tools.map((tool) => tool.name)).toEqual(["ask_parent"]);
        const tool = tools[0]!;
        expect(tool).toMatchObject({ defer: false, transactional: false, autoReview: "never" });
        expect(tool.shouldReviewInAutoMode({ question: "?" }, context)).toBe(false);
        expect(Value.Check(tool.parameters!, { question: "Was this asked for?" })).toBe(true);
        expect(Value.Check(tool.parameters!, { question: "" })).toBe(false);
        expect(Value.Check(tool.parameters!, { question: "?", extra: true })).toBe(false);
        const result = await tool.execute(
            context,
            { question: "Was this asked for?" },
            {} as never,
        );
        expect(tool.toLLM(result)).toEqual([{ type: "text", text: "unknown: Nobody knows." }]);
        expect(questions).toEqual(["Was this asked for?"]);
        expect(await hooks.tools?.(context, scope("otherreviewer"))).toEqual([]);

        module.endReview("reviewer");
        expect(await hooks.tools?.(context, scope("reviewer"))).toEqual([]);
    });
});
