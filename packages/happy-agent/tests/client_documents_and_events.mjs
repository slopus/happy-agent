import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";

const require = createRequire(new URL("../../happy-terminal/package.json", import.meta.url));
const {
    HappyAgentClient,
    healthResponseSchema,
    instructionsResponseSchema,
    securityPolicyResponseSchema,
} = await import(require.resolve("@slopus/happy-agent-client"));
const { Value } = require("@sinclair/typebox/value");
const directory = join(process.argv[2], "agent");
const socketFetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
        const url = new URL(input);
        const req = request(
            {
                socketPath: join(directory, "server.sock"),
                path: url.pathname + url.search,
                method: init.method ?? "GET",
                headers: Object.fromEntries(new Headers(init.headers)),
                signal: init.signal,
            },
            (res) =>
                resolve(
                    new Response(Readable.toWeb(res), {
                        status: res.statusCode,
                        headers: res.headers,
                    }),
                ),
        );
        req.on("error", reject);
        req.end(init.body);
    });
const client = new HappyAgentClient({
    endpoint: "http://happy",
    token: readFileSync(join(directory, "token"), "utf8").trim(),
    fetch: socketFetch,
});
assert(Value.Check(healthResponseSchema, await client.getHealth()));
const instructions = await client.putInstructions("Client round trip. 中文 😀");
assert(Value.Check(instructionsResponseSchema, instructions));
assert.deepEqual(await client.getInstructions(), instructions);
const security = await client.putSecurityPolicy("Review each current action.");
assert(Value.Check(securityPolicyResponseSchema, security));
assert.deepEqual(await client.getSecurityPolicy(), security);
const page = await client.getEvents();
assert.equal(page.events.length, 2);
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 5_000);
try {
    const stream = client.streamEvents({ after: page.cursor, signal: controller.signal });
    const hello = (await stream.next()).value;
    assert.equal(hello.kind, "hello");
    assert.equal(hello.hello.resumed, true);
    assert.equal(hello.hello.gap, false);
    await client.putSecurityPolicy("Live client mutation.");
    const live = (await stream.next()).value;
    assert.equal(live.kind, "event");
    assert.equal(live.event.type, "config.updated");
    assert(live.cursor > page.cursor);
    await stream.return();
} finally {
    clearTimeout(deadline);
    controller.abort();
}
console.log("Published client document and event contracts verified.");
