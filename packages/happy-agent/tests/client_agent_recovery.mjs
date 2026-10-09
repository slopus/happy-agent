import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
const require = createRequire(new URL("../../happy-terminal/package.json", import.meta.url));
const { HappyAgentClient, agentSchema, messageHistoryResponseSchema } = await import(
    require.resolve("@slopus/happy-agent-client")
);
const { Value } = require("@sinclair/typebox/value");
const { Type, TypeRegistry } = require("@sinclair/typebox");
// The published history schema intentionally carries opaque object run items.
// Its Unsafe kind needs the registry entry before TypeBox can check the wrapper.
TypeRegistry.Set("Unsafe", (_schema, value) => Value.Check(Type.Object({}), value));
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
const id = "agenttoolrecovery";
const { agent, profiles, slashCommands } = await client.getAgent(id);
assert(Value.Check(agentSchema, agent), JSON.stringify([...Value.Errors(agentSchema, agent)]));
assert.equal(agent.workspaceId, "workspacerecovered");
assert.equal(agent.status, "idle");
assert.deepEqual(profiles, []);
assert(slashCommands.some((command) => command.name === "compact"));
assert.deepEqual((await client.getAgentMode(id)).mode, {
    providerId: "fixture",
    modelId: "openai/gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    permissionMode: "full_access",
});
const page = await client.getMessages(id);
assert(Value.Check(messageHistoryResponseSchema, page));
assert.equal(page.runs.length, 1);
assert.equal(page.runs[0].id, "messagerecoveredrun");
assert.equal(page.runs[0].status, "completed");
assert.equal(page.runs[0].reason, "completed");
assert.deepEqual(page.runs[0].usage, {
    fixture: { "openai/gpt-5.6-sol": { input: 17, output: 3, cacheRead: 0, cacheWrite: 0 } },
});
const messages = page.runs[0].messages;
assert.equal(messages[1].content[0].id, "callrecoveredtool");
assert.equal(messages[1].content[0].presentation.type, "exec_command");
const compact = await client.getMessages(id, { limit: 1, omitToolData: true });
assert.equal(compact.runs[0].messages.length, 3);
const tool = compact.runs[0].messages[1].content[0];
assert(!("arguments" in tool));
assert(!("result" in tool));
assert(tool.presentation.output.includes("one recovered execution"));
const usage = await client.getAgentUsage(id);
assert.deepEqual(usage.usage, page.runs[0].usage);
assert.deepEqual(usage.context, {
    approximate: false,
    contextTokens: 20,
    contextWindow: 272000,
    modelId: "openai/gpt-5.6-sol",
    providerId: "fixture",
});
const events = await client.getEvents();
assert(
    events.events.some(
        (event) => event.type === "run.finished" && event.payload.run.id === "messagerecoveredrun",
    ),
);
console.log("Published client recovered agent, run, tool presentation, mode, and usage verified.");
