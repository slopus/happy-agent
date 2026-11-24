import { describe, expect, it } from "vitest";

import { bridgeListing } from "@/protocol/acp/impl/AcpToolBridgeServer.js";

const tool = (name: string, bytes: number) => ({
    name,
    description: "x".repeat(bytes),
    inputSchema: { type: "object" as const },
});

describe("bridgeListing", () => {
    const tools = [tool("large", 3_000), tool("small", 100), tool("medium", 600)];

    it("declares every tool when the agent has no budget or the tools fit it", () => {
        expect(bridgeListing(tools, undefined).declared).toBe(tools);
        expect(bridgeListing(tools, 10_000)).toMatchObject({ declared: tools, behindCallTool: [] });
    });

    it("declares the smallest tools that fit and names the rest in call_tool", () => {
        const listing = bridgeListing(tools, 1_500);
        expect(listing.declared.map((declaration) => declaration.name)).toEqual([
            "small",
            "medium",
            "call_tool",
        ]);
        expect(listing.behindCallTool).toEqual(["large"]);
        expect(listing.declared.at(-1)?.description).toContain(": large.");
        expect(JSON.stringify(listing.declared).length).toBeLessThanOrEqual(1_500);
        expect([...listing.all.keys()]).toEqual(["large", "small", "medium"]);
    });
});
