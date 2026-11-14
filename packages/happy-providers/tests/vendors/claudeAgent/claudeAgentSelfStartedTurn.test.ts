import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";

import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionMessage, SessionSystemMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

/**
 * Claude Code's own stream as the Agent SDK delivers it, measured on SDK 0.3.321: a prompt that
 * starts a background command ends with a result; when the command finishes, Claude Code starts
 * a turn by itself — with no user message in the stream — and ends it with a second result.
 */
const sdk = vi.hoisted(() => {
    const state = {
        finishBackground: (): void => undefined,
        interrupts: 0,
    };
    function text(value: string) {
        return {
            type: "stream_event",
            parent_tool_use_id: null,
            event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: value },
            },
        };
    }
    function result(index: number, origin?: unknown) {
        return {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            result_index: index,
            ...(origin === undefined ? {} : { origin }),
            usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
        };
    }
    function query(params: { prompt: AsyncIterable<unknown> }) {
        async function* messages() {
            const input = params.prompt[Symbol.asyncIterator]();
            await input.next();
            yield { type: "system", subtype: "init" };
            yield text("Started the build in the background.");
            yield result(0);
            await new Promise<void>((resolve) => (state.finishBackground = resolve));
            yield {
                type: "system",
                subtype: "task_notification",
                task_id: "b1",
                status: "completed",
            };
            yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
            yield { type: "system", subtype: "init" };
            yield { type: "system", subtype: "status", status: "requesting" };
            yield text("The build finished.");
            yield result(1, { kind: "task-notification", producer: "session-task", runId: "r1" });
            await input.next();
        }
        const iterator = messages();
        return Object.assign(iterator, {
            supportedModels: async () => [],
            setModel: async () => undefined,
            applyFlagSettings: async () => undefined,
            setPermissionMode: async () => undefined,
            interrupt: async () => {
                state.interrupts++;
            },
            close: () => undefined,
        });
    }
    return { state, query };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

const open: AcpSession[] = [];
afterEach(() => {
    for (const session of open.splice(0)) session.destroy();
});

const text = (events: readonly SessionEvent[]) =>
    events.map((event) => (event.type === "text_delta" ? event.delta : "")).join("");

it("delivers a turn Claude Code starts by itself through a wake instead of dropping it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claude-self-started-"));
    const notices: SessionSystemMessage[] = [];
    let woken!: () => void;
    const wake = new Promise<void>((resolve) => (woken = resolve));
    const provider = new AcpProvider({
        connect: claudeAgentConnect({}),
        stateDirectory: join(directory, "state"),
        environment: () => ({
            cwd: directory,
            permissionMode: "full_access",
            wake: (notice: SessionSystemMessage) => {
                notices.push(notice);
                woken();
            },
        }),
    });
    const session = await provider.session("agent-1", { instructions: "Be Happy.", tools: [] });
    open.push(session);
    const messages: SessionMessage[] = [
        { role: "user", content: [{ type: "text", text: "build" }] },
    ];
    const run = async (): Promise<SessionEvent[]> => {
        const events: SessionEvent[] = [];
        const accumulator = new SessionAssistantMessageAccumulator();
        const ctx = withLifetime(createRootContext().named("test"), new AbortController().signal);
        for await (const event of session.run(ctx, {
            context: { instructions: "Be Happy.", messages },
        })) {
            events.push(event);
            accumulator.add(event);
            if (event.type === "done") break;
        }
        const message = accumulator.message();
        if (message !== undefined) messages.push(message);
        return events;
    };

    const first = await run();
    expect(text(first)).toBe("Started the build in the background.");

    sdk.state.finishBackground();
    await Promise.race([
        wake,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("The agent was never woken.")), 5_000),
        ),
    ]);
    // Agent Base delivers the notice as a hidden system message, which starts the next run.
    expect(notices).toHaveLength(1);
    messages.push(notices[0]!);
    const second = await run();

    expect(text(second)).toBe("The build finished.");
    expect(second.at(-1)).toMatchObject({ type: "done", state: "normal", endTurn: true });
    expect(sdk.state.interrupts).toBe(0);
}, 30_000);
