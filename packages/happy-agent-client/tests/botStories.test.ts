import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { renameBotRequestSchema } from "../sources/protocol/bots.js";

it("updates a bot's Stories switch without supplying a name", async () => {
    const client = new HappyAgentClient({
        endpoint: "https://agent.test",
        token: "test-token",
        fetch: async (input, init) => {
            const request = new Request(input, init);
            expect(request.method).toBe("PATCH");
            expect(new URL(request.url).pathname).toBe("/v0/bots/bot");
            expect(request.headers.get("if-match")).toBe("version");
            expect(await request.json()).toEqual({ stories: true });
            return Response.json({ bot: { stories: true } });
        },
    });
    expect(await client.renameBot("bot", { stories: true }, { ifMatch: "version" })).toEqual({
        bot: { stories: true },
    });
    for (const body of [{ name: "Scout" }, { stories: false }, { name: "Scout", stories: true }])
        expect(Value.Check(renameBotRequestSchema, body)).toBe(true);
    for (const body of [
        {},
        { mutationId: "empty" },
        { stories: "yes" },
        { stories: true, username: "new" },
    ])
        expect(Value.Check(renameBotRequestSchema, body)).toBe(false);
});
