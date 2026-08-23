import assert from "node:assert/strict";

import { createGrokOpenAIClient } from "../../sources/vendors/grok/impl/createGrokOpenAIClient.ts";

const client = createGrokOpenAIClient({
    baseUrl: "https://grok.example.test/v1",
    token: "test-token",
});

assert.equal(typeof client.responses.create, "function");
await client.close();
