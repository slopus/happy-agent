import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, withLifetime } from "@steve.kite/stdlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { AcpProvider } from "@/protocol/acp/AcpProvider.js";
import type { AcpSession } from "@/protocol/acp/AcpSession.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

/**
 * Claude Code's own stream as the Agent SDK delivers it, measured on SDK 0.3.321 with Claude Code
 * 2.1.321: `system/background_tasks_changed` lists every live background task whenever that set
 * changes — a background command and a subagent join it while the turn that started them runs,
 * and leave it as they finish, after that turn's result. `script` picks how a query goes on after
 * the tasks start: they finish one by one (`finish`), the Claude Code process ends with them
 * (`exit`), or the turn never reaches its result until it is stopped from outside (`hold`).
 */
const sdk = vi.hoisted(() => {
    const state = {
        script: "finish" as "finish" | "exit" | "hold",
        finish: (): void => undefined,
        closed: 0,
        ended: false,
    };
    const shell = {
        task_id: "bv74hfa93",
        task_type: "local_bash",
        description: "Sleep 25 seconds then echo shell-done",
    };
    const subagent = {
        task_id: "a6d24fa32a569f3ce",
        task_type: "local_agent",
        subagent_type: "general-purpose",
        description: "Background sleep probe",
    };
    const watcher = {
        task_id: "w4kq0d2",
        task_type: "monitor_mcp",
        description: "Watch the session's files",
        ambient: true,
    };
    const changed = (tasks: readonly object[]) => ({
        type: "system",
        subtype: "background_tasks_changed",
        tasks,
    });
    function query(params: { prompt: AsyncIterable<unknown> }) {
        const script = state.script;
        async function* messages() {
            const input = params.prompt[Symbol.asyncIterator]();
            await input.next();
            yield { type: "system", subtype: "init" };
            yield {
                type: "stream_event",
                parent_tool_use_id: null,
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "started" },
                },
            };
            yield changed([shell]);
            yield changed([shell, subagent, watcher]);
            if (script === "hold") await new Promise<void>(() => undefined);
            yield {
                type: "result",
                subtype: "success",
                is_error: false,
                result: "started",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                },
            };
            if (script === "exit") return;
            await new Promise<void>((resolve) => (state.finish = resolve));
            yield changed([subagent, watcher]);
            yield changed([subagent, watcher]);
            yield changed([watcher]);
            await input.next();
            state.ended = true;
        }
        const iterator = messages();
        return Object.assign(iterator, {
            supportedModels: async () => [],
            setModel: async () => undefined,
            applyFlagSettings: async () => undefined,
            setPermissionMode: async () => undefined,
            interrupt: async () => undefined,
            close: () => {
                state.closed++;
            },
        });
    }
    return { state, query };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

const open: AcpSession[] = [];
beforeEach(() => {
    sdk.state.script = "finish";
    sdk.state.closed = 0;
    sdk.state.ended = false;
});
afterEach(() => {
    for (const session of open.splice(0)) session.destroy();
});

const userMessage = (text: string): SessionMessage => ({
    role: "user",
    content: [{ type: "text", text }],
});

/** A Claude Code session whose turn environment records each background-work report. */
async function sessionReporting(reports: number[]): Promise<{
    readonly session: AcpSession;
    readonly run: (messages?: SessionMessage[], lifetime?: AbortSignal) => Promise<SessionEvent[]>;
}> {
    const directory = mkdtempSync(join(tmpdir(), "claude-background-work-"));
    const provider = new AcpProvider({
        connect: claudeAgentConnect({}),
        stateDirectory: join(directory, "state"),
        environment: () => ({
            cwd: directory,
            permissionMode: "full_access",
            backgroundWork: (running: number) => reports.push(running),
        }),
    });
    const session = await provider.session("agent-1", { instructions: "Be Happy.", tools: [] });
    open.push(session);
    const conversation = [userMessage("Start both in the background.")];
    const run = async (
        messages: SessionMessage[] = conversation,
        lifetime: AbortSignal = new AbortController().signal,
    ): Promise<SessionEvent[]> => {
        const events: SessionEvent[] = [];
        const ctx = withLifetime(createRootContext().named("test"), lifetime);
        for await (const event of session.run(ctx, {
            context: { instructions: "Be Happy.", messages },
        })) {
            events.push(event);
            if (event.type === "done") break;
        }
        return events;
    };
    return { session, run };
}

it("reports Claude Code's background tasks while they outlive the turn that started them", async () => {
    const reports: number[] = [];
    const { run } = await sessionReporting(reports);

    const turn = await run();
    expect(turn.at(-1)).toMatchObject({ type: "done", state: "normal", endTurn: true });
    // The command, then the command and the subagent; the ambient watcher is not counted.
    expect(reports).toEqual([1, 2]);

    sdk.state.finish();
    await vi.waitFor(() => expect(reports.at(-1)).toBe(0));
    // An unchanged set reports nothing new, and a set holding only ambient tasks is no work.
    expect(reports).toEqual([1, 2, 1, 0]);
}, 30_000);

it("reports no background work once the session that ran it is gone", async () => {
    const reports: number[] = [];
    const { session, run } = await sessionReporting(reports);

    await run();
    expect(reports).toEqual([1, 2]);

    // Closing the session ends the Claude Code process, and its background tasks with it.
    session.destroy();
    expect(reports).toEqual([1, 2, 0]);

    // Counts Claude Code sent before it ended still arrive, and change nothing.
    sdk.state.finish();
    await vi.waitFor(() => expect(sdk.state.ended).toBe(true));
    expect(reports).toEqual([1, 2, 0]);
}, 30_000);

it("reports no background work once Claude Code's process ends", async () => {
    sdk.state.script = "exit";
    const reports: number[] = [];
    const { run } = await sessionReporting(reports);

    await run();
    await vi.waitFor(() => expect(reports).toEqual([1, 2, 0]));
}, 30_000);

it("reports no background work once a turn is stopped, which ends Claude Code", async () => {
    sdk.state.script = "hold";
    const reports: number[] = [];
    const { run } = await sessionReporting(reports);
    const stop = new AbortController();

    const turn = run(undefined, stop.signal);
    await vi.waitFor(() => expect(reports).toEqual([1, 2]));
    stop.abort();

    expect((await turn).at(-1)).toMatchObject({ type: "done", state: "cancelled" });
    expect(reports).toEqual([1, 2, 0]);
}, 30_000);

it("ends a session the conversation moved away from, and stops counting its work", async () => {
    const reports: number[] = [];
    const { run } = await sessionReporting(reports);

    await run();
    expect(reports).toEqual([1, 2]);

    // A transcript the open session never saw makes the next run open a new Claude Code session.
    await run([userMessage("Something else entirely.")]);

    // The first session's process is closed rather than left running where nobody sees it, and
    // its count drops before the new session reports its own.
    expect(sdk.state.closed).toBe(1);
    expect(reports.slice(0, 3)).toEqual([1, 2, 0]);
}, 30_000);
