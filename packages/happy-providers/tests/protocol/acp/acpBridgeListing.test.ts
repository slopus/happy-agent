import { describe, expect, it } from "vitest";

import { bridgeListing } from "@/protocol/acp/impl/AcpToolBridgeServer.js";

const tool = (name: string, bytes: number) => ({
    name,
    description: "x".repeat(bytes),
    inputSchema: { type: "object" as const },
});

describe("bridgeListing", () => {
    const tools = [tool("large", 3_000), tool("small", 100), tool("medium", 600)];

    it("declares every tool when the agent has no budget", () => {
        expect(bridgeListing(tools, undefined)).toMatchObject({ declared: tools, callTool: false });
    });

    it("declares every tool that fits the budget, and call_tool to describe any of them", () => {
        const listing = bridgeListing(tools, 10_000);
        expect(listing.declared.map((declaration) => declaration.name)).toEqual([
            "large",
            "small",
            "medium",
            "call_tool",
        ]);
        expect(listing).toMatchObject({ behindCallTool: [], callTool: true });
        expect(listing.declared.at(-1)?.description).toContain(
            "Describe or run any of Happy's tools.",
        );
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

    it("declares the tools every model gets up front before deferred ones", () => {
        const listing = bridgeListing(tools, 3_900, new Set(["large"]));
        expect(listing.declared.map((declaration) => declaration.name)).toEqual([
            "large",
            "small",
            "call_tool",
        ]);
        expect(listing.behindCallTool).toEqual(["medium"]);
    });
});
