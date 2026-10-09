import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const binary = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Select the native executable to smoke test.");
const root = await mkdtemp(join(tmpdir(), "happy-rust-smoke-"));
const requests = [];
const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
        { type: "response.output_text.delta", delta: "Native runtime works." },
        { type: "response.output_text.done" },
        {
            type: "response.completed",
            response: {
                id: `response-${requests.length}`,
                output: [],
                usage: { input_tokens: 15, output_tokens: 4 },
            },
        },
    ];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
});
await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
});
const provider = {
    kind: "responses",
    credential: { type: "bearer", token: "test-only-placeholder" },
    model: "test-model",
    endpoint: `http://127.0.0.1:${server.address().port}`,
    inferenceMaxRetries: 0,
};
const providerFile = join(root, "provider.json");
const agentFile = join(root, "agent.json");
await writeFile(providerFile, JSON.stringify(provider));
await writeFile(
    agentFile,
    JSON.stringify({ id: "smoke-agent", instructions: "Root instructions.", provider }),
);

async function run(args, input) {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "",
        error = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.stdin.on("error", (failure) => {
        if (failure.code !== "EPIPE") error += failure.message;
    });
    const completion = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0
                ? resolve(output)
                : reject(new Error(`Native command failed (${code}): ${error}`)),
        );
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    if (input) child.stdin.end(input);
    else child.stdin.end();
    try {
        return await completion;
    } finally {
        clearTimeout(timer);
    }
}
try {
    const version = await run(["--version"], "");
    assert.match(version, /^Happy Agent /);
    const input = {
        request: {
            context: {
                instructions: "Exact root.",
                messages: [{ role: "user", content: [{ type: "text", text: "First" }] }],
            },
        },
    };
    const events = (await run(["infer", "--config", providerFile], JSON.stringify(input)))
        .trim()
        .split("\n")
        .map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    assert.equal(events.at(-1).state, "normal");
    assert.equal(requests[0].instructions, "Exact root.");
    const commands =
        ["First turn", "Second turn"]
            .map((text) =>
                JSON.stringify({
                    type: "send",
                    message: { role: "user", content: [{ type: "text", text }] },
                }),
            )
            .join("\n") + "\n";
    const agentEvents = (
        await run(["agent", "--config", agentFile, "--store", join(root, "agent.sqlite")], commands)
    )
        .trim()
        .split("\n")
        .map(JSON.parse);
    assert.equal(agentEvents.filter((event) => event.type === "settled").length, 2);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].input.at(-1).content, "Second turn");
    assert.equal(requests[2].input[1].role, "assistant");
    console.log(
        "Verified native inference, durable queued follow-ups, history continuation, and terminal events.",
    );
} finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
}
