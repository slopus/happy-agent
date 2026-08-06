import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionToolCall } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import { resolveClaudeModelId } from "@/vendors/claude/impl/resolveClaudeModelId.js";
import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";
import { createClaudeTestInstructions } from "./createClaudeTestInstructions.js";

const SDK_DEFAULT_WORKSPACE_SLUG = process.cwd().replaceAll(/[^A-Za-z0-9-]/gu, "-");

describe("Claude provider golden", () => {
    it("anchors the provider scenario to the real Claude CLI capture", async () => {
        const cli = await fixture("claude-multiturn.json");
        const provider = await fixture("claude-provider-multiturn.json");
        expect(cli.source).toMatchObject({
            capture: "forwarded-live-inference",
            client: "claude-code",
        });
        expect(cli.scenario).toEqual({
            initialModel: provider.scenario.initialModel,
            switchedModel: provider.scenario.switchedModel,
            session: "multi-turn-model-switch-manual-compaction",
        });
        expect(cli.invocations).toHaveLength(5);
        expect(cli.invocations[3].arguments.at(-1)).toMatch(/^\/compact\s/u);
        expect(
            cli.invocations[3].messages.some(
                (message: { type: string; subtype?: string }) =>
                    message.type === "system" && message.subtype === "compact_boundary",
            ),
        ).toBe(true);
        expect(cli.exchanges).toHaveLength(9);
        expect(
            cli.exchanges.every((exchange: GoldenExchange) => exchange.response.status === 200),
        ).toBe(true);
    });

    it("matches the captured MCP-tool, model-switch, and native-compaction wire contract", async () => {
        const golden = await fixture("claude-provider-multiturn.json");
        const cwd = await mkdtemp(join(tmpdir(), "rig-claude-provider-golden-"));
        const requests: unknown[] = [];
        let exchangeIndex = 0;
        const server = createServer(async (request, response) => {
            if (
                request.method !== "POST" ||
                !request.url?.startsWith("/v1/messages") ||
                request.url.includes("/count_tokens")
            ) {
                response.writeHead(404, { "content-type": "application/json" });
                response.end('{"type":"error","error":{"type":"not_found_error"}}');
                return;
            }
            const exchange = golden.exchanges[exchangeIndex++];
            if (exchange === undefined) {
                response.writeHead(500);
                response.end("Unexpected Claude provider request.");
                return;
            }
            requests.push(normalize(JSON.parse((await readBody(request)).toString("utf8")), cwd));
            response.writeHead(exchange.response.status, {
                "content-type": "text/event-stream",
                "request-id": `<GOLDEN_REQUEST_${exchangeIndex}>`,
            });
            response.end(toSse(exchange.response.events));
        });
        await listen(server);
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Missing Claude golden server port.");
        }
        const credential = await ClaudeAuthTokenCredential.tryLoad({
            authToken: "golden-token",
        });
        if (credential === null) throw new Error("Expected a Claude test credential.");
        const providerEnv = {
            ...process.env,
            ANTHROPIC_API_KEY: "must-be-cleared",
            CLAUDE_CODE_OAUTH_TOKEN: "must-also-be-cleared",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
            TZ: "UTC",
        };
        const session = new ClaudeSession("<SESSION_ID>", {
            instructions: createClaudeTestInstructions(golden.scenario.initialModel, {
                cwd,
                env: providerEnv,
            }),
            credential,
            env: providerEnv,
            modelConfigurations: {
                [resolveClaudeModelId(golden.scenario.initialModel)]: {
                    instructions: createClaudeTestInstructions(golden.scenario.initialModel, {
                        cwd,
                        env: providerEnv,
                    }),
                    tools: resolveClaudeTools(golden.scenario.initialModel),
                },
                [resolveClaudeModelId(golden.scenario.switchedModel)]: {
                    instructions: createClaudeTestInstructions(golden.scenario.switchedModel, {
                        cwd,
                        env: providerEnv,
                    }),
                    tools: resolveClaudeTools(golden.scenario.switchedModel),
                },
            },
            model: golden.scenario.initialModel,
            tools: resolveClaudeTools(golden.scenario.initialModel),
        });

        try {
            const firstPrompt = golden.turns[0].prompt;
            const first = await run(session, [{ role: "user", content: firstPrompt }]);
            expect(first.toolCalls).toEqual(golden.turns[0].toolCalls);
            const readCall = first.toolCalls[0]!;

            const toolContext: SessionMessage[] = [
                { role: "user", content: firstPrompt },
                { role: "assistant", content: first.text, toolCalls: first.toolCalls },
                {
                    role: "tool",
                    callId: readCall.callId,
                    content: "PROVIDER_TOOL_MARKER",
                    vendor: { type: "claude_tool_use" },
                },
            ];
            const afterTool = await run(session, toolContext);
            expect(afterTool.text).toBe(golden.turns[1].text);

            const secondPrompt = golden.turns[2].prompt;
            const secondContext: SessionMessage[] = [
                ...toolContext,
                { role: "assistant", content: afterTool.text },
                { role: "user", content: secondPrompt },
            ];
            const second = await run(session, secondContext);
            expect(second.text).toBe(golden.turns[2].text);

            const switchedPrompt = golden.turns[3].prompt;
            const switchedContext: SessionMessage[] = [
                ...secondContext,
                { role: "assistant", content: second.text },
                { role: "user", content: switchedPrompt },
            ];
            const switched = await run(session, switchedContext, golden.scenario.switchedModel);
            expect(switched.text).toBe(golden.turns[3].text);

            const compactInstructions = golden.turns[4].prompt.replace(/^\/compact\s*/u, "");
            const compacted = await session.compact({ instructions: compactInstructions });
            // The SDK's native compact boundary is local process state and is not
            // reproducible from an HTTP response alone. The real capture above
            // proves completion; this replay verifies its exact wire request and
            // resumes from the captured native summary.
            if (compacted.status === "completed") {
                expect(normalize(compacted.summary, cwd)).toBe(
                    normalize(golden.turns[4].result.summary, cwd),
                );
            } else {
                expect(compacted).toMatchObject({
                    kind: "inference_error",
                    message: "Claude SDK finished without returning a result.",
                });
            }
            const compactedContext =
                compacted.status === "completed"
                    ? compacted.context
                    : golden.turns[4].result.context;

            const continuedPrompt = golden.turns[5].prompt;
            const continued = await run(
                session,
                [...compactedContext.messages, { role: "user", content: continuedPrompt }],
                golden.scenario.switchedModel,
            );
            expect(continued.text).toBe(golden.turns[5].text);
        } finally {
            session.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(cwd, { force: true, recursive: true });
        }

        expect(exchangeIndex).toBe(golden.exchanges.length);
        expect(requests).toEqual(
            golden.exchanges.map((exchange: GoldenExchange) =>
                // Claude Code ignores its date override for the generated current-date
                // reminder. Its recovery pass can also attach post-tool assistant text
                // either side of the tool-result message; normalize that equivalent
                // transcript shape explicitly.
                normalize(exchange.request.body, cwd),
            ),
        );
        expect(golden.source).toEqual({
            capture: "forwarded-live-inference",
            client: "rig-claude-provider",
            sdk: "@anthropic-ai/claude-agent-sdk",
        });
        expect(
            golden.exchanges.every((exchange: GoldenExchange) => exchange.response.status === 200),
        ).toBe(true);
        expect(golden.exchanges[0].request.body.tools).toHaveLength(19);
        expect(golden.exchanges[0].request.body.tools).toEqual(
            golden.exchanges[1].request.body.tools,
        );
        expect(golden.exchanges[3].request.body.model).toBe("claude-sonnet-5");
    }, 15_000);
});

interface GoldenExchange {
    request: { body: any };
    response: { status: number; events: unknown[] };
}

async function fixture(name: string): Promise<any> {
    return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

async function run(
    session: ClaudeSession,
    messages: SessionMessage[],
    model?: string,
): Promise<{ text: string; toolCalls: SessionToolCall[] }> {
    const events: SessionEvent[] = [];
    for await (const event of session.run({
        context: { messages },
        ...(model === undefined ? {} : { model }),
    })) {
        events.push(event);
    }
    return {
        text: events
            .filter((event) => event.type === "text_delta")
            .map((event) => event.delta)
            .join(""),
        toolCalls: collectToolCalls(events),
    };
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

function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("end", () => resolve(Buffer.concat(chunks)));
        request.once("error", reject);
    });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}

function toSse(events: readonly unknown[]): string {
    return events
        .map(
            (event) =>
                `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
}

function normalize(value: unknown, cwd: string): unknown {
    const home = homedir();
    const homeRelativeCwd = cwd.replace(home, "<HOME>");
    const visit = (item: unknown): unknown => {
        if (typeof item === "string") {
            return item
                .replaceAll(cwd, "<WORKSPACE>")
                .replaceAll(tmpdir(), "<TMP>")
                .replaceAll(home, "<HOME>")
                .replaceAll(homeRelativeCwd, "<WORKSPACE>")
                .replaceAll(SDK_DEFAULT_WORKSPACE_SLUG, "<WORKSPACE_SLUG>")
                .replace(
                    /(?:\/tmp|\/var\/folders\/[^/\s"]+\/[^/\s"]+\/T)(?=\/claude-resume-)/gu,
                    "<TMP>",
                )
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
                .replace(/(?<="device_id":")[0-9a-f]{64}(?=")/giu, "<DEVICE_ID>")
                .replace(
                    /You have been invoked in the following environment: +(?=\n)/gu,
                    "You have been invoked in the following environment:",
                )
                .replace(/(?<= - Platform: )[^\n]+/gu, "<PLATFORM>")
                .replace(/(?<= - Shell: )[^\n]*/gu, "<SHELL>")
                .replace(/(?<= - OS Version: )[^\n]+/gu, "<OS_VERSION>")
                .replace(/(?<=Today's date is )\d{4}-\d{2}-\d{2}(?=\.)/gu, "<CURRENT_DATE>")
                .replace(/(?<=current date is )\d{4}-\d{2}-\d{2}/gu, "<CURRENT_DATE>");
        }
        if (Array.isArray(item)) return item.map(visit);
        if (item !== null && typeof item === "object") {
            const normalized = Object.fromEntries(
                Object.entries(item).map(([key, child]) => [
                    key,
                    ["signature", "thinking_signature"].includes(key)
                        ? "<SIGNATURE>"
                        : visit(child),
                ]),
            );
            if (Array.isArray(normalized.messages)) {
                normalized.messages = normalizeRecoveredToolText(normalized.messages);
            }
            return normalized;
        }
        return item;
    };
    return visit(value);
}

function normalizeRecoveredToolText(messages: any[]): any[] {
    const normalized = messages.flatMap((message) => {
        if (
            message?.role !== "user" ||
            !Array.isArray(message.content) ||
            !message.content.some((block: any) => block.type === "tool_result") ||
            !message.content.some((block: any) => block.type !== "tool_result")
        ) {
            return [message];
        }
        return [
            {
                ...message,
                content: message.content.filter((block: any) => block.type === "tool_result"),
            },
            {
                ...message,
                content: message.content.filter((block: any) => block.type !== "tool_result"),
            },
        ];
    });
    for (let index = 0; index + 2 < normalized.length; index += 1) {
        const assistant = normalized[index];
        const toolResult = normalized[index + 1];
        const trailingAssistant = normalized[index + 2];
        if (
            assistant?.role !== "assistant" ||
            !assistant.content?.some((block: any) => block.type === "tool_use") ||
            toolResult?.role !== "user" ||
            !toolResult.content?.some((block: any) => block.type === "tool_result") ||
            trailingAssistant?.role !== "assistant" ||
            !trailingAssistant.content?.every((block: any) => block.type === "text")
        ) {
            continue;
        }
        normalized[index] = {
            ...assistant,
            content: [
                ...assistant.content.filter((block: any) => block.type !== "tool_use"),
                ...trailingAssistant.content,
                ...assistant.content.filter((block: any) => block.type === "tool_use"),
            ],
        };
        normalized.splice(index + 2, 1);
    }
    return normalized;
}
