import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { AcpToolBridgeServer } from "@/protocol/acp/impl/AcpToolBridgeServer.js";

describe("AcpToolBridgeServer tool discovery", () => {
    it("pins only explicit discovery opt-outs and leaves other tools to native policy", async () => {
        const parameters = Type.Object({ query: Type.String() });
        const bridge = await AcpToolBridgeServer.start(
            [
                { name: "search", namespace: "catalog", parameters, defer: true },
                { name: "read", parameters },
                { name: "write", parameters, defer: false },
            ],
            () => {
                throw new Error("Listing tools must not invoke one.");
            },
        );
        const client = new Client({ name: "tool-discovery-test", version: "1" });
        try {
            await client.connect(
                new StreamableHTTPClientTransport(new URL(bridge.url), {
                    requestInit: { headers: bridge.headers },
                }) as unknown as Transport,
            );
            const { tools } = await client.listTools();
            expect(tools.map((tool) => tool.name)).toEqual(["catalog__search", "read", "write"]);
            expect(tools[0]?._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
            expect(tools[1]?._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
            expect(tools[2]?._meta?.["anthropic/alwaysLoad"]).toBe(true);
            expect(tools.every((tool) => tool.inputSchema.properties?.query !== undefined)).toBe(
                true,
            );
        } finally {
            await client.close();
            bridge.close();
        }
    });
});
