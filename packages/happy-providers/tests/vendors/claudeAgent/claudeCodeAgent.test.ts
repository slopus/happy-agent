import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderUsage } from "@/core/ProviderUsage.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionUsage } from "@/core/SessionUsage.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { claudeCodeAgent } from "@/vendors/foreignAgents/claudeCodeAgent.js";

const WINDOW = 200_000;
const SUMMARY = "SUMMARY OF EVERYTHING SO FAR";

/** What one request's prompt costs, split the way Anthropic reports it. */
interface PromptUsage {
    readonly input_tokens: number;
    readonly cache_read_input_tokens: number;
    readonly cache_creation_input_tokens: number;
}

interface FakeRequest {
    /** Claude Code is asking for a summary of the conversation to compact it. */
    readonly summarizing: boolean;
    /** The conversation was already replaced by the summary. */
    readonly compacted: boolean;
}

/**
 * Anthropic's Messages API as far as Claude Code needs it. Each request costs what `measure`
 * says; past a 200k window it is refused as the real API refuses it, otherwise it gets a short
 * reply, or the summary when Claude Code asks for one.
 */
async function fakeMessagesApi(
    measure: (request: FakeRequest) => PromptUsage,
    headers: Record<string, string> = {},
): Promise<{
    readonly url: string;
    readonly summaries: () => number;
}> {
    let summaries = 0;
    const server = createServer((request, response) => {
        void readBody(request).then((text) => {
            if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
                response.writeHead(404).end();
                return;
            }
            if (request.url.startsWith("/v1/messages/count_tokens")) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ input_tokens: 100 }));
                return;
            }
            const body = JSON.parse(text) as { stream?: boolean; model: string };
            const summarizing = text.includes("Your task is to create a detailed summary");
            const prompt = measure({ summarizing, compacted: text.includes(SUMMARY) });
            const size =
                prompt.input_tokens +
                prompt.cache_read_input_tokens +
                prompt.cache_creation_input_tokens;
            if (size > WINDOW) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        type: "error",
                        error: {
                            type: "invalid_request_error",
                            message: `prompt is too long: ${size} tokens > ${WINDOW} maximum`,
                        },
                    }),
                );
                return;
            }
            if (summarizing) summaries++;
            const reply = summarizing ? `<summary>${SUMMARY}</summary>` : "ok";
            const message = {
                id: `msg_${Math.random().toString(36).slice(2)}`,
                type: "message",
                role: "assistant",
                model: body.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { ...prompt, output_tokens: 1 },
            };
            if (body.stream !== true) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        ...message,
                        content: [{ type: "text", text: reply }],
                        stop_reason: "end_turn",
                        usage: { ...prompt, output_tokens: 7 },
                    }),
                );
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream", ...headers });
            const send = (data: Record<string, unknown> & { type: string }) =>
                response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
            send({ type: "message_start", message });
            send({
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            });
            send({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: reply },
            });
            send({ type: "content_block_stop", index: 0 });
            send({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 7 },
            });
            send({ type: "message_stop" });
            response.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, summaries: () => summaries };
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

const servers: Server[] = [];
const sessions: AcpSession[] = [];
afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.destroy()));
    await Promise.all(
        servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
});

/** Unmodified Claude Code through Happy's Claude Code agent, pointed at the fake API. */
async function claudeCode(
    url: string,
    options: {
        /** A Claude subscription login instead of an API key, which has no account limits. */
        readonly subscription?: boolean;
        readonly onAccountUsage?: (usage: ProviderUsage) => void;
    } = {},
) {
    const directory = mkdtempSync(join(tmpdir(), "claude-code-agent-"));
    const provider = new AcpProvider({
        connect: claudeCodeAgent.connect({
            env: {
                ANTHROPIC_BASE_URL: url,
                ...(options.subscription === true
                    ? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test" }
                    : { ANTHROPIC_API_KEY: "sk-ant-test" }),
                CLAUDE_CONFIG_DIR: join(directory, "config"),
            },
            ...(options.onAccountUsage === undefined
                ? {}
                : { onAccountUsage: options.onAccountUsage }),
        }),
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "full_access" }),
        profile: claudeCodeAgent.profile,
    });
    const session = await provider.session("agent-1", { instructions: "Be Happy.", tools: [] });
    sessions.push(session);
    const messages: SessionMessage[] = [];
    return {
        /** Send one user message; its turn's reported usage, or the error it ended with. */
        async turn(text: string): Promise<SessionUsage | string> {
            messages.push({ role: "user", content: [{ type: "text", text }] });
            let usage: SessionUsage | undefined;
            let reply = "";
            const ctx = createRootContext().named("claude-code-agent-test");
            for await (const event of session.run(ctx, {
                context: { instructions: "Be Happy.", messages },
                model: "claude-code/sonnet",
            })) {
                if (event.type === "token_usage") usage = event.usage;
                if (event.type === "text_delta") reply += event.delta;
                if (event.type === "done") {
                    if (event.state === "error") return event.message;
                    break;
                }
            }
            messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
            return usage ?? "no usage reported";
        },
    };
}

describe("Claude Code agent", () => {
    it("reports the context a turn filled, cached prompt included", async () => {
        const api = await fakeMessagesApi(() => ({
            input_tokens: 12,
            cache_read_input_tokens: 40_000,
            cache_creation_input_tokens: 3_000,
        }));
        const agent = await claudeCode(api.url);

        expect(await agent.turn("hello")).toMatchObject({
            input: 43_012,
            cacheRead: 40_000,
            cacheWrite: 3_000,
        });
    }, 60_000);

    it("compacts its own context once the conversation outgrows the window", async () => {
        let context = 30_000;
        const api = await fakeMessagesApi((request) => ({
            input_tokens: 10,
            cache_read_input_tokens: request.summarizing || request.compacted ? 5_000 : context,
            cache_creation_input_tokens: 0,
        }));
        const agent = await claudeCode(api.url);

        await agent.turn("first");
        context = 230_000;
        const outgrown = await agent.turn("second");
        const after = await agent.turn("third");

        expect({ outgrown, after, summaries: api.summaries() }).toMatchObject({
            outgrown: { input: 5_010 },
            after: { input: 5_010 },
            summaries: 1,
        });
    }, 120_000);

    it("passes on the account's limits Claude reports with each response", async () => {
        const fiveHourReset = 1_900_000_000;
        const weeklyReset = 1_900_300_000;
        const api = await fakeMessagesApi(
            () => ({
                input_tokens: 10,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            }),
            {
                "anthropic-ratelimit-unified-status": "allowed",
                "anthropic-ratelimit-unified-5h-status": "allowed",
                "anthropic-ratelimit-unified-5h-utilization": "0.25",
                "anthropic-ratelimit-unified-5h-reset": String(fiveHourReset),
                "anthropic-ratelimit-unified-7d-status": "allowed",
                "anthropic-ratelimit-unified-7d-utilization": "0.5",
                "anthropic-ratelimit-unified-7d-reset": String(weeklyReset),
                "anthropic-ratelimit-unified-representative-claim": "five_hour",
                "anthropic-ratelimit-unified-reset": String(fiveHourReset),
            },
        );
        const usages: ProviderUsage[] = [];
        const agent = await claudeCode(api.url, {
            subscription: true,
            onAccountUsage: (usage) => usages.push(usage),
        });

        await agent.turn("hello");

        expect(usages.map((usage) => ({ ...usage, capturedAt: 0 }))).toEqual([
            {
                providerId: "claude",
                vendor: "claude",
                capturedAt: 0,
                planName: null,
                exhausted: false,
                windows: {
                    fiveHour: null,
                    weekly: {
                        usedPercent: 50,
                        resetsAt: weeklyReset * 1_000,
                        startsAt: weeklyReset * 1_000 - 7 * 24 * 60 * 60 * 1_000,
                        durationMs: 7 * 24 * 60 * 60 * 1_000,
                    },
                    monthly: null,
                    fableWeekly: null,
                },
                credits: null,
            },
        ]);
    }, 60_000);
});
