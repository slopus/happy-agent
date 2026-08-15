import { createTestRootContext } from "../testing/createTestRootContext.js";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../agent/Agent.js";
import { NativeProcessManager } from "../processes/index.js";
import { defineModel, defineProvider } from "@slopus/rig-execution";
import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { CodingAssistantApp } from "./CodingAssistantApp.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("CodingAssistantApp steering submit and Escape race", () => {
    it("waits for steering acceptance and coalesces rapid Escapes into one continuation", async () => {
        const acceptance = deferred<void>();
        const steer = vi.fn(() => acceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true, continued: true }));
        const { app } = createRaceApp({ abort, steer });

        submit(app, "Accept this direction before interrupting.");
        const messageId = steeringMessageId(steer);
        app.handleInput("\x1b");
        app.handleInput("\x1b");

        expect(steer).toHaveBeenCalledOnce();
        expect(steeringRunOptions(steer)).toMatchObject({ expectedRunId: "run-1" });
        expect(abort).not.toHaveBeenCalled();

        acceptance.resolve();

        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledWith({
            continuePendingSteering: true,
            expectedRunId: "run-1",
            steeringMessageIds: [messageId],
        });
    });

    it("waits for every rapid steering submission before continuing them in order once", async () => {
        const firstAcceptance = deferred<void>();
        const secondAcceptance = deferred<void>();
        const steer = vi
            .fn()
            .mockImplementationOnce(() => firstAcceptance.promise)
            .mockImplementationOnce(() => secondAcceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true, continued: true }));
        const { app } = createRaceApp({ abort, steer });

        submit(app, "First rapid direction.");
        submit(app, "Second rapid direction.");
        const messageIds = [steeringMessageId(steer, 0), steeringMessageId(steer, 1)];
        app.handleInput("\x1b");

        expect(steer.mock.calls.map(([content]) => content)).toEqual([
            "First rapid direction.",
            "Second rapid direction.",
        ]);

        secondAcceptance.resolve();
        await Promise.resolve();
        expect(abort).not.toHaveBeenCalled();

        firstAcceptance.resolve();
        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledWith({
            continuePendingSteering: true,
            expectedRunId: "run-1",
            steeringMessageIds: messageIds,
        });
    });

    it("restores rejected steering for one Escape to clear before the next stops", async () => {
        const acceptance = deferred<void>();
        const steer = vi.fn(() => acceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, steer });
        const rejected = "Retain this rejected direction.";

        submit(app, rejected);
        app.handleInput("\x1b");
        acceptance.reject(new Error("There is no active run to steer."));

        await app.waitForIdle();
        expect(abort).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n"))).toContain(`› ${rejected}`);

        app.handleInput("\x1b");
        expect(abort).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
        app.handleInput("\x1b");
        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledWith({ expectedRunId: "run-1" });
    });

    it("starts a new run when the previous run finishes before steering reaches the daemon", async () => {
        const firstRun = deferred<{
            contextMessages: [];
            messages: [];
            runId: string;
            stopReason: "stop";
        }>();
        const steer = vi.fn(async () => ({
            delivery: "run" as const,
            eventId: "queued-message",
            runId: "run-2",
            sessionId: "session-1",
        }));
        const send = vi.fn(() => firstRun.promise);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, send, startRun: false, steer });
        const text = "Use the configured token.";

        submit(app, "Finish the first run.");
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "first-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        submit(app, text);
        await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
        const messageId = steeringMessageId(steer);
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "run",
                displayText: text,
                message: {
                    blocks: [{ text, type: "text" }],
                    id: messageId,
                    role: "user",
                },
                runId: "run-2",
            },
            id: "queued-message",
            sessionId: "session-1",
            type: "message_submitted",
        });

        app.applySessionEvent({
            createdAt: 3,
            data: { modelLocked: true, runId: "run-1", stopReason: "stop" },
            id: "run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        app.applySessionEvent({
            createdAt: 4,
            data: { runId: "run-2" },
            id: "next-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.handleInput("\x1b");
        await vi.waitFor(() =>
            expect(abort).toHaveBeenCalledExactlyOnceWith({ expectedRunId: "run-2" }),
        );
        firstRun.resolve({
            contextMessages: [],
            messages: [],
            runId: "run-1",
            stopReason: "stop",
        });
        await app.waitForIdle();
        expect(stripAnsi(app.render(100).join("\n"))).toContain("esc to interrupt");

        app.applySessionEvent({
            createdAt: 5,
            data: { modelLocked: true, runId: "run-2", stopReason: "stop" },
            id: "next-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(send).toHaveBeenCalledOnce();
        expect(rendered.match(new RegExp(`› ${text}`, "gu"))).toHaveLength(1);
        expect(rendered).toContain("› Ask Rig to do anything");
        expect(rendered).not.toContain("There is no active run to steer");
        expect(rendered).not.toContain("The intended run is no longer active");
    });

    it.each(["finished", "errored"] as const)(
        "does not let a stale send settlement overwrite a newer run that already %s",
        async (newerOutcome) => {
            const firstRun = deferred<{
                contextMessages: [];
                messages: [];
                runId: string;
                stopReason: "aborted" | "stop";
            }>();
            const steer = vi.fn(async () => ({
                delivery: "run" as const,
                eventId: "queued-message",
                runId: "run-2",
                sessionId: "session-1",
            }));
            const send = vi.fn(() => firstRun.promise);
            const abort = vi.fn(async () => ({ aborted: true }));
            const { app } = createRaceApp({ abort, send, startRun: false, steer });
            const text = "Run after the completed response.";

            submit(app, "Finish the first run.");
            await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
            app.applySessionEvent({
                createdAt: 1,
                data: { runId: "run-1" },
                id: "first-run-started",
                sessionId: "session-1",
                type: "run_started",
            });
            submit(app, text);
            await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce());
            const messageId = steeringMessageId(steer);
            app.applySessionEvent({
                createdAt: 2,
                data: {
                    delivery: "run",
                    displayText: text,
                    message: {
                        blocks: [{ text, type: "text" }],
                        id: messageId,
                        role: "user",
                    },
                    runId: "run-2",
                },
                id: "queued-message",
                sessionId: "session-1",
                type: "message_submitted",
            });
            app.applySessionEvent({
                createdAt: 3,
                data: { modelLocked: true, runId: "run-1", stopReason: "stop" },
                id: "first-run-finished",
                sessionId: "session-1",
                type: "run_finished",
            });
            app.applySessionEvent({
                createdAt: 4,
                data: { runId: "run-2" },
                id: "next-run-started",
                sessionId: "session-1",
                type: "run_started",
            });
            app.applySessionEvent(
                newerOutcome === "finished"
                    ? {
                          createdAt: 5,
                          data: { modelLocked: true, runId: "run-2", stopReason: "stop" },
                          id: "next-run-finished",
                          sessionId: "session-1",
                          type: "run_finished",
                      }
                    : {
                          createdAt: 5,
                          data: {
                              errorMessage: "RUN_TWO_ERROR",
                              modelLocked: true,
                              runId: "run-2",
                          },
                          id: "next-run-error",
                          sessionId: "session-1",
                          type: "run_error",
                      },
            );

            if (newerOutcome === "finished") {
                firstRun.resolve({
                    contextMessages: [],
                    messages: [],
                    runId: "run-1",
                    stopReason: "aborted",
                });
            } else {
                firstRun.reject(new Error("STALE_RUN_ONE_ERROR"));
            }
            await app.waitForIdle();

            const rendered = stripAnsi(app.render(100).join("\n"));
            expect(rendered.match(new RegExp(`› ${text}`, "gu"))).toHaveLength(1);
            expect(rendered).not.toContain("STALE_RUN_ONE_ERROR");
            expect(rendered).not.toContain("Session interrupted");
            if (newerOutcome === "errored") {
                expect(rendered.match(/RUN_TWO_ERROR/gu)).toHaveLength(1);
            }
        },
    );

    it.each(["session_reset", "session_rewound"] as const)(
        "does not resurrect a steering interrupt after %s",
        async (boundaryType) => {
            const acceptance = deferred<void>();
            const steer = vi.fn(() => acceptance.promise);
            const abort = vi.fn(async () => ({ aborted: true, continued: true }));
            const { agent, app } = createRaceApp({ abort, steer });
            const text = "Discard this boundary-crossing direction.";

            submit(app, text);
            app.handleInput("\x1b");
            const messageId = steeringMessageId(steer);
            app.applySessionEvent({
                createdAt: 2,
                data: {
                    delivery: "steer",
                    displayText: text,
                    message: {
                        blocks: [{ text, type: "text" }],
                        id: messageId,
                        role: "user",
                    },
                    runId: "run-1",
                },
                id: "accepted-before-boundary",
                sessionId: "session-1",
                type: "message_submitted",
            });
            app.applySessionEvent(
                boundaryType === "session_reset"
                    ? {
                          createdAt: 3,
                          data: { snapshot: agent.snapshot(), transcript: emptyTranscript() },
                          id: "boundary",
                          sessionId: "session-1",
                          type: "session_reset",
                      }
                    : {
                          createdAt: 3,
                          data: {
                              messageId: "rewind-target",
                              snapshot: agent.snapshot(),
                              transcript: emptyTranscript(),
                          },
                          id: "boundary",
                          sessionId: "session-1",
                          type: "session_rewound",
                      },
            );
            acceptance.reject(new Error("STALE_BOUNDARY_REJECTION"));

            await app.waitForIdle();
            expect(abort).not.toHaveBeenCalled();
            const rendered = stripAnsi(app.render(100).join("\n"));
            expect(rendered).not.toContain("Discard this boundary-crossing direction.");
            expect(rendered).not.toContain("STALE_BOUNDARY_REJECTION");
        },
    );

    it("restores multiple accepted but unapplied submissions in FIFO order", async () => {
        const firstAcceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const secondAcceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const steer = vi
            .fn()
            .mockImplementationOnce(() => firstAcceptance.promise)
            .mockImplementationOnce(() => secondAcceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, steer });
        const messages = ["First accepted direction.", "Second accepted direction."];

        for (const message of messages) submit(app, message);
        const messageIds = steer.mock.calls.map((_, index) => steeringMessageId(steer, index));
        for (const [index, message] of messages.entries()) {
            app.applySessionEvent({
                createdAt: 2 + index,
                data: {
                    delivery: "steer",
                    displayText: message,
                    message: {
                        blocks: [{ text: message, type: "text" }],
                        id: messageIds[index] ?? "",
                        role: "user",
                    },
                    runId: "run-1",
                },
                id: `steering-submitted-${index}`,
                sessionId: "session-1",
                type: "message_submitted",
            });
        }
        app.applySessionEvent({
            createdAt: 4,
            data: { modelLocked: true, runId: "run-1", stopReason: "error" },
            id: "run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        secondAcceptance.resolve({
            eventId: "steering-submitted-1",
            runId: "run-1",
            sessionId: "session-1",
        });
        firstAcceptance.resolve({
            eventId: "steering-submitted-0",
            runId: "run-1",
            sessionId: "session-1",
        });

        await app.waitForIdle();
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered.indexOf(messages[0] ?? "")).toBeLessThan(
            rendered.indexOf(messages[1] ?? ""),
        );
        expect(rendered).not.toContain("Messages to be submitted after next tool call");
        expect(abort).not.toHaveBeenCalled();
    });

    it("discards accepted but unapplied steering after a hard abort", async () => {
        const acceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const steer = vi.fn(() => acceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, steer });
        const text = "Discard this aborted direction.";

        submit(app, text);
        const messageId = steeringMessageId(steer);
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: text,
                message: {
                    blocks: [{ text, type: "text" }],
                    id: messageId,
                    role: "user",
                },
                runId: "run-1",
            },
            id: "steering-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: { modelLocked: true, runId: "run-1", stopReason: "aborted" },
            id: "run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        acceptance.resolve({
            eventId: "steering-submitted",
            runId: "run-1",
            sessionId: "session-1",
        });

        await app.waitForIdle();
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("› Ask Rig to do anything");
        expect(rendered).not.toContain(`› ${text}`);
        expect(rendered).not.toContain("Messages to be submitted after next tool call");
    });

    it("continues accepted B after only concurrent A is applied", async () => {
        const firstAcceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const secondAcceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const steer = vi
            .fn()
            .mockImplementationOnce(() => firstAcceptance.promise)
            .mockImplementationOnce(() => secondAcceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true, continued: true }));
        const { app } = createRaceApp({ abort, steer });

        submit(app, "Concurrent A.");
        submit(app, "Concurrent B.");
        const firstId = steeringMessageId(steer, 0);
        const secondId = steeringMessageId(steer, 1);
        for (const [index, [id, text]] of (
            [
                [firstId, "Concurrent A."],
                [secondId, "Concurrent B."],
            ] as const
        ).entries()) {
            app.applySessionEvent({
                createdAt: 2 + index,
                data: {
                    delivery: "steer",
                    displayText: text,
                    message: { blocks: [{ text, type: "text" }], id, role: "user" },
                    runId: "run-1",
                },
                id: `accepted-${index}`,
                sessionId: "session-1",
                type: "message_submitted",
            });
        }
        secondAcceptance.resolve({
            eventId: "accepted-1",
            runId: "run-1",
            sessionId: "session-1",
        });
        await Promise.resolve();
        app.handleInput("\x1b");
        app.applySessionEvent({
            createdAt: 4,
            data: { messageIds: [firstId], runId: "run-1" },
            id: "applied-a",
            sessionId: "session-1",
            type: "steering_applied",
        });
        firstAcceptance.resolve({
            eventId: "accepted-0",
            runId: "run-1",
            sessionId: "session-1",
        });

        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledWith({
            continuePendingSteering: true,
            expectedRunId: "run-1",
            steeringMessageIds: [firstId, secondId],
        });
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).not.toContain("Concurrent A.\n  Concurrent A.");
        expect(rendered).toContain("Concurrent B.");
    });

    it("restores accepted but unapplied steering when its run ends", async () => {
        const acceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const steer = vi.fn(() => acceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true, continued: true }));
        const { app } = createRaceApp({ abort, steer });
        const text = "Restore steering from a finished run.";

        submit(app, text);
        app.handleInput("\x1b");
        const messageId = steeringMessageId(steer);
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: text,
                message: {
                    blocks: [{ text, type: "text" }],
                    id: messageId,
                    role: "user",
                },
                runId: "run-1",
            },
            id: "steering-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: { modelLocked: true, runId: "run-1", stopReason: "stop" },
            id: "run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        acceptance.resolve({
            eventId: "steering-submitted",
            runId: "run-1",
            sessionId: "session-1",
        });

        await app.waitForIdle();
        expect(abort).not.toHaveBeenCalled();
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain(`› ${text}`);
        expect(rendered).not.toContain("Messages to be submitted after next tool call");
    });

    it("continues once when accepted steering is already applied before repeated Escape", async () => {
        const acceptance = deferred<{
            eventId: string;
            runId: string;
            sessionId: string;
        }>();
        const steer = vi.fn(() => acceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, steer });
        const text = "Apply before the response settles.";

        submit(app, text);
        const messageId = steeringMessageId(steer);
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: text,
                message: {
                    blocks: [{ text, type: "text" }],
                    id: messageId,
                    role: "user",
                },
                runId: "run-1",
            },
            id: "steering-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: { messageIds: [messageId], runId: "run-1" },
            id: "steering-applied",
            sessionId: "session-1",
            type: "steering_applied",
        });
        acceptance.resolve({
            eventId: "steering-submitted",
            runId: "run-1",
            sessionId: "session-1",
        });

        await app.waitForIdle();
        expect(abort).not.toHaveBeenCalled();
        app.handleInput("\x1b");
        app.handleInput("\x1b");
        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledOnce();
        expect(abort).toHaveBeenCalledWith({
            continuePendingSteering: true,
            expectedRunId: "run-1",
            steeringMessageIds: [messageId],
        });
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered.match(new RegExp(`› ${text}`, "gu"))).toHaveLength(1);
        expect(rendered).not.toContain("Messages to be submitted after next tool call");
    });

    it("treats a committed event as acceptance when the HTTP response is lost", async () => {
        const acceptance = deferred<void>();
        const steer = vi.fn(() => acceptance.promise);
        const abort = vi.fn(async () => ({ aborted: true, continued: true }));
        const { app } = createRaceApp({ abort, steer });
        const text = "Keep the committed steering exact once.";

        submit(app, text);
        app.handleInput("\x1b");
        const messageId = steeringMessageId(steer);
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: text,
                message: {
                    blocks: [{ text, type: "text" }],
                    id: messageId,
                    role: "user",
                },
                runId: "run-1",
            },
            id: "steering-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });
        acceptance.reject(new Error("socket closed after commit"));

        await vi.waitFor(() =>
            expect(abort).toHaveBeenCalledWith({
                continuePendingSteering: true,
                expectedRunId: "run-1",
                steeringMessageIds: [messageId],
            }),
        );
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).not.toContain(`› ${text}`);
        expect(rendered).not.toContain("socket closed after commit");
    });

    it("does not treat notification steering as a local submission in flight", async () => {
        const steer = vi.fn(async () => undefined);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, steer });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: "Background work completed.",
                message: {
                    blocks: [{ text: "Background work completed.", type: "text" }],
                    id: "notification-message",
                    role: "user",
                },
                runId: "run-1",
                source: "notification",
            },
            id: "notification-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });

        app.handleInput("\x1b");

        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledWith({ expectedRunId: "run-1" });
        expect(steer).not.toHaveBeenCalled();
    });

    it("queues input submitted before the session run_started event", async () => {
        const firstRun = deferred<{
            contextMessages: [];
            messages: [];
            runId: string;
            stopReason: "stop";
        }>();
        const send = vi
            .fn()
            .mockImplementationOnce(() => firstRun.promise)
            .mockResolvedValue({
                contextMessages: [],
                messages: [],
                runId: "follow-up-agent-run",
                stopReason: "stop",
            });
        const steer = vi.fn(async () => undefined);
        const abort = vi.fn(async () => ({ aborted: true }));
        const { app } = createRaceApp({ abort, send, startRun: false, steer });

        submit(app, "Start the session-backed run.");
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        submit(app, "Retain this startup-window input.");

        expect(steer).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "↳ queued Retain this startup-window input.",
        );

        app.applySessionEvent({
            createdAt: 2,
            data: { runId: "run-1" },
            id: "run-started-late",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: { modelLocked: true, runId: "run-1", stopReason: "stop" },
            id: "run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        firstRun.resolve({
            contextMessages: [],
            messages: [],
            runId: "first-agent-run",
            stopReason: "stop",
        });

        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        expect(send.mock.calls[1]?.[1]).toBe("Retain this startup-window input.");
        expect(steer).not.toHaveBeenCalled();
    });
});

function createRaceApp(options: {
    abort: ReturnType<typeof vi.fn>;
    send?: ReturnType<typeof vi.fn>;
    startRun?: boolean;
    steer: ReturnType<typeof vi.fn>;
}): { agent: Agent; app: CodingAssistantApp } {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "openai/steering-race-test",
        name: "Steering race test",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream() {
            throw new Error("Unexpected local inference.");
        },
    });
    const harness = createJustBashToolHarness();
    const agentOverrides = {
        abort: options.abort,
        ...(options.send === undefined ? {} : { send: options.send }),
        steer: options.steer,
    };
    const agent = Object.assign(
        new Agent({
            context: harness.context,
            modelId: model.id,
            printToConsole: false,
            provider,
        }),
        agentOverrides,
    );
    const app = new CodingAssistantApp({
        ctx: createTestRootContext().named("app"),
        agent,
        cwd: harness.context.fs.cwd,
        processManager: new NativeProcessManager(),
        sessionBacked: true,
        tui: fakeTui(),
    });
    if (options.startRun !== false) {
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "run-started",
            sessionId: "session-1",
            type: "run_started",
        });
    }
    return { agent, app };
}

function submit(app: CodingAssistantApp, text: string): void {
    app.handleInput(text);
    app.handleInput("\r");
}

function steeringMessageId(steer: ReturnType<typeof vi.fn>, index = 0): string {
    const options = steeringRunOptions(steer, index);
    expect(options?.clientSubmissionId).toBeTypeOf("string");
    return options?.clientSubmissionId ?? "";
}

function steeringRunOptions(
    steer: ReturnType<typeof vi.fn>,
    index = 0,
): { clientSubmissionId?: string; expectedRunId?: string } | undefined {
    const calls = steer.mock.calls as unknown as Array<
        [unknown, { clientSubmissionId?: string; expectedRunId?: string }?]
    >;
    return calls[index]?.[1];
}

function deferred<T>(): {
    promise: Promise<T>;
    reject: (reason?: unknown) => void;
    resolve: (value?: T) => void;
} {
    let rejectPromise: (reason?: unknown) => void = () => {};
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return {
        promise,
        reject: rejectPromise,
        resolve: (value) => resolvePromise(value as T),
    };
}

function fakeTui(): TUI {
    return {
        addChild: vi.fn(),
        requestRender: vi.fn(),
        setFocus: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        terminal: { columns: 100, rows: 40, write: vi.fn() },
    } as unknown as TUI;
}

/** These exercise boundary handling, not transcript rebuilding. */
function emptyTranscript() {
    return { complete: true, messages: [], turns: [] };
}
