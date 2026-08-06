#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeOAuthCredential } from "@/vendors/claude/ClaudeOAuthCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { resolveClaudeModelId } from "@/vendors/claude/impl/resolveClaudeModelId.js";
import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";
import type { SessionMessage, SessionToolCall } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { createClaudeTestInstructions } from "./createClaudeTestInstructions.js";

const outputArgument = process.argv[2];
if (outputArgument === undefined) {
    throw new Error(
        "Usage: pnpm exec vite-node tests/vendors/captureClaudeProviderTrace.ts <output.json>",
    );
}

const outputPath = resolve(outputArgument);
const initialModel = process.argv[3] ?? "opus[1m]";
const switchedModel = process.argv[4] ?? "sonnet[1m]";
const sessionId = randomUUID();
const cwd = await mkdtemp(join(tmpdir(), "rig-claude-provider-trace-"));
const exchanges: CapturedExchange[] = [];
const server = createServer(async (request, response) => {
    try {
        const body = Buffer.concat(await readBody(request));
        const upstream = await forward(request, body);
        const responseBody = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(upstream.status, responseHeaders(upstream.headers));
        response.end(responseBody);
        if (request.method === "POST" && request.url?.startsWith("/v1/messages")) {
            exchanges.push({
                request: {
                    method: request.method,
                    path: request.url,
                    headers: stableRequestHeaders(request.headers),
                    body: JSON.parse(body.toString("utf8")),
                },
                response: {
                    status: upstream.status,
                    headers: stableResponseHeaders(upstream.headers),
                    events: parseSse(responseBody.toString("utf8")),
                },
            });
        }
    } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                type: "error",
                error: { type: "api_error", message: String(error) },
            }),
        );
    }
});
await listen(server);
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Missing capture port.");

const credential =
    (await ClaudeAuthTokenCredential.tryLoad({ env: process.env })) ??
    (await ClaudeOAuthCredential.tryLoad({ env: process.env })) ??
    (await ClaudeCodeCredential.tryLoad({ env: process.env }));
if (credential === null) throw new Error("Missing Claude Code credentials.");
const providerEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
    TZ: "UTC",
};
const session = new ClaudeSession(sessionId, {
    instructions: createClaudeTestInstructions(initialModel, { cwd, env: providerEnv }),
    credential,
    env: providerEnv,
    modelConfigurations: {
        [resolveClaudeModelId(initialModel)]: {
            instructions: createClaudeTestInstructions(initialModel, {
                cwd,
                env: providerEnv,
            }),
            tools: resolveClaudeTools(initialModel),
        },
        [resolveClaudeModelId(switchedModel)]: {
            instructions: createClaudeTestInstructions(switchedModel, {
                cwd,
                env: providerEnv,
            }),
            tools: resolveClaudeTools(switchedModel),
        },
    },
    model: initialModel,
    tools: resolveClaudeTools(initialModel),
});

const turns: CapturedTurn[] = [];
let captureError: unknown;
try {
    const firstPrompt =
        "Call the Read tool exactly once with file_path /virtual/provider-golden.txt. Do not reply with text before the tool call.";
    const first = await captureTurn(firstPrompt, [{ role: "user", content: firstPrompt }]);
    const readCall = first.toolCalls.find((call) => call.name === "Read");
    if (readCall === undefined) throw new Error("Claude did not call the Read tool.");

    const afterToolPrompt: SessionMessage[] = [
        { role: "user", content: firstPrompt },
        { role: "assistant", content: first.text, toolCalls: first.toolCalls },
        {
            role: "tool",
            callId: readCall.callId,
            content: "PROVIDER_TOOL_MARKER",
            vendor: { type: "claude_tool_use" },
        },
    ];
    const afterTool = await captureTurn("<tool-result>", afterToolPrompt);
    if (!afterTool.text.includes("PROVIDER_TOOL_MARKER")) {
        throw new Error("Claude did not consume the Rig-supplied tool result.");
    }

    const secondPrompt =
        "Remember PROVIDER_SKILL_MARKER and PROVIDER_TOOL_MARKER. Reply exactly SECOND.";
    const secondContext: SessionMessage[] = [
        ...afterToolPrompt,
        { role: "assistant", content: afterTool.text },
        { role: "user", content: secondPrompt },
    ];
    const second = await captureTurn(secondPrompt, secondContext);

    const switchedPrompt = "After switching models, reply exactly SWITCHED.";
    const switchedContext: SessionMessage[] = [
        ...secondContext,
        { role: "assistant", content: second.text },
        { role: "user", content: switchedPrompt },
    ];
    await captureTurn(switchedPrompt, switchedContext, switchedModel);

    const compactInstructions =
        "Preserve PROVIDER_SKILL_MARKER, PROVIDER_TOOL_MARKER, SECOND, and SWITCHED exactly.";
    const exchangeStart = exchanges.length;
    const compacted = await session.compact({ instructions: compactInstructions });
    turns.push({
        kind: "compact",
        model: switchedModel,
        prompt: `/compact ${compactInstructions}`,
        exchangeIndexes: exchangeRange(exchangeStart),
        result: compacted,
    });
    if (compacted.status !== "completed") {
        throw new Error(`Claude native compaction failed: ${JSON.stringify(compacted)}`);
    }

    const continuedPrompt =
        "Using only compacted context, reply exactly POST_COMPACT PROVIDER_SKILL_MARKER PROVIDER_TOOL_MARKER SECOND SWITCHED.";
    const continued = await captureTurn(
        continuedPrompt,
        [...compacted.context.messages, { role: "user", content: continuedPrompt }],
        switchedModel,
    );
    if (
        continued.text.trim() !==
        "POST_COMPACT PROVIDER_SKILL_MARKER PROVIDER_TOOL_MARKER SECOND SWITCHED"
    ) {
        throw new Error(`Unexpected post-compaction response: ${continued.text}`);
    }
} catch (error) {
    captureError = error;
} finally {
    session.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const trace = normalize({
        formatVersion: 1,
        source: {
            capture: "forwarded-live-inference",
            client: "rig-claude-provider",
            sdk: "@anthropic-ai/claude-agent-sdk",
        },
        scenario: {
            initialModel,
            switchedModel,
            session: "mcp-tool-model-switch-native-compaction",
        },
        turns,
        exchanges,
        ...(captureError === undefined ? {} : { captureError: String(captureError) }),
    });
    await writeFile(outputPath, `${JSON.stringify(trace, null, 2)}\n`);
    await rm(cwd, { force: true, recursive: true });
}
if (captureError !== undefined) throw captureError;
process.stdout.write(`Captured live Claude provider trace to ${outputPath}\n`);

async function captureTurn(
    prompt: string,
    messages: SessionMessage[],
    model?: string,
): Promise<CapturedRun> {
    const exchangeStart = exchanges.length;
    const events: SessionEvent[] = [];
    for await (const event of session.run({
        context: { messages },
        ...(model === undefined ? {} : { model }),
    })) {
        events.push(event);
    }
    const result = {
        kind: "run" as const,
        model: model ?? initialModel,
        prompt,
        exchangeIndexes: exchangeRange(exchangeStart),
        events,
        text: events
            .filter((event) => event.type === "text_delta")
            .map((event) => event.delta)
            .join(""),
        toolCalls: collectToolCalls(events),
    };
    turns.push(result);
    return result;
}

function collectToolCalls(events: readonly SessionEvent[]): SessionToolCall[] {
    const calls = new Map<string, SessionToolCall>();
    for (const event of events) {
        if (event.type === "toolcall_start") {
            calls.set(event.callId, {
                callId: event.callId,
                name: event.name,
                arguments: "",
                vendor: event.vendor,
            });
        } else if (event.type === "toolcall_delta") {
            const current = calls.get(event.callId);
            if (current !== undefined) {
                calls.set(event.callId, {
                    ...current,
                    arguments: current.arguments + event.delta,
                });
            }
        } else if (event.type === "toolcall_end") {
            const current = calls.get(event.callId);
            if (current !== undefined) {
                calls.set(event.callId, { ...current, arguments: event.arguments });
            }
        }
    }
    return [...calls.values()];
}

function exchangeRange(start: number): number[] {
    return Array.from({ length: exchanges.length - start }, (_, index) => start + index);
}

interface CapturedExchange {
    request: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body: unknown;
    };
    response: {
        status: number;
        headers: Record<string, string>;
        events: unknown[];
    };
}

interface CapturedRun {
    kind: "run";
    model: string;
    prompt: string;
    exchangeIndexes: number[];
    events: SessionEvent[];
    text: string;
    toolCalls: SessionToolCall[];
}

interface CapturedTurn {
    kind: "run" | "compact";
    model: string;
    prompt: string;
    exchangeIndexes: number[];
    [key: string]: unknown;
}

function readBody(request: IncomingMessage): Promise<Buffer[]> {
    return new Promise((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("end", () => resolveBody(chunks));
        request.once("error", reject);
    });
}

function listen(httpServer: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolveListen, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolveListen);
    });
}

async function forward(request: IncomingMessage, body: Buffer): Promise<Response> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        if (
            value === undefined ||
            ["connection", "content-length", "host"].includes(name.toLowerCase())
        ) {
            continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    return fetch(`https://api.anthropic.com${request.url}`, {
        method: request.method ?? "POST",
        headers,
        body,
    });
}

function responseHeaders(headers: Headers): Record<string, string> {
    return Object.fromEntries(
        [...headers].filter(
            ([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name),
        ),
    );
}

function stableRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
    return selectHeaders(headers, [
        "anthropic-beta",
        "anthropic-version",
        "content-type",
        "user-agent",
        "x-app",
    ]);
}

function stableResponseHeaders(headers: Headers): Record<string, string> {
    return selectHeaders(Object.fromEntries(headers), [
        "anthropic-organization-id",
        "content-type",
        "request-id",
    ]);
}

function selectHeaders(
    headers: IncomingHttpHeaders | Record<string, string>,
    names: readonly string[],
): Record<string, string> {
    const selected: Record<string, string> = {};
    for (const name of names) {
        const value = headers[name.toLowerCase()];
        if (value !== undefined) {
            selected[name] = Array.isArray(value) ? value.join(", ") : value;
        }
    }
    return selected;
}

function parseSse(text: string): unknown[] {
    return text.split(/\r?\n\r?\n/u).flatMap((record) => {
        const data = record
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
        return data.length === 0 ? [] : [JSON.parse(data)];
    });
}

function normalize(value: unknown): unknown {
    const home = homedir();
    const visit = (item: unknown, key?: string): unknown => {
        if (typeof item === "string") {
            return (
                item
                    .replaceAll(sessionId, "<SESSION_ID>")
                    .replaceAll(cwd, "<WORKSPACE>")
                    .replaceAll(home, "<HOME>")
                    .replace(
                        /[^/\s"]*rig-claude-provider-(?:trace|golden)-[^/\s"]+/gu,
                        "<WORKSPACE_SLUG>",
                    )
                    .replace(
                        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
                        "<UUID>",
                    )
                    .replace(
                        /(?:req|msg|toolu)_[A-Za-z0-9_-]+/gu,
                        (identifier) =>
                            `<${identifier.slice(0, identifier.indexOf("_")).toUpperCase()}_ID>`,
                    )
                    // Claude Code currently ignores CLAUDE_CODE_OVERRIDE_DATE for this reminder.
                    // Keep the golden stable while preserving every other prompt byte.
                    .replace(/(?<=Today's date is )\d{4}-\d{2}-\d{2}(?=\.)/gu, "<CURRENT_DATE>")
                    .replace(/(?<=current date is )\d{4}-\d{2}-\d{2}/gu, "<CURRENT_DATE>")
            );
        }
        if (Array.isArray(item)) return item.map((child) => visit(child));
        if (item !== null && typeof item === "object") {
            return Object.fromEntries(
                Object.entries(item).map(([childKey, child]) => [
                    childKey,
                    childKey === "timestamp"
                        ? "<TIMESTAMP>"
                        : ["signature", "thinking_signature"].includes(childKey)
                          ? "<SIGNATURE>"
                          : ["uuid", "request_id"].includes(childKey)
                            ? `<${childKey.toUpperCase()}>`
                            : visit(child, childKey),
                ]),
            );
        }
        if (key === "duration_ms" || key === "duration_api_ms") return "<DURATION_MS>";
        return item;
    };
    return visit(value);
}
