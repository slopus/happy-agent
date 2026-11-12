import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

/**
 * Claude Code's stream for a turn whose hooks return a `systemMessage`, measured on SDK 0.3.321
 * with and without `includeHookEvents`: each one arrives as an `informational` line, the Stop
 * hook's before the result. A line between turns follows the result.
 */
const sdk = vi.hoisted(() => {
    function notice(uuid: string, content: string, level = "notice") {
        return { type: "system", subtype: "informational", content, level, uuid };
    }
    function query(params: { prompt: AsyncIterable<unknown> }) {
        async function* messages() {
            const input = params.prompt[Symbol.asyncIterator]();
            await input.next();
            yield { type: "system", subtype: "init" };
            yield notice("u1", "UserPromptSubmit says: 3 tasks open");
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "Done." },
                },
            };
            yield notice("u2", "Only in the transcript view", "info");
            yield notice("u3", "Stop says: Task Tree\n- [x] A: ship it");
            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "Done.",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
            };
            yield notice("u4", "Notification says: between turns");
            await input.next();
        }
        const iterator = messages();
        return Object.assign(iterator, {
            supportedModels: async () => [],
            setModel: async () => undefined,
            applyFlagSettings: async () => undefined,
            setPermissionMode: async () => undefined,
            interrupt: async () => undefined,
            close: () => undefined,
        });
    }
    return { query };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

const open: AcpSession[] = [];
afterEach(() => {
    for (const session of open.splice(0)) session.destroy();
});

it("shows the lines Claude Code shows the person as finished tool calls, apart from the reply", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-notices-"));
    const provider = new AcpProvider({
        connect: claudeAgentConnect({}),
        stateDirectory: join(directory, "state"),
        environment: () => ({ cwd: directory, permissionMode: "full_access" }),
    });
    const session = await provider.session("agent-1", { instructions: "Be Happy.", tools: [] });
    open.push(session);
    const events: SessionEvent[] = [];
    const ctx = withLifetime(createRootContext().named("test"), new AbortController().signal);
    for await (const event of session.run(ctx, {
        context: {
            instructions: "Be Happy.",
            messages: [{ role: "user", content: [{ type: "text", text: "ship it" }] }],
        },
    })) {
        events.push(event);
        if (event.type === "done") break;
    }

    const reply = events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");
    expect(reply).toBe("Done.");
    const calls = events.flatMap((event) =>
        event.type === "toolcall_end" ? [JSON.parse(event.arguments) as { title: string }] : [],
    );
    expect(calls.map((call) => call.title)).toEqual([
        "UserPromptSubmit says: 3 tasks open",
        "Stop says: Task Tree",
    ]);
    const results = events.flatMap((event) =>
        event.type === "toolcall_result_end" ? [event.content] : [],
    );
    expect(results[1]).toEqual([{ type: "text", text: "Stop says: Task Tree\n- [x] A: ship it" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", state: "normal", endTurn: true });
}, 30_000);
