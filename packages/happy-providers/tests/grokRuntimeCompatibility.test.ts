import { expect, it } from "vitest";

import { createGrokOpenAIClient } from "@/vendors/grok/impl/createGrokOpenAIClient.js";

it("closes the Grok client through Node's Undici dispatcher", async () => {
    const client = createGrokOpenAIClient({
        baseUrl: "https://grok.example.test/v1",
        token: "test-token",
    });

    expect(typeof client.responses.create).toBe("function");
    await client.close();
});
