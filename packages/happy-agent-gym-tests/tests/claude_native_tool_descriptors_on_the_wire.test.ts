import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import {
    AnthropicProvider,
    ClaudeApiKeyCredential,
    resolveClaudeCodeExecutablePath,
    type SessionMessage,
    type SessionTool,
} from "@slopus/happy-providers";
import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { expect, it } from "vitest";

/**
 * Records what the published Claude provider actually sends to Anthropic when a session's tools
 * carry `server` descriptors, and what a replayed call's `vendor.wireName` becomes. A `server`
 * descriptor names a Claude Code built-in, which Claude Code then runs itself, so these requests
 * are the evidence for which descriptors are safe to accept. Each case keeps the first
 * `/v1/messages` request Claude Code sends; `HAPPY_AGENT_SURFACE_UPDATE=1` rewrites the fixture.
 */
const FIXTURE = resolve(import.meta.dirname, "../fixtures/claude-native-tools/requests.json");

const eager: SessionTool = {
    name: "eager_probe",
    description: "An ordinary client tool.",
    parameters: Type.Object({}),
};
const deferred: SessionTool = {
    name: "deferred_probe",
    description: "A client tool marked for deferred loading.",
    parameters: Type.Object({}),
    defer: true,
};
const toolSearch: SessionTool = { name: "ToolSearch", server: { type: "ToolSearch" } };

const hello: SessionMessage = { role: "user", content: [{ type: "text", text: "Hello." }] };

interface Case {
    tools: readonly SessionTool[];
    messages: readonly SessionMessage[];
}

const CASES: Record<string, Case> = {
    no_descriptor: { tools: [eager, deferred], messages: [hello] },
    tool_search_only: { tools: [toolSearch, eager], messages: [hello] },
    tool_search_with_deferred: { tools: [toolSearch, eager, deferred], messages: [hello] },
    bash_descriptor: {
        tools: [{ name: "Bash", server: { type: "Bash" } }, eager],
        messages: [hello],
    },
    web_fetch_descriptor: {
        tools: [toolSearch, { name: "WebFetch", server: { type: "WebFetch" } }, eager, deferred],
        messages: [hello],
    },
    replayed_wire_name: {
        tools: [eager],
        messages: [
            hello,
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: "toolu_replayed",
                        name: "eager_probe",
                        arguments: "{}",
                        vendor: { type: "claude_tool_use", wireName: "Bash" },
                    },
                ],
            },
            {
                role: "tool",
                callId: "toolu_replayed",
                content: [{ type: "text", text: "Done." }],
            },
            { role: "user", content: [{ type: "text", text: "Continue." }] },
        ],
    },
};

interface Observed {
    input: unknown;
    tools: Record<string, unknown>[];
    toolUses: { id: unknown; name: unknown }[];
}

async function firstRequest(name: string, entry: Case): Promise<Record<string, unknown>> {
    let body: string | undefined;
    const http = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const post = request.method === "POST";
            if (post && body === undefined && request.url?.startsWith("/v1/messages"))
                body = Buffer.concat(chunks).toString("utf8");
            response.writeHead(post ? 400 : 200, { "content-type": "application/json" });
            response.end(
                post
                    ? JSON.stringify({
                          type: "error",
                          error: { type: "invalid_request_error", message: "Captured." },
                      })
                    : "{}",
            );
        });
    });
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    const cwd = await mkdtemp(join(tmpdir(), "claude-native-"));
    const abort = new AbortController();
    try {
        const provider = new AnthropicProvider({
            inferenceMaxRetries: 0,
            credential: (await ClaudeApiKeyCredential.tryLoad({ apiKey: "wire-key" }))!,
            cwd,
            env: {
                ...process.env,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`,
            },
            pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
        });
        const session = await provider.session(`claude-native-${name}`, {
            instructions: "Probe.",
            tools: entry.tools,
        });
        const drained = (async () => {
            try {
                for await (const _event of session.run(
                    withLifetime(createRootContext().named("claude-native"), abort.signal),
                    {
                        context: { instructions: "Probe.", messages: entry.messages },
                        model: "anthropic/opus-5-5",
                        effort: "medium",
                    },
                )) {
                    // Draining the stream is what performs the request under test.
                }
            } catch {
                // The local vendor refuses every request once it has recorded the body.
            }
        })();
        const deadline = Date.now() + 60_000;
        while (body === undefined && Date.now() < deadline)
            await new Promise((done) => setTimeout(done, 50));
        abort.abort();
        await drained;
        session.destroy();
    } finally {
        await new Promise<void>((done) => http.close(() => done()));
        await rm(cwd, { recursive: true, force: true });
    }
    expect(body, `${name} request`).toBeDefined();
    return JSON.parse(body!) as Record<string, unknown>;
}

it.runIf(process.platform === "linux")(
    "sends only the Claude Code built-ins a server descriptor names",
    async () => {
        const observed: Record<string, Observed> = {};
        for (const [name, entry] of Object.entries(CASES)) {
            const request = await firstRequest(name, entry);
            const messages = request["messages"] as { content: unknown }[];
            observed[name] = {
                input: JSON.parse(JSON.stringify({ tools: entry.tools })),
                tools: (request["tools"] as Record<string, unknown>[] | undefined) ?? [],
                toolUses: messages.flatMap((message) =>
                    Array.isArray(message.content)
                        ? (message.content as Record<string, unknown>[])
                              .filter((block) => block["type"] === "tool_use")
                              .map((block) => ({ id: block["id"], name: block["name"] }))
                        : [],
                ),
            };
        }
        const names = (key: string) =>
            observed[key]!.tools.map(
                (tool) => `${String(tool["name"])}${tool["defer_loading"] === true ? "*" : ""}`,
            );

        // Claude Code adds tool search only when it is named and something is deferred.
        expect(names("no_descriptor")).toEqual(["deferred_probe", "eager_probe"]);
        expect(names("tool_search_only")).toEqual(["eager_probe"]);
        expect(names("tool_search_with_deferred")).toEqual([
            "ToolSearch",
            "DeferredToolPlaceholder*",
            "eager_probe",
        ]);
        // Any other descriptor puts that native built-in on the wire for Claude Code to run.
        expect(names("bash_descriptor")).toEqual(["Bash", "eager_probe"]);
        const bash = observed["bash_descriptor"]!.tools[0]!;
        expect(Object.keys((bash["input_schema"] as { properties: object }).properties)).toEqual(
            expect.arrayContaining(["command", "dangerouslyDisableSandbox"]),
        );
        // Claude Code defers WebFetch itself, so the first request does not show it.
        expect(names("web_fetch_descriptor")).toEqual([
            "ToolSearch",
            "DeferredToolPlaceholder*",
            "eager_probe",
        ]);
        // A replayed call's vendor.wireName replaces its name on the wire, unchecked.
        expect(names("replayed_wire_name")).toEqual(["eager_probe"]);
        expect(observed["replayed_wire_name"]!.toolUses).toEqual([
            { id: "toolu_replayed", name: "Bash" },
        ]);
        for (const key of ["no_descriptor", "tool_search_only", "tool_search_with_deferred"]) {
            expect(names(key)).not.toContain("Bash");
            expect(names(key)).not.toContain("WebFetch");
        }

        const text = `${JSON.stringify(observed, null, 2)}\n`;
        if (process.env["HAPPY_AGENT_SURFACE_UPDATE"] === "1") {
            await mkdir(resolve(FIXTURE, ".."), { recursive: true });
            await writeFile(FIXTURE, text);
        } else {
            expect(text).toBe(await readFile(FIXTURE, "utf8"));
        }
    },
    600_000,
);
