import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { renameBotRequestSchema } from "../sources/protocol/bots.js";

it("renames a bot with a required display name", async () => {
    const client = new HappyAgentClient({
        endpoint: "https://agent.test",
        token: "test-token",
        fetch: async (input, init) => {
            const request = new Request(input, init);
            expect(request.method).toBe("PATCH");
            expect(new URL(request.url).pathname).toBe("/v0/bots/bot");
            expect(request.headers.get("if-match")).toBe("version");
            expect(await request.json()).toEqual({ name: "Scout" });
            return Response.json({ bot: { name: "Scout" } });
        },
    });
    expect(await client.renameBot("bot", { name: "Scout" }, { ifMatch: "version" })).toEqual({
        bot: { name: "Scout" },
    });
    expect(Value.Check(renameBotRequestSchema, { name: "Scout" })).toBe(true);
    for (const body of [
        {},
        { mutationId: "empty" },
        { stories: true },
        { name: "Scout", username: "new" },
    ])
        expect(Value.Check(renameBotRequestSchema, body)).toBe(false);
});
