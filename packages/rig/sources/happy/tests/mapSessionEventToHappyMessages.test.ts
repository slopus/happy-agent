import { describe, expect, it } from "vitest";

import type { SessionEvent } from "../../protocol/index.js";
import { HappyMessageMapper } from "../mapSessionEventToHappyMessages.js";

describe("HappyMessageMapper", () => {
    it("keeps transient provider blocks out of the durable Happy outbox", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("agent_event", {
            event: {
                content: "Hello from Rig",
                contentIndex: 0,
                partial: { blocks: [], id: "agent-1", role: "agent" },
                type: "text_end",
            },
            runId: "run-1",
        });

        expect(mapper.map(event)).toEqual([]);
    });

    it("maps the durable final message to the same ids used by streaming recovery", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("agent_message", {
            message: {
                blocks: [
                    { text: "Hello from Rig", type: "text" },
                    { thinking: "Reasoning", type: "thinking" },
                    {
                        arguments: { path: "README.md" },
                        id: "call-1",
                        name: "Read",
                        presentation: {
                            type: "exploration",
                            operations: [{ kind: "read", name: "README.md" }],
                        },
                        type: "tool_call",
                    },
                ],
                id: "agent-1",
                role: "agent",
            },
            runId: "run-1",
        });

        const messages = mapper.map(event);

        expect(messages.map((message) => message.content.id)).toEqual([
            "agent-1:text:0",
            "agent-1:thinking:1",
            "agent-1:tool:call-1:start",
        ]);
        expect(messages.every((message) => message.content.turn === "run-1")).toBe(false);
        expect(messages.every((message) => message.content.turn === "agent-1")).toBe(true);
        expect(messages[2]?.content.ev).toMatchObject({
            presentation: {
                type: "exploration",
                operations: [{ kind: "read", name: "README.md" }],
            },
        });
    });

    it("does not echo a mobile-origin user message back into Happy", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("message_submitted", {
            displayText: "from phone",
            message: {
                blocks: [{ text: "from phone", type: "text" }],
                id: "happy:message-4",
                role: "user",
            },
            runId: "run-1",
        });

        expect(mapper.map(event)).toEqual([]);
    });

    it("maps a Bash call as the concrete command even when its result failed", () => {
        const mapper = new HappyMessageMapper();
        const event = sessionEvent("agent_message", {
            message: {
                blocks: [
                    {
                        arguments: { command: "pnpm test" },
                        id: "call-bash",
                        name: "Bash",
                        presentation: {
                            command: "pnpm test",
                            type: "exec_command",
                        },
                        type: "tool_call",
                    },
                    {
                        display: "Command exited with code 1.",
                        isError: true,
                        rendered: [{ text: "Command exited with code 1.", type: "text" }],
                        toolCallId: "call-bash",
                        toolName: "Bash",
                        type: "tool_result",
                    },
                ],
                id: "agent-1",
                role: "agent",
            },
            runId: "run-1",
        });

        expect(mapper.map(event)[0]?.content.ev).toMatchObject({
            call: "call-bash",
            name: "Bash",
            presentation: {
                command: "pnpm test",
                type: "exec_command",
            },
            t: "tool-call-start",
        });
    });

    it("keeps every inference iteration in one group across a tool call", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [
                                {
                                    arguments: { command: "pnpm test" },
                                    id: "call-1",
                                    name: "Bash",
                                    type: "tool_call",
                                },
                            ],
                            id: "agent-1",
                            role: "agent",
                        },
                        runId: "run-1",
                    },
                    110,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            result: {
                                isError: false,
                                toolCallId: "call-1",
                                toolName: "Bash",
                            },
                            type: "tool_execution_end",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    130,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [{ text: "Done.", type: "text" }],
                            id: "agent-2",
                            role: "agent",
                        },
                        runId: "run-1",
                    },
                    140,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    { modelLocked: false, runId: "run-1", stopReason: "stop" },
                    150,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "tool-call-start",
            "tool-call-end",
            "text",
            "turn-end",
        ]);
        expect(output.every((message) => message.content.turn === "agent-1")).toBe(true);
        expect(output.at(-1)?.content.ev).toMatchObject({
            elapsedMs: 50,
            reason: "completed",
            status: "completed",
        });
    });

    it("emits retried and terminal failures as the same event kind inside the group", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90));
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            attempt: 1,
                            blocks: [{ text: "The provider connection was lost.", type: "text" }],
                            id: "retry-1",
                            outcome: "retried",
                            role: "error",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [{ text: "The provider remained unavailable.", type: "text" }],
                            id: "failure-1",
                            outcome: "failed",
                            role: "error",
                        },
                        runId: "run-1",
                    },
                    149,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    {
                        errorMessage: "The provider remained unavailable.",
                        modelLocked: false,
                        runId: "run-1",
                        stopReason: "error",
                    },
                    150,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "failure",
            "failure",
            "turn-end",
        ]);
        expect(output.every((message) => message.content.turn === "agent-1")).toBe(true);
        expect(output[1]?.content.ev).toEqual({
            attempt: 1,
            outcome: "retried",
            reason: "The provider connection was lost.",
            t: "failure",
        });
        expect(output[2]?.content.ev).toEqual({
            outcome: "failed",
            reason: "The provider remained unavailable.",
            t: "failure",
        });
    });

    it("serializes continued chat errors through Happy's established service event", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90));
        const output = mapper.map(
            sessionEvent(
                "agent_message",
                {
                    message: {
                        blocks: [
                            {
                                text: "Automatic permission review refused deployment.",
                                type: "text",
                            },
                        ],
                        context: "excluded",
                        id: "permission-denial-1",
                        outcome: "continued",
                        role: "error",
                    },
                    runId: "run-1",
                },
                100,
            ),
        );

        expect(output.at(-1)?.content.ev).toEqual({
            t: "service",
            text: "Automatic permission review refused deployment.",
        });
    });

    it("does not duplicate a terminal failure when its durable message arrives late", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90)),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    {
                        errorMessage: "Provider unavailable.",
                        modelLocked: false,
                        runId: "run-1",
                        stopReason: "error",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [{ text: "Provider unavailable.", type: "text" }],
                            id: "failure-1",
                            outcome: "failed",
                            role: "error",
                        },
                        runId: "run-1",
                    },
                    110,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "failure",
            "turn-end",
        ]);
    });

    it("reports a run error that happens before the first inference", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(sessionEvent("run_started", { runId: "run-1" }, 100)),
            ...mapper.map(
                sessionEvent(
                    "run_error",
                    {
                        errorMessage: "MCP initialization failed.",
                        modelLocked: false,
                        runId: "run-1",
                    },
                    130,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual(["failure", "turn-end"]);
        expect(output.every((message) => message.content.turn === "run-1")).toBe(true);
        expect(output[0]?.content.ev).toEqual({
            outcome: "failed",
            reason: "MCP initialization failed.",
            t: "failure",
        });
        expect(output[1]?.content.ev).toEqual({
            elapsedMs: 30,
            reason: "error",
            status: "failed",
            t: "turn-end",
            turnElapsedMs: 30,
        });
    });

    it("reports a failed run finish that happens before the first inference", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(sessionEvent("run_started", { runId: "run-1" }, 100)),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    {
                        errorMessage: "Runtime initialization failed.",
                        modelLocked: false,
                        runId: "run-1",
                        stopReason: "error",
                    },
                    130,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual(["failure", "turn-end"]);
        expect(output.every((message) => message.content.turn === "run-1")).toBe(true);
        expect(output[0]?.content.ev).toEqual({
            outcome: "failed",
            reason: "Runtime initialization failed.",
            t: "failure",
        });
        expect(output[1]?.content.ev).toEqual({
            elapsedMs: 30,
            reason: "error",
            status: "failed",
            t: "turn-end",
            turnElapsedMs: 30,
        });
    });

    it("closes the current group at compaction before the next inference group", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            compactionId: "compaction-1",
                            estimatedTokensBefore: 100,
                            reason: "threshold",
                            type: "context_compaction_started",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            compactedMessageCount: 5,
                            compactionId: "compaction-1",
                            elapsedMs: 5,
                            estimatedTokensAfter: 40,
                            estimatedTokensBefore: 100,
                            reason: "threshold",
                            type: "context_compacted",
                        },
                        runId: "run-1",
                    },
                    125,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    130,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "turn-end",
            "service",
            "turn-start",
        ]);
        expect(output[1]?.content.ev).toMatchObject({
            elapsedMs: 20,
            reason: "compaction",
            status: "completed",
        });
        expect(output[2]?.content).toMatchObject({
            ev: { t: "service", text: "Context compacted." },
            turn: "agent-2",
        });
        expect(output[3]?.content.turn).toBe("agent-2");
    });

    it("emits an empty group start, then closes steering before its messages and next group", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Original question",
                    message: {
                        blocks: [{ text: "Original question", type: "text" }],
                        id: "user-1",
                        role: "user",
                    },
                    runId: "run-1",
                },
                80,
            ),
        );
        mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90));
        const output = [
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "steer",
                        displayText: "First",
                        message: {
                            blocks: [{ text: "First", type: "text" }],
                            id: "steer-1",
                            role: "user",
                        },
                        runId: "run-1",
                    },
                    110,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "steer",
                        displayText: "Second",
                        message: {
                            blocks: [{ text: "Second", type: "text" }],
                            id: "steer-2",
                            role: "user",
                        },
                        runId: "run-1",
                    },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "steering_applied",
                    { messageIds: ["steer-1", "steer-2"], runId: "run-1" },
                    150,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    160,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    { modelLocked: false, runId: "run-1", stopReason: "stop" },
                    200,
                ),
            ),
        ];

        expect(output.map((message) => message.content.ev.t)).toEqual([
            "turn-start",
            "turn-end",
            "text",
            "text",
            "turn-start",
            "turn-end",
        ]);
        expect(output[1]?.content.ev).toMatchObject({
            elapsedMs: 50,
            reason: "steering",
            turnElapsedMs: 70,
        });
        expect(output.slice(1, 4).map((message) => message.content.id)).toEqual([
            "group:agent-1:end",
            "steer-1",
            "steer-2",
        ]);
        expect(output.slice(2, 4).map((message) => message.content.turn)).toEqual([
            "agent-2",
            "agent-2",
        ]);
        expect(output[5]?.content.ev).toMatchObject({
            elapsedMs: 50,
            reason: "completed",
            turnElapsedMs: 120,
        });
    });

    it("keeps agent-authored steering notifications inside agent work", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "run",
                        displayText: "Analyze the project",
                        message: {
                            blocks: [{ text: "Analyze the project", type: "text" }],
                            id: "user-1",
                            role: "user",
                        },
                        runId: "run-1",
                    },
                    80,
                ),
            ),
            ...mapper.map(sessionEvent("run_started", { runId: "run-1" }, 90)),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-1",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    100,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "steer",
                        displayText: 'Background work "Quality" completed.',
                        message: {
                            blocks: [
                                {
                                    text: 'Background work "Quality" completed.',
                                    type: "text",
                                },
                            ],
                            id: "notification-1",
                            provenance: "agent",
                            role: "user",
                        },
                        runId: "run-1",
                        source: "notification",
                    },
                    110,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "steering_applied",
                    { messageIds: ["notification-1"], runId: "run-1" },
                    120,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 2,
                            messageId: "agent-2",
                            type: "inference_iteration_start",
                        },
                        runId: "run-1",
                    },
                    130,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "agent_message",
                    {
                        message: {
                            blocks: [{ text: "Final answer", type: "text" }],
                            id: "agent-final",
                            role: "agent",
                        },
                        runId: "run-1",
                    },
                    140,
                ),
            ),
            ...mapper.map(
                sessionEvent(
                    "run_finished",
                    { modelLocked: false, runId: "run-1", stopReason: "stop" },
                    150,
                ),
            ),
        ];

        const notification = output.find((message) => message.content.id === "notification-1");
        expect(notification?.content).toMatchObject({
            role: "agent",
            turn: "agent-2",
            ev: {
                t: "service",
                text: 'Background work "Quality" completed.',
            },
        });
    });

    it("starts agent-authored notification runs inside agent work", () => {
        const mapper = new HappyMessageMapper();
        const output = [
            ...mapper.map(
                sessionEvent(
                    "message_submitted",
                    {
                        delivery: "run",
                        displayText: 'Background work "Security review" completed.',
                        message: {
                            blocks: [
                                {
                                    text: 'Background work "Security review" completed.',
                                    type: "text",
                                },
                            ],
                            id: "notification-run-1",
                            provenance: "agent",
                            role: "user",
                        },
                        runId: "run-2",
                        source: "notification",
                    },
                    200,
                ),
            ),
            ...mapper.map(sessionEvent("run_started", { runId: "run-2" }, 210)),
            ...mapper.map(
                sessionEvent(
                    "agent_event",
                    {
                        event: {
                            iteration: 1,
                            messageId: "agent-notification-response",
                            type: "inference_iteration_start",
                        },
                        runId: "run-2",
                    },
                    220,
                ),
            ),
        ];

        expect(output.map((message) => message.content)).toEqual([
            expect.objectContaining({
                role: "agent",
                turn: "agent-notification-response",
                ev: {
                    t: "service",
                    text: 'Background work "Security review" completed.',
                },
            }),
            expect.objectContaining({
                role: "agent",
                turn: "agent-notification-response",
                ev: { t: "turn-start" },
            }),
        ]);
    });

    it("delivers an agent-authored notification into agent work that already started", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "message_submitted",
                {
                    delivery: "run",
                    displayText: "Analyze the project",
                    message: {
                        blocks: [{ text: "Analyze the project", type: "text" }],
                        id: "user-1",
                        role: "user",
                    },
                    runId: "run-3",
                },
                300,
            ),
        );
        mapper.map(
            sessionEvent(
                "agent_event",
                {
                    event: {
                        iteration: 1,
                        messageId: "agent-3",
                        type: "inference_iteration_start",
                    },
                    runId: "run-3",
                },
                310,
            ),
        );

        const notified = mapper.map(
            sessionEvent(
                "message_submitted",
                {
                    delivery: "run",
                    displayText: 'Background work "Docs" completed.',
                    message: {
                        blocks: [{ text: 'Background work "Docs" completed.', type: "text" }],
                        id: "notification-3",
                        provenance: "agent",
                        role: "user",
                    },
                    runId: "run-3",
                    source: "notification",
                },
                320,
            ),
        );

        expect(notified.map((message) => message.content)).toEqual([
            expect.objectContaining({
                ev: { t: "service", text: 'Background work "Docs" completed.' },
                id: "notification-3",
                role: "agent",
                turn: "agent-3",
            }),
        ]);
    });

    it("delivers an agent-authored notification when the run ends before the next iteration", () => {
        const mapper = new HappyMessageMapper();
        const buffered = mapper.map(
            sessionEvent(
                "message_submitted",
                {
                    delivery: "run",
                    displayText: 'Background work "Docs" completed.',
                    message: {
                        blocks: [{ text: 'Background work "Docs" completed.', type: "text" }],
                        id: "notification-4",
                        provenance: "agent",
                        role: "user",
                    },
                    runId: "run-4",
                    source: "notification",
                },
                400,
            ),
        );
        mapper.map(sessionEvent("run_started", { runId: "run-4" }, 410));

        const finished = mapper.map(
            sessionEvent(
                "run_finished",
                { modelLocked: false, runId: "run-4", stopReason: "stop" },
                420,
            ),
        );

        expect(buffered).toEqual([]);
        expect(finished.map((message) => message.content)).toEqual([
            expect.objectContaining({
                ev: { t: "service", text: 'Background work "Docs" completed.' },
                id: "notification-4",
                role: "agent",
                turn: "run-4",
            }),
        ]);
        expect(
            mapper
                .map(
                    sessionEvent(
                        "agent_event",
                        {
                            event: {
                                iteration: 1,
                                messageId: "agent-4",
                                type: "inference_iteration_start",
                            },
                            runId: "run-4",
                        },
                        430,
                    ),
                )
                .map((message) => message.content.ev),
        ).toEqual([{ t: "turn-start" }]);
    });

    it("delivers an agent-authored notification when the run is aborted", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "message_submitted",
                {
                    delivery: "run",
                    displayText: 'Background work "Docs" completed.',
                    message: {
                        blocks: [{ text: 'Background work "Docs" completed.', type: "text" }],
                        id: "notification-5",
                        provenance: "agent",
                        role: "user",
                    },
                    runId: "run-5",
                    source: "notification",
                },
                500,
            ),
        );

        expect(
            mapper
                .map(sessionEvent("abort_requested", { runId: "run-5" }, 510))
                .map((message) => message.content),
        ).toEqual([
            expect.objectContaining({
                ev: { t: "service", text: 'Background work "Docs" completed.' },
                id: "notification-5",
                turn: "run-5",
            }),
        ]);
    });

    it("does not stop a group for the technical abort that continues steering", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "agent_event",
                {
                    event: {
                        iteration: 1,
                        messageId: "agent-1",
                        type: "inference_iteration_start",
                    },
                    runId: "run-1",
                },
                100,
            ),
        );

        expect(
            mapper.map(
                sessionEvent(
                    "abort_requested",
                    { continuePendingSteering: true, runId: "run-1" },
                    120,
                ),
            ),
        ).toEqual([]);
        expect(
            mapper
                .map(
                    sessionEvent(
                        "steering_applied",
                        { messageIds: ["steer-1"], runId: "run-1" },
                        130,
                    ),
                )
                .map((message) => message.content.ev),
        ).toEqual([expect.objectContaining({ reason: "steering", t: "turn-end" })]);
    });

    it("does not emit a second end when hard run completion follows abort", () => {
        const mapper = new HappyMessageMapper();
        mapper.map(
            sessionEvent(
                "agent_event",
                {
                    event: {
                        iteration: 1,
                        messageId: "agent-1",
                        type: "inference_iteration_start",
                    },
                    runId: "run-1",
                },
                100,
            ),
        );
        const aborted = mapper.map(sessionEvent("abort_requested", { runId: "run-1" }, 120));
        const finished = mapper.map(
            sessionEvent(
                "run_finished",
                { modelLocked: false, runId: "run-1", stopReason: "aborted" },
                130,
            ),
        );

        expect(aborted.map((message) => message.content.ev)).toEqual([
            expect.objectContaining({ reason: "abort", status: "cancelled", t: "turn-end" }),
        ]);
        expect(finished).toEqual([]);
    });
});

function sessionEvent(type: SessionEvent["type"], data: unknown, createdAt = 123): SessionEvent {
    return {
        createdAt,
        data,
        id: `event-${String(createdAt)}`,
        sessionId: "session-1",
        type,
    } as SessionEvent;
}
