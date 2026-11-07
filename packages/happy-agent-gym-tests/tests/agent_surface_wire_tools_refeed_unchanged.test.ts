import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
    AnthropicProvider,
    BedrockBearerTokenCredential,
    ClaudeApiKeyCredential,
    CodexApiKeyCredential,
    CodexProvider,
    GlmProvider,
    GrokApiKeyCredential,
    GrokProvider,
    KimiProvider,
    OpenAICompatibleProvider,
    resolveClaudeCodeExecutablePath,
    type BaseProvider,
    type SessionTool,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { expect, it } from "vitest";

/**
 * Feeds every tool captured in `fixtures/agent-surface/wire/` back through the same published
 * provider class that produced it, against a local vendor, and requires the tool to come out
 * byte for byte as it went in: serialization of an already-serialized schema changes nothing.
 * Only the name, description, schema, and deferral are fed back, which is all the wire carries.
 */
const WIRE = resolve(import.meta.dirname, "../fixtures/agent-surface/wire");

type Family =
    | "claude"
    | "codex"
    | "grok"
    | "openai_compatible"
    | "bedrock"
    | "bedrock_anthropic_mantle"
    | "bedrock_responses_mantle"
    | "bedrock_responses_runtime"
    | "bedrock_kimi_runtime"
    | "bedrock_glm_runtime";

/**
 * Claude Code adds this tool itself whenever tool search is on; it is compared on the way out but
 * never fed back, since happy-agent never supplies it.
 */
const CLAUDE_CODE_OWN_TOOLS = new Set(["DeferredToolPlaceholder"]);

/**
 * Claude Code keeps deferred tools off the wire and turns tool search on only when one exists, so
 * the Claude refeed adds one deferred tool of its own. It is never on the wire and never compared.
 */
const CLAUDE_DEFERRED_PROBE: SessionTool = {
    name: "refeed_deferred_probe",
    description: "Keeps Claude Code tool search on during the refeed.",
    parameters: Type.Object({}),
    defer: true,
};

/**
 * Inverts one wire tool into the SessionTool happy-agent supplied for it. Native discovery
 * descriptors go back as the `server` descriptor they came from, and the search keywords the
 * Anthropic protocol folds into a deferred description go back as `searchKeywords`, so the
 * builder's own additions are not counted as part of the input.
 */
function toolOf(family: Family, wire: Record<string, unknown>): SessionTool | undefined {
    if (family === "claude" && wire["name"] === "ToolSearch")
        return { name: "ToolSearch", server: { type: "ToolSearch" } };
    if (typeof wire["type"] === "string" && !["function", "custom"].includes(wire["type"])) {
        const server = wire as { type: string } & Record<string, unknown>;
        return { name: typeof wire["name"] === "string" ? wire["name"] : wire["type"], server };
    }
    const fn = wire["function"] as Record<string, unknown> | undefined;
    const source = fn ?? wire;
    const schema = source["input_schema"] ?? source["parameters"];
    if (typeof source["name"] !== "string" || schema === undefined) return undefined;
    const defer = wire["defer_loading"] === true;
    let description = typeof source["description"] === "string" ? source["description"] : undefined;
    let searchKeywords: string[] | undefined;
    const folded = defer && description?.match(/^([\s\S]*)\n\nSearch keywords: (.*)\.$/);
    if (folded) {
        description = folded[1];
        searchKeywords = folded[2]!.split(", ");
    }
    return {
        name: source["name"],
        ...(description === undefined ? {} : { description }),
        parameters: schema as SessionTool["parameters"] & object,
        ...(searchKeywords === undefined ? {} : { searchKeywords }),
        ...(defer ? { defer: true } : {}),
    };
}

async function providerFor(
    family: Family,
    base: string,
    claudeCwd: string,
): Promise<{ provider: BaseProvider; model: string; effort: "medium" | "high" }> {
    const bedrock = async () =>
        (await BedrockBearerTokenCredential.tryLoad({ bearerToken: "wire-key" }))!;
    const shared = { inferenceMaxRetries: 0 };
    switch (family) {
        case "claude":
            return {
                provider: new AnthropicProvider({
                    ...shared,
                    credential: (await ClaudeApiKeyCredential.tryLoad({ apiKey: "wire-key" }))!,
                    cwd: claudeCwd,
                    env: { ...process.env, ANTHROPIC_BASE_URL: `${base}/claude` },
                    pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
                }),
                model: "anthropic/opus-5-5",
                effort: "medium",
            };
        case "codex":
            return {
                provider: new CodexProvider({
                    ...shared,
                    credential: (await CodexApiKeyCredential.tryLoad({ apiKey: "wire-key" }))!,
                    endpoint: `${base}/codex`,
                    transport: "sse",
                    parallelToolCalls: true,
                }),
                model: "openai/gpt-6.1-sol",
                effort: "medium",
            };
        case "grok":
            return {
                provider: new GrokProvider({
                    ...shared,
                    credential: (await GrokApiKeyCredential.tryLoad({ apiKey: "wire-key" }))!,
                    endpoint: `${base}/grok`,
                }),
                model: "xai/grok-4.5",
                effort: "medium",
            };
        case "openai_compatible":
            return {
                provider: new OpenAICompatibleProvider({
                    ...shared,
                    apiKey: "wire-key",
                    endpoint: `${base}/openai_compatible/v1`,
                    vendor: "Wire",
                    models: [{ id: "zai/glm-5.3", inputTypes: ["text"] }],
                    model: "zai/glm-5.3",
                    reasoningField: null,
                }),
                model: "zai/glm-5.3",
                effort: "medium",
            };
        case "bedrock":
        case "bedrock_anthropic_mantle":
            return {
                provider: new AnthropicProvider({
                    ...shared,
                    credential: await bedrock(),
                    endpoint: `${base}/${family}`,
                    model: "anthropic/opus-5-5",
                    region: "us-east-1",
                    transport: family === "bedrock" ? "runtime" : "mantle",
                }),
                model: "anthropic/opus-5-5",
                effort: "medium",
            };
        case "bedrock_responses_mantle":
        case "bedrock_responses_runtime": {
            const model =
                family === "bedrock_responses_mantle" ? "openai/gpt-5.4" : "openai/gpt-6-astra";
            return {
                provider: new CodexProvider({
                    ...shared,
                    credential: await bedrock(),
                    endpoint: `${base}/${family}`,
                    model,
                    region: "us-east-1",
                    bedrockTransport: family === "bedrock_responses_mantle" ? "mantle" : "runtime",
                }),
                model,
                effort: "medium",
            };
        }
        case "bedrock_kimi_runtime":
        case "bedrock_glm_runtime": {
            const model = family === "bedrock_kimi_runtime" ? "moonshotai/kimi-k3" : "zai/glm-5.3";
            const options = {
                ...shared,
                credential: await bedrock(),
                endpoint: `${base}/${family}`,
                model,
                region: "us-east-1",
            };
            return {
                provider:
                    family === "bedrock_kimi_runtime"
                        ? new KimiProvider(options)
                        : new GlmProvider(options),
                model,
                effort: "high",
            };
        }
    }
}

const FAMILIES: readonly Family[] = [
    "claude",
    "codex",
    "grok",
    "openai_compatible",
    "bedrock",
    "bedrock_anthropic_mantle",
    "bedrock_responses_mantle",
    "bedrock_responses_runtime",
    "bedrock_kimi_runtime",
    "bedrock_glm_runtime",
];

it.runIf(process.platform === "linux")(
    "serializes every captured wire tool unchanged when it is fed back",
    async () => {
        const bodies = new Map<string, string>();
        const http = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                if (request.method !== "POST") {
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end("{}");
                    return;
                }
                const family = new URL(request.url ?? "", "http://wire").pathname.split("/")[1]!;
                if (!bodies.has(family)) bodies.set(family, Buffer.concat(chunks).toString("utf8"));
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        type: "error",
                        error: { type: "invalid_request_error", message: "Captured." },
                    }),
                );
            });
        });
        await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
        const base = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`;
        const claudeCwd = await mkdtemp(join(tmpdir(), "wire-refeed-"));
        const root = createRootContext().named("wire-refeed");
        const differences: string[] = [];
        try {
            for (const family of FAMILIES) {
                const order = JSON.parse(
                    await readFile(join(WIRE, family, "order.json"), "utf8"),
                ) as string[];
                const captured = new Map<string, string>();
                const tools: SessionTool[] = [];
                for (const key of order) {
                    const text = await readFile(join(WIRE, family, `${key}.json`), "utf8");
                    const tool = toolOf(family, JSON.parse(text) as Record<string, unknown>);
                    if (tool === undefined) continue;
                    captured.set(tool.name, text);
                    if (family !== "claude" || !CLAUDE_CODE_OWN_TOOLS.has(tool.name))
                        tools.push(tool);
                }
                if (family === "claude") tools.push(CLAUDE_DEFERRED_PROBE);
                const { provider, model, effort } = await providerFor(family, base, claudeCwd);
                const session = await provider.session(`refeed-${family}`, {
                    instructions: "Refeed.",
                    tools,
                });
                const abort = new AbortController();
                const ctx = withLifetime(root, abort.signal);
                const drained = (async () => {
                    try {
                        for await (const _event of session.run(ctx, {
                            context: {
                                instructions: "Refeed.",
                                messages: [
                                    { role: "user", content: [{ type: "text", text: "Hello." }] },
                                ],
                            },
                            model,
                            effort,
                        })) {
                            // Draining the stream is what performs the request under test.
                        }
                    } catch {
                        // The local vendor refuses every request once it has recorded the body.
                    }
                })();
                const deadline = Date.now() + 60_000;
                while (!bodies.has(family) && Date.now() < deadline)
                    await new Promise((done) => setTimeout(done, 50));
                abort.abort();
                await drained;
                session.destroy();
                const body = bodies.get(family);
                expect(body, `${family} request`).toBeDefined();
                for (const sent of (JSON.parse(body!) as { tools?: Record<string, unknown>[] })
                    .tools ?? []) {
                    const tool = toolOf(family, sent);
                    if (tool === undefined || !captured.has(tool.name)) continue;
                    const original = captured.get(tool.name)!;
                    if (JSON.stringify(sent) !== original)
                        differences.push(`${family}/${tool.name}`);
                    captured.delete(tool.name);
                }
                for (const name of captured.keys())
                    differences.push(`${family}/${name} (not sent)`);
            }
        } finally {
            await new Promise<void>((done) => http.close(() => done()));
            await rm(claudeCwd, { recursive: true, force: true });
        }
        expect(differences).toEqual([]);
    },
    600_000,
);
