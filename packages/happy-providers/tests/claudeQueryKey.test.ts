import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import type { SessionTool } from "@/core/SessionTool.js";
import { claudeQueryKey } from "@/vendors/claude/impl/claudeQueryKey.js";

function keyFor(tools: readonly SessionTool[]): string {
    return claudeQueryKey({
        compaction: false,
        effort: undefined,
        model: "claude-sonnet-5-5",
        structuredOutput: undefined,
        systemPrompt: "",
        tools,
    });
}

/** A schema whose levels each reference the next one twice, like MCP's bounded JSON value. */
function sharedSubschemaChain(depth: number): unknown {
    let node: unknown = { type: "string" };
    for (let level = 0; level < depth; level += 1) node = { anyOf: [node, node] };
    return node;
}

describe("claudeQueryKey", () => {
    it("leaves out tool fields Claude is never sent", () => {
        const parameters = Type.Object({ query: Type.String() });
        const agentTool = {
            name: "mcp__notion__search",
            description: "Search Notion.",
            parameters,
            // 21 objects in memory, about 20 MB once written out.
            returnType: sharedSubschemaChain(20),
            execute: async () => undefined,
        } as SessionTool;

        expect(keyFor([agentTool])).toBe(
            keyFor([{ name: "mcp__notion__search", description: "Search Notion.", parameters }]),
        );
        expect(keyFor([agentTool]).length).toBeLessThan(1_000);
    });

    it("changes when a description Claude is sent changes", () => {
        expect(keyFor([{ name: "search", description: "Search Notion." }])).not.toBe(
            keyFor([{ name: "search", description: "Search the workspace." }]),
        );
    });

    it("changes when a parameter schema Claude is sent changes", () => {
        expect(
            keyFor([{ name: "search", parameters: Type.Object({ q: Type.String() }) }]),
        ).not.toBe(keyFor([{ name: "search", parameters: Type.Object({ q: Type.Number() }) }]));
    });
});
