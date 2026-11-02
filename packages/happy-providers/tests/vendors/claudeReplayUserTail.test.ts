import { testContext } from "../testContext.js";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { query as claudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";

import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeSession } from "@/vendors/claude/ClaudeSession.js";

/**
 * When a resumed transcript ends on a user-role entry, Claude Code's print-mode loader splices a
 * synthetic assistant "No response requested." after it, which the model reads as its own reply.
 * `--reply-on-resume` suppresses that only in the interactive REPL, so the replay resumes at its
 * last entry instead, and the loader's truncation drops the placeholder. These tests drive the real
 * SDK against a local server and inspect what actually reaches the API.
 */
describe("Claude replay ending on a user-role entry", () => {
    it("sends file mentions literally without reading or attaching their contents", async () => {
        await withServer(async (harness) => {
            const file = join(harness.cwd, "mentioned.txt");
            await writeFile(file, "FILE_MENTION_MUST_NOT_REACH_INFERENCE");
            const prompt = `Explain the literal reference @${file} without opening it.`;
            const requests = await harness.run([user(prompt)]);

            expect(requests).toHaveLength(1);
            expect(blocks(conversation(requests[0]!)[0])).toEqual([{ type: "text", text: prompt }]);
            expect(JSON.stringify(requests)).not.toContain("FILE_MENTION_MUST_NOT_REACH_INFERENCE");
        });
    }, 15_000);

    it("sends a user slash command literally instead of dispatching native compaction", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([user("/compact Keep this as literal user text.")]);

            expect(requests).toHaveLength(1);
            expect(blocks(conversation(requests[0]!)[0])).toEqual([
                { type: "text", text: "/compact Keep this as literal user text." },
            ]);
        });
    }, 15_000);

    it("suppresses configured command hooks while a control session proves they are executable", async () => {
        await withServer(async (harness) => {
            await harness.run([user("Hooks must not run.")]);
            expect(await harness.readHooks()).toBe("");

            await harness.run([user("Control: hooks may run.")], { disableAllHooks: false });
            expect(await harness.readHooks()).toContain("UserPromptSubmit");
        });
    }, 30_000);

    it("continues literal inference after explicit native compaction with hooks still disabled", async () => {
        await withServer(async (harness) => {
            const { compaction, requests } = await harness.compactAndContinue(
                [user("Read the notes."), readCall(), readResult()],
                "/compact This is the next literal user prompt.",
            );

            expect(compaction.status).toBe("completed");
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(requests[0])).toContain(
                "Your task is to create a detailed summary",
            );
            expect(blocks(conversation(requests[1]!).at(-1))).toEqual([
                { type: "text", text: expect.stringContaining("The notes say to ship on Friday.") },
                { type: "text", text: "/compact This is the next literal user prompt." },
            ]);
            expect(await harness.readHooks()).toBe("");
        });
    }, 30_000);

    it("continues from a tool-result tail without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([user("Read the notes."), readCall(), readResult()]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            expect(messages[1]?.content).toEqual([
                expect.objectContaining({ type: "tool_use", id: "call-read" }),
            ]);
            expect(blocks(messages[2])).toEqual([
                { type: "tool_result", tool_use_id: "call-read", content: "Ship on Friday." },
                { type: "text", text: "Continue from the supplied tool result." },
            ]);
        });
    }, 15_000);

    it("delivers a notice steered after tool results without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                user("Read the notes."),
                readCall(),
                readResult(),
                {
                    role: "agent",
                    author: { id: "coordinator", description: "Coordinator" },
                    content: [{ type: "text", text: "Also check the changelog." }],
                },
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            expect(blocks(messages[2])).toEqual([
                { type: "tool_result", tool_use_id: "call-read", content: "Ship on Friday." },
                {
                    type: "text",
                    text: "<system-reminder>\nMessage from agent Coordinator (coordinator):\n\nAlso check the changelog.\n</system-reminder>",
                },
            ]);
        });
    }, 15_000);

    it("delivers a notice after an unanswered user message without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                user("Read the notes."),
                { role: "assistant", content: [{ type: "text", text: "Done." }] },
                user("Now summarize them."),
                { role: "system", content: [{ type: "text", text: "Keep it short." }] },
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            // Claude Code merges the adjacent user turns, separating them with a newline.
            expect(blocks(messages[2])).toEqual([
                { type: "text", text: "Now summarize them.\n" },
                { type: "text", text: "<system-reminder>\nKeep it short.\n</system-reminder>" },
            ]);
        });
    }, 15_000);

    it("replays an ordinary user prompt after an answer unchanged", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                user("Read the notes."),
                { role: "assistant", content: [{ type: "text", text: "Done." }] },
                user("Now summarize them."),
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            expect(blocks(messages[2])).toEqual([{ type: "text", text: "Now summarize them." }]);
        });
    }, 15_000);

    // The first-prompt attachments follow the first user entry, but the loader still treats a
    // history of leading notices alone as ending on a user turn.
    it("sends leading notices and the first prompt without a placeholder", async () => {
        await withServer(async (harness) => {
            const requests = await harness.run([
                { role: "system", content: [{ type: "text", text: "Project instructions." }] },
                user("Read the notes."),
            ]);

            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user"]);
            expect(blocks(messages[0])).toEqual([
                {
                    type: "text",
                    text: "<system-reminder>\nProject instructions.\n</system-reminder>\n",
                },
                { type: "text", text: "Read the notes." },
            ]);
        });
    }, 15_000);

    it("compacts a context ending on tool results with one native request", async () => {
        await withServer(async (harness) => {
            const { compaction, requests } = await harness.compact([
                user("Read the notes."),
                readCall(),
                readResult(),
            ]);

            expect(compaction.status).toBe("completed");
            expect(requests).toHaveLength(1);
            const messages = conversation(requests[0]!);
            expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
            const tail = blocks(messages[2]);
            expect(tail[0]).toEqual({
                type: "tool_result",
                tool_use_id: "call-read",
                content: "Ship on Friday.",
            });
            expect(tail[1]?.text).toContain("Your task is to create a detailed summary");
        });
    }, 15_000);
});

/**
 * The request's conversation without Claude Code's environment message, after checking that no
 * placeholder reached the API.
 */
function conversation(request: CapturedRequest): CapturedRequest["messages"] {
    expect(JSON.stringify(request.messages)).not.toContain("No response requested.");
    expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
    return request.messages.filter((message) => message.role !== "system");
}

/** Content blocks without the cache breakpoint Claude Code places on the newest turn. */
function blocks(
    message: CapturedRequest["messages"][number] | undefined,
): Array<{ type: string; text?: string; [key: string]: unknown }> {
    if (message === undefined) return [];
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return (message.content as Array<Record<string, unknown>>).map(
        ({ cache_control: _cacheControl, ...block }) =>
            block as { type: string; text?: string; [key: string]: unknown },
    );
}

function user(content: string): SessionMessage {
    return { role: "user", content: [{ type: "text", text: content }] };
}

function readCall(): SessionMessage {
    return {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                callId: "call-read",
                name: "Read",
                arguments: JSON.stringify({ file_path: "/workspace/NOTES.md" }),
            },
        ],
    };
}

function readResult(): SessionMessage {
    return {
        role: "tool",
        callId: "call-read",
        content: [{ type: "text", text: "Ship on Friday." }],
    };
}

interface CapturedRequest {
    messages: Array<{ role: string; content: unknown }>;
}

async function withServer(
    scenario: (harness: {
        cwd: string;
        readHooks: () => Promise<string>;
        compact: (messages: SessionMessage[]) => Promise<{
            compaction: Awaited<ReturnType<ClaudeSession["compact"]>>;
            requests: CapturedRequest[];
        }>;
        compactAndContinue: (
            messages: SessionMessage[],
            prompt: string,
        ) => Promise<{
            compaction: Awaited<ReturnType<ClaudeSession["compact"]>>;
            requests: CapturedRequest[];
        }>;
        run: (
            messages: SessionMessage[],
            options?: { disableAllHooks: false },
        ) => Promise<CapturedRequest[]>;
    }) => Promise<void>,
): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), "rig-claude-user-tail-"));
    const requests: CapturedRequest[] = [];
    const hookMarker = join(cwd, "hook-calls.txt");
    await writeFile(hookMarker, "");
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
        requests.push(JSON.parse((await readBody(request)).toString("utf8")) as CapturedRequest);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(TEXT_RESPONSE);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("Missing Claude replay server port.");
    }
    const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "user-tail-token" });
    if (credential === null) throw new Error("Expected a Claude test credential.");
    const sessions: ClaudeSession[] = [];
    const session = (options?: { disableAllHooks: false }) => {
        const created = new ClaudeSession("<SESSION_ID>", {
            instructions: "You are a careful engineer.",
            credential,
            cwd,
            env: {
                ...process.env,
                ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
                RIG_TEST_HOOK_MARKER: hookMarker,
                TZ: "UTC",
            },
            model: "anthropic/opus-5-5",
            query: (parameters) =>
                claudeSdkQuery({
                    ...parameters,
                    options: {
                        ...parameters.options,
                        settings: {
                            ...(typeof parameters.options?.settings === "object"
                                ? parameters.options.settings
                                : {}),
                            ...options,
                            // Native command hooks obey disableAllHooks; programmatic SDK callbacks
                            // are a separate surface and are never supplied by the provider.
                            hooks: Object.fromEntries(
                                ["SessionStart", "UserPromptSubmit", "PreCompact"].map((event) => [
                                    event,
                                    [
                                        {
                                            hooks: [
                                                {
                                                    type: "command" as const,
                                                    command: `node -e "require('node:fs').appendFileSync(process.env.RIG_TEST_HOOK_MARKER, '${event}\\n')"`,
                                                },
                                            ],
                                        },
                                    ],
                                ]),
                            ),
                        },
                    },
                }),
            tools: [{ name: "Read", description: "Read a file." }],
        });
        sessions.push(created);
        return created;
    };
    try {
        await scenario({
            cwd,
            readHooks: () => readFile(hookMarker, "utf8"),
            compact: async (messages) => {
                const first = requests.length;
                const compaction = await session().compact(testContext, {
                    context: { instructions: "You are a careful engineer.", messages },
                });
                return { compaction, requests: requests.slice(first) };
            },
            compactAndContinue: async (messages, prompt) => {
                const first = requests.length;
                const active = session();
                const compaction = await active.compact(testContext, {
                    context: { instructions: "You are a careful engineer.", messages },
                });
                expect(compaction.status).toBe("completed");
                if (compaction.status !== "completed") throw new Error("Native compaction failed.");
                const events: SessionEvent[] = [];
                for await (const event of active.run(testContext, {
                    context: {
                        ...compaction.context,
                        messages: [...compaction.context.messages, user(prompt)],
                    },
                }))
                    events.push(event);
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                return { compaction, requests: requests.slice(first) };
            },
            run: async (messages, options) => {
                const first = requests.length;
                const events: SessionEvent[] = [];
                for await (const event of session(options).run(testContext, {
                    context: { instructions: "You are a careful engineer.", messages },
                })) {
                    events.push(event);
                }
                expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                return requests.slice(first);
            },
        });
    } finally {
        for (const created of sessions) created.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { force: true, recursive: true });
    }
}

const TEXT_RESPONSE = toSse([
    {
        type: "message_start",
        message: {
            id: "msg_user_tail",
            type: "message",
            role: "assistant",
            model: "claude-opus-5-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
        },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The notes say to ship on Friday." },
    },
    { type: "content_block_stop", index: 0 },
    {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
]);

function toSse(events: readonly unknown[]): string {
    return events
        .map(
            (event) =>
                `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
}

function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.once("end", () => resolve(Buffer.concat(chunks)));
        request.once("error", reject);
    });
}
