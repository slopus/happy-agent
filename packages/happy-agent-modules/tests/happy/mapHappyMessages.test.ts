import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../sources/events/index.js";
import type { HistoryMessage } from "../../sources/history/index.js";
import { HappyMessageMapper } from "../../sources/happy/index.js";
import type { HappySessionEvent } from "../../sources/happy/index.js";

const RUN = "run-1";

let ordinal = 0;

function event(type: string, payload: unknown, occurredAt = 1_000): AgentEvent {
    ordinal += 1;
    return {
        agentId: "agent-1",
        id: `01900000-0000-7000-8000-${String(ordinal).padStart(12, "0")}`,
        occurredAt,
        payload,
        type,
    };
}

function accepted(extra: Record<string, unknown> = {}): AgentEvent {
    return event("message.accepted", {
        id: `msg-${ordinal + 1}`,
        kind: "send",
        runId: RUN,
        ...extra,
    });
}

function historyMessage(text: string, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
    return {
        at: 1_000,
        blocks: [{ text, type: "text" }],
        recordId: `msg-${ordinal}`,
        role: "user",
        runId: RUN,
        ...overrides,
    };
}

function blockStart(occurredAt = 1_000): AgentEvent {
    return event("provider.event", { event: { type: "block_start" }, runId: RUN }, occurredAt);
}

function settled(payload: Record<string, unknown> = {}, occurredAt = 2_000): AgentEvent {
    return event(
        "loop.settled",
        { runId: RUN, settlementId: "s1", stopReason: "stop", ...payload },
        occurredAt,
    );
}

function events(mapper: HappyMessageMapper, ...input: AgentEvent[]): HappySessionEvent[] {
    return input.flatMap((one) => mapper.map(one).map((message) => message.content.ev));
}

describe("Happy message mapping", () => {
    it("shows what the person said", () => {
        const mapper = new HappyMessageMapper();
        const messages = mapper.map(accepted(), historyMessage("build me a thing"));
        expect(messages).toHaveLength(1);
        expect(messages[0]?.content.role).toBe("user");
        expect(messages[0]?.content.ev).toEqual({ t: "text", text: "build me a thing" });
        expect(messages[0]?.meta).toEqual({ sentFrom: "rig" });
        expect(messages[0]?.localId).toBe(`rig:${messages[0]?.content.id ?? ""}`);
    });

    it("stays silent about a message that came from the phone", () => {
        const mapper = new HappyMessageMapper();
        const echo = accepted();
        expect(
            mapper.map(echo, historyMessage("sent from Happy", { remoteMessageId: "remote-1" })),
        ).toEqual([]);
    });

    it("stays silent about a message meant to stay out of sight", () => {
        const mapper = new HappyMessageMapper();
        expect(mapper.map(accepted(), historyMessage("internal", { hideFromUser: true }))).toEqual(
            [],
        );
    });

    it("stays silent until the accepted message is available in History", () => {
        const mapper = new HappyMessageMapper();
        expect(mapper.map(accepted())).toEqual([]);
    });

    it("speaks for the runtime in its own voice", () => {
        const mapper = new HappyMessageMapper();
        const notice = event("message.accepted", {
            id: "msg-system",
            kind: "send",
            runId: RUN,
        });
        const messages = mapper.map(
            notice,
            historyMessage("A process died.", { recordId: "msg-system", role: "system" }),
        );
        expect(messages[0]?.content.role).toBe("agent");
        expect(messages[0]?.content.ev).toEqual({ t: "service", text: "A process died." });
    });

    it("opens a turn once, however many responses it takes", () => {
        const mapper = new HappyMessageMapper();
        const opened = events(mapper, blockStart(), blockStart(1_100));
        expect(opened).toEqual([{ t: "turn-start" }]);
    });

    it("carries text and thinking with the turn they belong to", () => {
        const mapper = new HappyMessageMapper();
        const start = mapper.map(blockStart());
        const turnId = start[0]?.content.turn;
        expect(turnId).toBeTypeOf("string");

        const spoken = mapper.map(
            event("provider.event", {
                event: { type: "text_end" },
                rigEvent: { content: "Here you go.", type: "text_end" },
                runId: RUN,
            }),
        );
        expect(spoken[0]?.content.ev).toEqual({ t: "text", text: "Here you go." });
        expect(spoken[0]?.content.turn).toBe(turnId);

        const thought = mapper.map(
            event("provider.event", {
                event: { type: "reasoning_end" },
                rigEvent: { content: "Let me think.", type: "reasoning_end" },
                runId: RUN,
            }),
        );
        expect(thought[0]?.content.ev).toEqual({
            t: "text",
            text: "Let me think.",
            thinking: true,
        });
    });

    it("says nothing for an empty response", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());
        const spoken = mapper.map(
            event("provider.event", {
                event: { type: "text_end" },
                rigEvent: { content: "", type: "text_end" },
                runId: RUN,
            }),
        );
        expect(spoken).toEqual([]);
    });

    it("names a tool the way a person reads it", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());
        const started = mapper.map(
            event("tool.started", {
                rigEvent: {
                    toolCall: {
                        arguments: { path: "README.md" },
                        id: "call-1",
                        name: "read_file",
                        type: "toolCall",
                    },
                    type: "tool_execution_start",
                },
                runId: RUN,
            }),
        );
        expect(started[0]?.content.ev).toEqual({
            args: { path: "README.md" },
            call: "call-1",
            description: "Running Read File",
            name: "read_file",
            t: "tool-call-start",
            title: "Read File",
        });

        const finished = mapper.map(
            event("tool.completed", {
                callId: "call-1",
                rigEvent: {
                    result: { display: "ok", toolCallId: "call-1", type: "tool_result" },
                    type: "tool_execution_end",
                },
                runId: RUN,
            }),
        );
        expect(finished[0]?.content.ev).toEqual({
            call: "call-1",
            result: "ok",
            t: "tool-call-end",
        });
    });

    it("presents Happy Agent coordination tools in the terms a person needs", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());

        const calls = [
            {
                arguments: { input: { name: "Security review", script: "{'ok': True}" } },
                id: "workflow-1",
                name: "run_workflow",
            },
            {
                arguments: { text: "Check the authentication path.", toAgentId: "agent42" },
                id: "message-1",
                name: "send_agent_message",
            },
            {
                arguments: { targetAgentId: "agent42" },
                id: "interrupt-1",
                name: "interrupt_agent",
            },
        ];

        const presented = calls.map(
            (toolCall) =>
                mapper.map(
                    event("tool.started", {
                        rigEvent: {
                            toolCall: { ...toolCall, type: "toolCall" },
                            type: "tool_execution_start",
                        },
                        runId: RUN,
                    }),
                )[0]?.content.ev,
        );

        expect(presented).toEqual([
            {
                args: calls[0]?.arguments,
                call: "workflow-1",
                description: "Starting workflow Security review",
                name: "run_workflow",
                t: "tool-call-start",
                title: "Run Workflow",
            },
            {
                args: calls[1]?.arguments,
                call: "message-1",
                description: "Sending a message to agent42",
                name: "send_agent_message",
                t: "tool-call-start",
                title: "Send Agent Message",
            },
            {
                args: calls[2]?.arguments,
                call: "interrupt-1",
                description: "Interrupting agent42",
                name: "interrupt_agent",
                t: "tool-call-start",
                title: "Interrupt Agent",
            },
        ]);
    });

    it("normalizes apply_patch into Happy's Codex patch tool shape", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());
        const patch = [
            "*** Begin Patch",
            "*** Add File: sources/new.ts",
            "+export const answer = 42;",
            "*** Update File: sources/old.ts",
            "*** Move to: sources/moved.ts",
            "@@ export function answer()",
            "-    return 41;",
            "+    return 42;",
            "*** Delete File: sources/unused.ts",
            "*** End Patch",
        ].join("\n");

        const started = mapper.map(
            event("tool.started", {
                rigEvent: {
                    toolCall: {
                        arguments: { patch, workdir: "packages/mobile" },
                        id: "patch-1",
                        name: "apply_patch",
                        type: "toolCall",
                    },
                    type: "tool_execution_start",
                },
                runId: RUN,
            }),
        );

        expect(started[0]?.content.ev).toEqual({
            args: {
                changes: {
                    "packages/mobile/sources/old.ts": {
                        diff: [
                            "@@ -1,1 +1,1 @@ export function answer()",
                            "-    return 41;",
                            "+    return 42;",
                        ].join("\n"),
                        kind: {
                            move_path: "packages/mobile/sources/moved.ts",
                            type: "update",
                        },
                    },
                    "packages/mobile/sources/new.ts": {
                        add: { content: "export const answer = 42;" },
                        kind: { move_path: null, type: "add" },
                    },
                    "packages/mobile/sources/unused.ts": {
                        kind: { move_path: null, type: "delete" },
                    },
                },
            },
            call: "patch-1",
            description: "Applying patch to 3 files",
            name: "CodexPatch",
            t: "tool-call-start",
            title: "Apply patch",
        });
    });

    it("keeps malformed apply_patch calls on Happy's generic tool fallback", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());

        const started = mapper.map(
            event("tool.started", {
                rigEvent: {
                    toolCall: {
                        arguments: { patch: "not a Codex patch" },
                        id: "patch-bad",
                        name: "apply_patch",
                        type: "toolCall",
                    },
                    type: "tool_execution_start",
                },
                runId: RUN,
            }),
        );

        expect(started[0]?.content.ev).toMatchObject({
            args: { patch: "not a Codex patch" },
            name: "apply_patch",
            title: "Apply Patch",
        });
    });

    it("tells Happy when a tool failed and what it reported", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());

        const finished = mapper.map(
            event("tool.completed", {
                callId: "call-failed",
                rigEvent: {
                    result: {
                        display: "The collaborator could not be interrupted.",
                        isError: true,
                        toolCallId: "call-failed",
                        type: "tool_result",
                    },
                    type: "tool_execution_end",
                },
                runId: RUN,
            }),
        );

        expect(finished[0]?.content.ev).toEqual({
            call: "call-failed",
            isError: true,
            result: "The collaborator could not be interrupted.",
            t: "tool-call-end",
        });
    });

    it("reports a tool the provider ran on its own side", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());
        const started = mapper.map(
            event("provider.event", {
                event: { callId: "server-1", type: "toolcall_result_start" },
                rigEvent: {
                    toolCall: { arguments: {}, id: "server-1", name: "web_search" },
                    type: "tool_execution_start",
                },
                runId: RUN,
            }),
        );
        expect(started[0]?.content.ev).toMatchObject({
            call: "server-1",
            t: "tool-call-start",
            title: "Web Search",
        });
    });

    it("reports a retry as it happens, without ending the turn", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart());
        const retried = mapper.map(
            event("provider.event", {
                event: { attempt: 2, reason: "The provider was overloaded.", type: "retrying" },
                runId: RUN,
            }),
        );
        expect(retried[0]?.content.ev).toEqual({
            t: "service",
            text: "Retrying after an error (attempt 2): The provider was overloaded.",
        });
    });

    it("ends the turn with how long it took and what it cost", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(event("loop.started", { loopId: "loop-1", runId: RUN }, 900));
        mapper.map(blockStart(1_000));
        mapper.map(
            event("inference.completed", {
                inferenceId: "i1",
                runId: RUN,
                state: "normal",
                tokens: { input: 100, output: 20 },
            }),
        );
        mapper.map(
            event("inference.completed", {
                inferenceId: "i2",
                runId: RUN,
                state: "normal",
                tokens: { input: 150, output: 30 },
            }),
        );
        const ended = mapper.map(settled({}, 2_000));
        expect(ended).toHaveLength(1);
        expect(ended[0]?.content.ev).toEqual({
            elapsedMs: 1_000,
            reason: "completed",
            status: "completed",
            t: "turn-end",
            turnElapsedMs: 1_100,
        });
        // The whole run's cost, not just the last response in it.
        expect(ended[0]?.content.usage).toEqual({ input_tokens: 250, output_tokens: 50 });
    });

    it("tells the phone why a run failed", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart(1_000));
        const ended = mapper.map(
            settled({ error: "The provider refused the request.", stopReason: "error" }, 1_500),
        );
        expect(ended[0]?.content.ev).toEqual({
            t: "service",
            text: "The run failed: The provider refused the request.",
        });
        expect(ended[1]?.content.ev).toMatchObject({
            reason: "error",
            status: "failed",
            t: "turn-end",
        });
    });

    it("shows an interrupted run as cancelled", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart(1_000));
        const ended = mapper.map(settled({ stopReason: "aborted" }, 1_200));
        expect(ended[0]?.content.ev).toMatchObject({
            reason: "abort",
            status: "cancelled",
            t: "turn-end",
        });
    });

    it("closes the turn when the person interrupts, and opens a new one after", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(blockStart(1_000));
        const steered = mapper.map(
            event(
                "message.accepted",
                {
                    id: "msg-steer",
                    kind: "steering",
                    runId: RUN,
                },
                1_400,
            ),
            historyMessage("wait, stop", { at: 1_400, recordId: "msg-steer" }),
        );
        expect(steered.map((message) => message.content.ev)).toEqual([
            {
                elapsedMs: 400,
                reason: "steering",
                status: "completed",
                t: "turn-end",
                turnElapsedMs: 400,
            },
            { t: "text", text: "wait, stop" },
        ]);

        const reopened = mapper.map(blockStart(1_500));
        expect(reopened[0]?.content.ev).toEqual({ t: "turn-start" });
    });

    it("ignores a stream Happy Agent replayed to repair itself", () => {
        const mapper = new HappyMessageMapper();
        const recovered = mapper.map(
            event("provider.event", {
                event: { type: "block_reset" },
                recovered: true,
                runId: RUN,
            }),
        );
        expect(recovered).toEqual([]);
    });

    it("shows the same event only once", () => {
        const mapper = new HappyMessageMapper();
        const message = accepted();
        const archived = historyMessage("hello");
        expect(mapper.map(message, archived)).toHaveLength(1);
        expect(mapper.map(message, archived)).toEqual([]);
    });

    it("says nothing about the journal's own bookkeeping", () => {
        const mapper = new HappyMessageMapper();
        expect(
            events(
                mapper,
                event("agent.created", { id: "agent-1" }),
                event("agent.permission-changed", { mode: "auto", previousMode: "read-only" }),
                event("agent.metadata-changed", { agentId: "agent-1", metadata: {} }),
                event("turn.completed", { aborted: false, runId: RUN, turnId: "t1" }),
            ),
        ).toEqual([]);
    });
});
