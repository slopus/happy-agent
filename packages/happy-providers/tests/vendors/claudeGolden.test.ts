import { testContext } from "../testContext.js";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
    SessionAssistantMessage,
    SessionMessage,
    SessionToolCallBlock,
} from "@/core/SessionContext.js";
import { assistantMessageFromEvents } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";
import {
    claudeSessionAttachments,
    type ClaudeSessionAttachment,
} from "@/vendors/claude/impl/claudeSessionAttachments.js";
import { resolveClaudeModelId } from "@/vendors/claude/impl/resolveClaudeModelId.js";
import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";
import { createClaudeTestInstructions } from "./createClaudeTestInstructions.js";

type SessionToolCall = Omit<SessionToolCallBlock, "type">;

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
        const initialInstructions = createClaudeTestInstructions(golden.scenario.initialModel, {
            cwd,
            env: providerEnv,
        });
        const switchedInstructions = createClaudeTestInstructions(golden.scenario.switchedModel, {
            cwd,
            env: providerEnv,
        });
        const session = new ClaudeSession("<SESSION_ID>", {
            instructions: initialInstructions,
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
            const first = await run(
                session,
                [
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: firstPrompt }],
                    },
                ],
                initialInstructions,
            );
            expect(first.toolCalls).toEqual(golden.turns[0].toolCalls);
            const readCall = first.toolCalls[0]!;

            const toolContext: SessionMessage[] = [
                {
                    role: "user",
                    content: [{ type: "text" as const, text: firstPrompt }],
                },
                first.message,
                {
                    role: "tool",
                    content: [{ type: "text" as const, text: "PROVIDER_TOOL_MARKER" }],
                    callId: readCall.callId,
                    vendor: { type: "claude_tool_use" },
                },
            ];
            const afterTool = await run(session, toolContext, initialInstructions);
            expect(afterTool.text).toBe(golden.turns[1].text);

            const secondPrompt = golden.turns[2].prompt;
            const secondContext: SessionMessage[] = [
                ...toolContext,
                afterTool.message,
                {
                    role: "user",
                    content: [{ type: "text" as const, text: secondPrompt }],
                },
            ];
            const second = await run(session, secondContext, initialInstructions);
            expect(second.text).toBe(golden.turns[2].text);

            const switchedPrompt = golden.turns[3].prompt;
            const switchedContext: SessionMessage[] = [
                ...secondContext,
                second.message,
                {
                    role: "user",
                    content: [{ type: "text" as const, text: switchedPrompt }],
                },
            ];
            const switched = await run(
                session,
                switchedContext,
                switchedInstructions,
                golden.scenario.switchedModel,
            );
            expect(switched.text).toBe(golden.turns[3].text);

            const compactInstructions = golden.turns[4].prompt.replace(/^\/compact\s*/u, "");
            const compacted = await session.compact(testContext, {
                context: {
                    instructions: createClaudeTestInstructions(golden.scenario.switchedModel, {
                        cwd,
                        env: providerEnv,
                    }),
                    messages: switchedContext,
                },
                instructions: compactInstructions,
            });
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
                [
                    ...compactedContext.messages,
                    {
                        role: "user",
                        content: [{ type: "text" as const, text: continuedPrompt }],
                    },
                ],
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
            golden.exchanges.map((exchange: GoldenExchange, index: number) => {
                const expectedBody = structuredClone(exchange.request.body);
                // The original capture predates SDK 0.3.251, which now retains the
                // first assistant's signed thinking when replaying the model switch
                // and compaction turns. Keep the capture unchanged and require this
                // exact additional block; all other request fields still match it.
                if (index === 3 || index === 4) {
                    expect(expectedBody.messages[1]).toMatchObject({
                        role: "assistant",
                        content: [{ type: "tool_use" }],
                    });
                    expectedBody.messages[1].content.unshift({
                        type: "thinking",
                        thinking: "",
                        signature: "<SIGNATURE>",
                    });
                }
                // The capture also predates Claude Code 2.1.280, which no longer folds the
                // current-date reminder into the first user turn. It records environment,
                // model, session-context, and date attachments after the first prompt and
                // renders them as one system message directly after that turn: merged plain
                // text for Opus 4.8, three reminders for Sonnet 5. The first user turn becomes
                // a bare string and the first cache breakpoint moves onto the system message.
                // Rig's replay reproduces the same attachments so a rebuilt session sends the
                // same bytes; the recreation-cache test proves that against the live query.
                // Keep the capture unchanged and require these exact shapes.
                const model =
                    index < 3 ? golden.scenario.initialModel : golden.scenario.switchedModel;
                const environmentText = renderClaudeEnvironmentMessage(
                    claudeSessionAttachments({
                        cwd: process.cwd(),
                        env: providerEnv,
                        model: resolveClaudeModelId(model),
                    }),
                    index >= 3,
                );
                const firstTurn = expectedBody.messages[0];
                expect(firstTurn.content[0].text).toContain("# currentDate");
                firstTurn.content.shift();
                if (index === 5) {
                    // A replayed native compaction summary now gains a trailing newline and
                    // Claude Code's own continuation block.
                    firstTurn.content[0].text += "\n";
                    firstTurn.content.push({
                        type: "text",
                        text: "Continue from where you left off.",
                    });
                }
                const breakpointOnFirstTurn = firstTurn.content[0].cache_control !== undefined;
                delete firstTurn.content[0].cache_control;
                if (firstTurn.content.length === 1) firstTurn.content = firstTurn.content[0].text;
                expectedBody.messages.splice(1, 0, {
                    role: "system",
                    content: breakpointOnFirstTurn
                        ? [
                              {
                                  type: "text",
                                  text: environmentText,
                                  cache_control: { type: "ephemeral" },
                              },
                          ]
                        : environmentText,
                });
                // Claude Code ignores its date override for the generated current-date
                // reminder. Its recovery pass can also attach post-tool assistant text
                // either side of the tool-result message; normalize that equivalent
                // transcript shape explicitly.
                return withOneHourCacheTtl(normalize(expectedBody, cwd));
            }),
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
    instructions: string,
    model?: string,
): Promise<{
    text: string;
    toolCalls: SessionToolCall[];
    message: SessionAssistantMessage;
}> {
    const events: SessionEvent[] = [];
    for await (const event of session.run(testContext, {
        context: { instructions, messages },
        ...(model === undefined ? {} : { model }),
    })) {
        events.push(event);
    }
    const message = assistantMessageFromEvents(events);
    if (message === undefined) throw new Error("Missing reconstructed assistant message.");
    return {
        text: events
            .filter((event) => event.type === "text_delta")
            .map((event) => event.delta)
            .join(""),
        toolCalls: collectToolCalls(events),
        message,
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
                .replace(/<TMP>\\claude-resume-[^\s"]+/gu, (path) => path.replaceAll("\\", "/"))
                .replaceAll(home, "<HOME>")
                .replaceAll(homeRelativeCwd, "<WORKSPACE>")
                .replaceAll(SDK_DEFAULT_WORKSPACE_SLUG, "<WORKSPACE_SLUG>")
                .replace(/cc_version=[^;]+;/gu, "cc_version=<CLAUDE_CODE_VERSION>;")
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

function withOneHourCacheTtl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withOneHourCacheTtl);
    if (value === null || typeof value !== "object") return value;
    const projected = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, withOneHourCacheTtl(child)]),
    );
    const cacheControl = projected.cache_control;
    if (
        cacheControl !== null &&
        typeof cacheControl === "object" &&
        "type" in cacheControl &&
        cacheControl.type === "ephemeral"
    ) {
        projected.cache_control = { ...cacheControl, ttl: "1h" };
    }
    return projected;
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

/**
 * How Claude Code 2.1.280 renders its first-prompt attachments into the system message that
 * follows the first user turn. Opus 4.8 receives one merged plain-text block; Sonnet 5 receives
 * each attachment inside its own `<system-reminder>`.
 */
function renderClaudeEnvironmentMessage(
    attachments: readonly ClaudeSessionAttachment[],
    wrapped: boolean,
): string {
    const sections: string[] = [];
    for (const attachment of attachments) {
        if (attachment.type === "environment") {
            const { snapshot } = attachment;
            const lines = [
                `Primary working directory: ${snapshot.workingDirectory}`,
                ...(snapshot.isWorktree
                    ? [
                          "This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT `cd` to the original repository root.",
                          "The git stash stack is shared with the main checkout and all other worktrees, and other Claude sessions may push or pop it concurrently. Never use bare `git stash` / `git stash pop` — you could pop another session's changes. Prefer a temporary WIP commit to set work aside; if you must stash, use `git stash push -u -m \"<unique-tag>\"`, immediately capture your entry's SHA via `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (not pop), and afterwards drop the entry, re-finding its current `stash@{n}` by tag first.",
                      ]
                    : []),
                `Is a git repository: ${snapshot.isGitRepo}`,
                `Platform: ${snapshot.platform}`,
                `Shell: ${snapshot.shell}`,
                `OS Version: ${snapshot.osVersion}`,
            ];
            sections.push(
                `# Environment\nYou have been invoked in the following environment: \n${lines
                    .map((line) => ` - ${line}`)
                    .join("\n")}`,
            );
        } else if (attachment.type === "model") {
            sections.push(attachment.text);
        } else if (attachment.type === "date") {
            sections.push(`Today's date is ${attachment.date}.`);
        }
    }
    return sections
        .map((section) => (wrapped ? `<system-reminder>\n${section}\n</system-reminder>` : section))
        .join("\n\n");
}
