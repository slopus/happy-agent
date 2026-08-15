import { createTestRootContext } from "../testing/createTestRootContext.js";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../agent/Agent.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import type { AgentLoopEvent } from "../agent/loop.js";
import { defineTool } from "../agent/types.js";
import type { Skill } from "../agent/skills/Skill.js";
import { MAXIMUM_SKILL_FILE_BYTES } from "../agent/skills/loadSkillFromFile.js";
import type { ProtocolHttpClient } from "../client/ProtocolHttpClient.js";
import { RemoteAgent } from "../client/RemoteAgent.js";
import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { validJpeg32Base64, validPng32Base64 } from "../testing/validImageFixtures.js";
import { NativeProcessManager } from "../processes/index.js";
import { createPermissionContext } from "../permissions/index.js";
import type {
    GetSessionUsageResponse,
    ModelCatalog,
    ProtocolSession,
    SessionEvent,
} from "../protocol/index.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type InferenceStream,
    type Usage,
} from "@slopus/rig-execution";
import { CodingAssistantApp } from "./CodingAssistantApp.js";
import { createSerialTaskQueue } from "./createSerialTaskQueue.js";
import { DEFAULT_TERMINAL_THEME } from "./defaultTerminalTheme.js";
import { stripAnsi } from "./testing/stripAnsi.js";

const testCommandTool = defineTool({
    name: "test_command",
    label: "Test command",
    description: "Runs a command for transcript presentation tests.",
    arguments: Type.Object({ cmd: Type.String() }),
    returnType: Type.Object({ command: Type.String(), output: Type.String() }),
    shouldReviewInAutoMode: () => false,
    execute: async ({ cmd }, context, execution) => {
        const sessionId = await context.bash.startSession({ command: cmd });
        const snapshot = await context.bash.readSession(sessionId, { waitMs: 30_000 });
        if (snapshot === undefined) throw new Error("The test command was not found.");
        const output = [snapshot.stdout, snapshot.stderr].filter(Boolean).join("\n");
        execution.onProgress?.(output);
        return { command: cmd, output };
    },
    toCallPresentation: ({ cmd }) => ({ command: cmd, type: "exec_command" }),
    toPresentation: ({ command, output }) => ({ command, output, type: "exec_command" }),
    toLLM: ({ output }) => [{ type: "text", text: output }],
    toUI: ({ output }) => output,
    locks: [],
});

const selectTestTools = () => [testCommandTool];

describe("CodingAssistantApp", () => {
    it("uses a leading trimmed bang as the shell prompt and exits on backspace at column zero", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const runShellCommand = vi.fn(async (command: string, options: { commandId: string }) => ({
            command,
            commandId: options.commandId,
            eventId: "shell-finished",
            exitCode: 0,
            output: "done\n",
            status: "finished" as const,
            timedOut: false,
        }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { runShellCommand },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        app.handleInput("  !");
        const shellPrompt = stripAnsi(app.render(100).join("\n"));
        expect(shellPrompt).toContain("! Ask Rig to do anything");
        expect(shellPrompt).toContain("Shell mode");
        expect(shellPrompt).not.toContain("› !");

        app.handleInput("\x7f");
        const normalPrompt = stripAnsi(app.render(100).join("\n"));
        expect(normalPrompt).toContain("› Ask Rig to do anything");
        expect(normalPrompt).not.toContain("Shell mode");

        submit(app, "!echo done");
        await app.waitForIdle();

        expect(runShellCommand).toHaveBeenCalledWith("echo done", {
            commandId: expect.any(String),
        });
    });

    it("backgrounds a daemon-owned shell command when foreground polling disconnects", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const readBackgroundProcess = vi.fn(async () => {
            throw new Error("The daemon connection closed.");
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                {
                    readBackgroundProcess,
                    runShellCommand: async (command: string, options: { commandId: string }) => ({
                        command,
                        commandId: options.commandId,
                        eventId: "shell-started",
                        sessionId: 9,
                        status: "running" as const,
                    }),
                },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "!sleep 60");
        await vi.waitFor(() => expect(readBackgroundProcess).toHaveBeenCalledOnce());

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Continues in background · /ps to view");
        expect(rendered).toContain("1 background terminal running");
        expect(rendered).not.toContain("Failed sleep 60");
    });

    it("does not render rows or separators for finalized whitespace-only assistant or thinking entries", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            showReasoning: true,
            tui: fakeTui(),
        });
        const baseline = app.render(80);

        app.applySessionEvent({
            createdAt: 1,
            data: {
                message: {
                    blocks: [{ text: " \n\n ", type: "text" }],
                    id: "whitespace-assistant",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "whitespace-assistant-event",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                event: {
                    contentIndex: 0,
                    messageId: "empty-thinking-message",
                    partial: {
                        api: "test",
                        content: [],
                        model: "openai/gpt-test",
                        provider: "codex",
                        role: "assistant",
                        stopReason: "stop",
                        timestamp: 1,
                        usage: zeroUsage(),
                    },
                    type: "thinking_start",
                },
                runId: "run-1",
            },
            id: "empty-thinking-start",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: {
                event: {
                    content: "\n\n",
                    contentIndex: 0,
                    messageId: "empty-thinking-message",
                    partial: {
                        api: "test",
                        content: [],
                        model: "openai/gpt-test",
                        provider: "codex",
                        role: "assistant",
                        stopReason: "stop",
                        timestamp: 1,
                        usage: zeroUsage(),
                    },
                    type: "thinking_end",
                },
                runId: "run-1",
            },
            id: "empty-thinking-end",
            sessionId: "session-1",
            type: "agent_event",
        });

        expect(app.render(80)).toEqual(baseline);
    });

    it("keeps one user history row for a session-backed submission through its echo", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const run = deferred<{
            contextMessages: readonly never[];
            messages: readonly never[];
            runId: string;
            stopReason: "stop";
        }>();
        const send = vi.fn(() => run.promise);
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { send },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "Keep the composer steady");
        // Nothing was running, so the prompt takes its history row immediately rather than
        // waiting as queued work while the run starts.
        const submitted = stripAnsi(app.render(100).join("\n"));
        expect(submitted).not.toContain("↳ queued Keep the composer steady");
        expect(submitted.match(/› Keep the composer steady/gu)).toHaveLength(1);

        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        expect(send).toHaveBeenCalledWith(
            expect.anything(),
            "Keep the composer steady",
            expect.objectContaining({ clientSubmissionId: expect.any(String) }),
        );
        const drained = stripAnsi(app.render(100).join("\n"));
        expect(drained).not.toContain("↳ queued Keep the composer steady");
        expect(drained.match(/› Keep the composer steady/gu)).toHaveLength(1);

        const echoedMessage = {
            blocks: [{ text: "Keep the composer steady", type: "text" as const }],
            id: "canonical-user-message",
            role: "user" as const,
        };
        const echo = {
            createdAt: 1,
            data: {
                displayText: "Keep the composer steady",
                message: echoedMessage,
                runId: "run-1",
            },
            id: "user-message-event",
            sessionId: "session-1",
            type: "message_submitted" as const,
        };
        app.applySessionEvent(echo);
        app.applySessionEvent(echo);

        const echoed = stripAnsi(app.render(100).join("\n"));
        expect(echoed.match(/› Keep the composer steady/gu)).toHaveLength(1);

        run.resolve({ contextMessages: [], messages: [], runId: "run-1", stopReason: "stop" });
        await app.waitForIdle();
    });

    it("keeps a submitted turn's live timer anchored to the composer message after its delayed echo", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const run = deferred<{
            contextMessages: readonly never[];
            messages: readonly never[];
            runId: string;
            stopReason: "stop";
        }>();
        const send = vi.fn(() => run.promise);
        let now = 100_000;
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { send },
            ),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 10_000,
            data: {
                displayText: "An earlier turn.",
                message: {
                    blocks: [{ text: "An earlier turn.", type: "text" }],
                    id: "earlier-user-message",
                    role: "user",
                },
                runId: "earlier-run",
            },
            id: "earlier-message-event",
            sessionId: "session-1",
            type: "message_submitted",
        });

        submit(app, "Start a fresh turn.");
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

        now = 105_000;
        app.applySessionEvent({
            createdAt: now,
            data: {
                displayText: "Start a fresh turn.",
                message: {
                    blocks: [{ text: "Start a fresh turn.", type: "text" }],
                    id: "canonical-new-user-message",
                    role: "user",
                },
                runId: "new-run",
            },
            id: "new-message-event",
            sessionId: "session-1",
            type: "message_submitted",
        });

        now = 106_000;
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Working (6s · esc to interrupt)");
        expect(rendered).not.toContain("Working (1s · esc to interrupt)");

        run.resolve({ contextMessages: [], messages: [], runId: "new-run", stopReason: "stop" });
        await app.waitForIdle();

        now = 200_000;
        app.applySessionEvent({
            createdAt: now,
            data: {
                displayText: "Start elsewhere.",
                message: {
                    blocks: [{ text: "Start elsewhere.", type: "text" }],
                    id: "remote-user-message",
                    role: "user",
                },
                runId: "remote-run",
            },
            id: "remote-message-event",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: now,
            data: { runId: "remote-run" },
            id: "remote-run-started",
            sessionId: "session-1",
            type: "run_started",
        });

        now = 206_000;
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Working (6s · esc to interrupt)");
        app.applySessionEvent({
            createdAt: now,
            data: {
                agentRunId: "remote-agent-run",
                modelLocked: true,
                runId: "remote-run",
                stopReason: "stop",
            },
            id: "remote-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
    });

    it("warns before starting inspectors when TUI stderr is the terminal", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const startInspectors = vi.fn(async () => ({
            serverInspectorUrl: "ws://127.0.0.1:42002/daemon",
            tuiInspectorUrl: "ws://127.0.0.1:42001/tui",
        }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            debugInfo: {
                daemonLogPath: "/state/rig/server.log",
                sessionId: "session-debug-1",
                startInspectors,
                stateDirectory: "/state/rig",
                tuiStderrIsTTY: true,
            },
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/debug");

        const warning = stripAnsi(app.render(120).join("\n"));
        expect(warning).toContain("Start live debugging?");
        expect(warning).toContain("stderr is still this terminal");
        expect(warning).toContain("Redirect stderr before starting");
        expect(startInspectors).not.toHaveBeenCalled();

        app.handleInput("\r");
        await vi.waitFor(() => expect(startInspectors).toHaveBeenCalledOnce());

        const rendered = stripAnsi(app.render(120).join("\n"));
        expect(rendered).toContain("Debug");
        expect(rendered).toContain("globalThis.__rigDebug");
        expect(rendered).toContain("session-debug-1");
        expect(rendered).toContain("/state/rig");
        expect(rendered).toContain("Daemon log");
        expect(rendered).toContain("/state/rig/server.log");
        expect(rendered).toContain("ws://127.0.0.1:42001/tui");
        expect(rendered).toContain("ws://127.0.0.1:42002/daemon");
        expect(rendered).not.toContain("Daemon socket");
        expect(rendered).not.toContain("Client state");
    });

    it("exits with a reload request when the local reload command is submitted", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/reload");

        await expect(app.waitForExit()).resolves.toBe("reload");
    });

    it("renders the startup frame and Codex-style empty composer", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            toolSelector: selectTestTools,
            printToConsole: false,
        });
        const onUserActivity = vi.fn();
        const onTerminalFocusChange = vi.fn();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onUserActivity,
            onTerminalFocusChange,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
            version: "1.2.3",
        });

        const raw = app.render(80).join("\n");
        const rendered = stripAnsi(raw);
        const renderedLines = rendered.split("\n");
        expect(rendered).toContain("  ██████╗ ██╗ ██████╗    ██╗   ██████╗    ██████╗  ");
        expect(rendered).toContain("  ╚═╝  ╚═╝╚═╝ ╚═════╝    ╚═╝╚═╝╚══════╝╚═╝╚═════╝  ");
        expect(rendered).not.toContain("Agentic coding CLI");
        expect(rendered).not.toContain("private local daemon");
        expect(rendered).toContain("Rig 1.2.3 · New session");
        expect(rendered).toContain("Model: GPT Test · Reasoning: Off · Provider: Codex");
        expect(rendered).toContain("Workspace: /workspace · Environment: Local");
        expect(rendered).toContain("Access: Full access");
        expect(rendered).not.toContain("Directory:");
        expect(rendered).toContain("Ask Rig to do anything");
        expect(renderedLines[0]).toBe("");
        expect(renderedLines[1]?.length).toBeLessThan(80);
        expect(renderedLines[1]).toBe("  ██████╗ ██╗ ██████╗    ██╗   ██████╗    ██████╗  ");
        expect(rendered).not.toContain(">_ Rig");
        expect(rendered).not.toContain("Tools:");
        expect(rendered).not.toContain("cwd:");
        expect(raw).toContain("\x1b[48;5;235m");
        expect(raw).not.toContain("\x1b[48;5;236m");
        expect(raw).toContain("\x1b[38;5;202m\x1b[1m›\x1b[22m\x1b[39m");
        expect(raw).toContain("\x1b[33mgpt-test off");
        expect(raw).toContain("\x1b[32m/workspace");
        expect(rendered).toContain("› Ask Rig to do anything");
        expect(rendered).not.toContain("›  Ask Rig to do anything");
        expect(rendered).toContain("gpt-test off");
        expect(rendered).toContain("/workspace");
        expect(rendered).not.toContain("main [default]");
        expect(rendered).toContain("full access");
        expect(rendered).toContain("gpt-test off · /workspace · full access");
        expect(rendered).not.toContain("full_access");
        expect(rendered).not.toContain("reasoning off");
        expect(rendered).not.toContain("/clear /abort /quit");

        app.handleInput("h");
        expect(onUserActivity).toHaveBeenCalledOnce();
        app.handleInput("\x1b[O");
        app.handleInput("\x1b[I");
        expect(onTerminalFocusChange).toHaveBeenNthCalledWith(1, false);
        expect(onTerminalFocusChange).toHaveBeenNthCalledWith(2, true);
        const typedInput = app.render(80).join("\n");
        expect(typedInput).toContain("\x1b[39m");
        expect(typedInput).toContain("\x1b[38;5;202m\x1b[1m›\x1b[22m\x1b[39m");
        expect(stripAnsi(typedInput)).toContain("› h");

        const rawLines = app.render(80);
        const strippedLines = rawLines.map(stripAnsi);
        expect(rawLines.at(-1)).toBe("");
        expect(rawLines.at(-2)).toContain("gpt-test off");
        const inputLineIndex = strippedLines.findIndex((line) => line.includes("› h"));
        const footerLineIndex = strippedLines.findIndex((line) => line.startsWith("  gpt-test"));
        expect(inputLineIndex).toBeGreaterThan(0);
        expect(footerLineIndex).toBe(inputLineIndex + 2);
        expect(rawLines[inputLineIndex - 1]).toContain("\x1b[48;5;235m");
        expect(rawLines[inputLineIndex]).toContain("\x1b[48;5;235m");
        expect(rawLines[inputLineIndex]).toContain("\x1b[39m");
        expect(rawLines[inputLineIndex + 1]).toContain("\x1b[48;5;235m");
        expect(rawLines[inputLineIndex + 2]).toContain("gpt-test off");
    });

    it("promotes session-backed steering from pending preview only when applied", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        const message = {
            blocks: [{ text: "Pending direction", type: "text" as const }],
            id: "steer-1",
            role: "user" as const,
        };
        app.applySessionEvent({
            createdAt: 1,
            data: {
                delivery: "steer",
                displayText: "Pending direction",
                message,
                runId: "run-1",
            },
            id: "event-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });
        const pending = stripAnsi(app.render(100).join("\n"));
        expect(pending).toContain("Messages to be submitted after next tool call");
        expect(pending).toContain("└ Pending direction");
        expect(pending).not.toContain("› Pending direction");

        app.applySessionEvent({
            createdAt: 2,
            data: {
                message: {
                    blocks: [{ text: "Rendered while steering was pending", type: "text" }],
                    id: "assistant-after-steering-submission",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "assistant-event",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: { messageIds: [message.id], runId: "run-1" },
            id: "event-applied",
            sessionId: "session-1",
            type: "steering_applied",
        });
        const applied = stripAnsi(app.render(100).join("\n"));
        expect(applied).not.toContain("Messages to be submitted after next tool call");
        expect(applied).toContain("› Pending direction");
        expect(applied.indexOf("Rendered while steering was pending")).toBeLessThan(
            applied.indexOf("› Pending direction"),
        );
    });

    it("clears a draft before using a later Escape to deliver pending steering", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true, continued: true }));
        const agent = Object.assign(
            new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            { abort },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        const message = {
            blocks: [{ text: "Pending direction", type: "text" as const }],
            id: "steer-1",
            role: "user" as const,
        };
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "event-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: "Pending direction",
                message,
                runId: "run-1",
            },
            id: "event-submitted",
            sessionId: "session-1",
            type: "message_submitted",
        });

        app.handleInput("Keep this pending-run draft");
        app.handleInput("\x1b");
        app.handleInput("\x1b");
        await vi.waitFor(() =>
            expect(abort).toHaveBeenCalledWith({
                continuePendingSteering: true,
                expectedRunId: "run-1",
                steeringMessageIds: ["steer-1"],
            }),
        );
        expect(abort).toHaveBeenCalledTimes(1);

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("esc to interrupt");
        expect(rendered).toContain("› Ask Rig to do anything");
        expect(rendered).not.toContain("Session interrupted");
    });

    it("stops the active run when only an earlier run has stale pending steering", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { abort },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "old-run" },
            id: "old-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                delivery: "steer",
                displayText: "Stale direction",
                message: {
                    blocks: [{ text: "Stale direction", type: "text" }],
                    id: "stale-steer",
                    role: "user",
                },
                runId: "old-run",
            },
            id: "old-steer",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: {
                agentRunId: "old-agent-run",
                modelLocked: true,
                runId: "old-run",
                stopReason: "aborted",
            },
            id: "old-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        app.applySessionEvent({
            createdAt: 5,
            data: { runId: "current-run" },
            id: "current-started",
            sessionId: "session-1",
            type: "run_started",
        });

        app.handleInput("\x1b");

        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        expect(abort).toHaveBeenCalledWith({ expectedRunId: "current-run" });
    });

    it("lets an open selection panel handle Escape before a running session", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { abort },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.handleInput("\x1bm");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Choose Model");

        app.handleInput("\x1b");

        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("Choose Model");
        expect(abort).not.toHaveBeenCalled();
    });

    it("keeps Escape inside a structured question instead of aborting its run", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { abort },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                questions: [
                    {
                        header: "Choice",
                        id: "choice",
                        multiSelect: false,
                        options: [{ description: "Use this answer.", label: "Answer" }],
                        question: "Choose an answer.",
                    },
                ],
                requestId: "request-1",
            },
            id: "input-requested",
            sessionId: "session-1",
            type: "user_input_requested",
        });

        app.handleInput("\x1b");

        expect(stripAnsi(app.render(100).join("\n"))).toContain("Choose an answer.");
        expect(abort).not.toHaveBeenCalled();
    });

    it("dismisses autocomplete and clears its draft before Escape can abort", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { abort },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.handleInput("/");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("/model");

        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("/model");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› /");
        expect(abort).not.toHaveBeenCalled();

        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
        expect(abort).not.toHaveBeenCalled();

        app.handleInput("\x1b");
        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    });

    it("clears non-empty running drafts before a later empty Escape stops the turn", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true }));
        const agent = Object.assign(
            new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            { abort },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "event-started",
            sessionId: "session-1",
            type: "run_started",
        });

        app.handleInput("Keep this stopping-run draft");
        app.handleInput("\x1b");
        expect(abort).not.toHaveBeenCalled();
        app.handleInput("  ");
        app.handleInput("\x1b");
        expect(abort).not.toHaveBeenCalled();
        app.handleInput("\x1b");

        await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
        expect(abort).toHaveBeenCalledWith({ expectedRunId: "run-1" });
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
    });

    it("queues an immediate post-Escape submit until the interrupted run settles", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const interrupt = deferred<{ aborted: boolean }>();
        const abort = vi.fn(() => interrupt.promise);
        const steer = vi.fn(async () => undefined);
        const send = vi.fn(async () => ({
            contextMessages: [],
            messages: [],
            runId: "next-agent-run",
            stopReason: "stop" as const,
        }));
        const agent = Object.assign(
            new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            { abort, send, steer },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "interrupted-run" },
            id: "event-started",
            sessionId: "session-1",
            type: "run_started",
        });

        app.handleInput("\x1b");
        submit(app, "Retain this immediate follow-up");

        expect(abort).toHaveBeenCalledOnce();
        expect(steer).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "↳ queued Retain this immediate follow-up",
        );

        app.applySessionEvent({
            createdAt: 2,
            data: {
                agentRunId: "interrupted-agent-run",
                modelLocked: true,
                runId: "interrupted-run",
                stopReason: "aborted",
            },
            id: "event-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        expect(send).not.toHaveBeenCalled();
        interrupt.resolve({ aborted: true });

        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        expect(send).toHaveBeenCalledWith(
            expect.anything(),
            "Retain this immediate follow-up",
            expect.objectContaining({ displayText: "Retain this immediate follow-up" }),
        );
        expect(steer).not.toHaveBeenCalled();
    });

    it("retains an immediate post-Escape submit when the local run settles before the session event", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const firstRun = deferred<{
            contextMessages: [];
            messages: [];
            runId: string;
            stopReason: "aborted";
        }>();
        const send = vi
            .fn()
            .mockImplementationOnce(() => firstRun.promise)
            .mockResolvedValue({
                contextMessages: [],
                messages: [],
                runId: "follow-up-agent-run",
                stopReason: "stop" as const,
            });
        const abort = vi.fn(async () => ({ aborted: true }));
        const steer = vi.fn(async () => undefined);
        const agent = Object.assign(
            new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            { abort, send, steer },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "Start the locally tracked run.");
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "interrupted-run" },
            id: "event-started",
            sessionId: "session-1",
            type: "run_started",
        });

        app.handleInput("\x1b");
        submit(app, "Retain this immediate follow-up");
        firstRun.resolve({
            contextMessages: [],
            messages: [],
            runId: "interrupted-agent-run",
            stopReason: "aborted",
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(send).toHaveBeenCalledOnce();
        // The follow-up owns its history row while it waits for the interrupted run to settle,
        // so the text stays put instead of moving out of the queued list later.
        const waiting = stripAnsi(app.render(100).join("\n"));
        expect(waiting.match(/› Retain this immediate follow-up/gu)).toHaveLength(1);

        app.applySessionEvent({
            createdAt: 2,
            data: {
                agentRunId: "interrupted-agent-run",
                modelLocked: true,
                runId: "interrupted-run",
                stopReason: "aborted",
            },
            id: "event-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        expect(send.mock.calls[1]?.[1]).toBe("Retain this immediate follow-up");
        expect(steer).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n")).split("Session interrupted").length - 1).toBe(
            1,
        );
    });

    it("keeps a running draft recoverable after clearing it before interrupting", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: true }));
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { abort },
            ),
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "event-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.handleInput("Recover this running draft from history");
        app.handleInput("\x1b");
        expect(abort).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
        app.handleInput("\x1b");
        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        app.applySessionEvent({
            createdAt: 2,
            data: {
                agentRunId: "agent-run-1",
                modelLocked: true,
                runId: "run-1",
                stopReason: "aborted",
            },
            id: "event-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        app.handleInput("\x1b[A");
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "› Recover this running draft from history",
        );
    });

    it.each(["session_reset", "session_rewound"] as const)(
        "discards local queued execution into history and ignores stale work after %s",
        (boundaryType) => {
            const model = defineModel({
                id: "openai/gpt-test",
                name: "GPT Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const provider = defineProvider({
                id: "codex",
                models: [model],
                stream() {
                    return streamText("unused");
                },
            });
            const harness = createJustBashToolHarness();
            const send = vi.fn(async () => ({
                contextMessages: [],
                messages: [],
                runId: "unexpected-run",
                stopReason: "stop" as const,
            }));
            const agent = Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { send },
            );
            const app = new CodingAssistantApp({
                ctx: createTestRootContext().named("app"),
                agent,
                cwd: harness.context.fs.cwd,
                processManager: new NativeProcessManager(),
                sessionBacked: true,
                tui: fakeTui(),
            });
            app.applySessionEvent({
                createdAt: 1,
                data: { runId: "old-run" },
                id: "old-started",
                sessionId: "session-1",
                type: "run_started",
            });
            app.handleInput("Discard this queued execution");
            app.handleInput("\t");
            app.handleInput("Preserve this external-boundary draft");

            app.applySessionEvent(
                boundaryType === "session_reset"
                    ? {
                          createdAt: 2,
                          data: { snapshot: agent.snapshot(), transcript: emptyTranscript() },
                          id: "boundary",
                          sessionId: "session-1",
                          type: "session_reset",
                      }
                    : {
                          createdAt: 2,
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
            app.applySessionEvent({
                createdAt: 3,
                data: {
                    message: {
                        blocks: [{ text: "STALE OLD MESSAGE", type: "text" }],
                        id: "stale-message",
                        role: "agent",
                    },
                    runId: "old-run",
                },
                id: "stale-agent-message",
                sessionId: "session-1",
                type: "agent_message",
            });
            app.applySessionEvent({
                createdAt: 4,
                data: {
                    agentRunId: "old-agent-run",
                    modelLocked: true,
                    runId: "old-run",
                    stopReason: "aborted",
                },
                id: "stale-finished",
                sessionId: "session-1",
                type: "run_finished",
            });
            app.applySessionEvent({
                createdAt: 5,
                data: {
                    errorMessage: "STALE OLD ERROR",
                    modelLocked: true,
                    runId: "old-run",
                },
                id: "stale-error",
                sessionId: "session-1",
                type: "run_error",
            });

            const rendered = stripAnsi(app.render(100).join("\n"));
            expect(rendered).toContain("› Preserve this external-boundary draft");
            expect(rendered).not.toContain("↳ queued");
            expect(rendered).not.toContain("STALE OLD MESSAGE");
            expect(rendered).not.toContain("STALE OLD ERROR");
            expect(send).not.toHaveBeenCalled();

            app.handleInput("\x03");
            app.handleInput("\x1b[A");
            expect(stripAnsi(app.render(100).join("\n"))).toContain(
                "› Discard this queued execution",
            );
        },
    );

    it("closes a selection panel before a later Escape clears the composer", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("Keep after closing overlay");
        app.handleInput("\x1bm");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Choose Model");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Keep after closing overlay");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
    });

    it("clears a draft normally after terminal focus changes", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("Keep across terminal focus");
        app.handleInput("\x1b[O");
        app.handleInput("\x1b[I");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
    });

    it("keeps Escape local to freeform and structured question inputs", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: {
                questions: [
                    {
                        header: "Choice",
                        id: "choice",
                        multiSelect: false,
                        options: [{ description: "Use the listed answer.", label: "Listed" }],
                        question: "Choose an answer.",
                    },
                ],
                requestId: "request-1",
            },
            id: "event-requested",
            sessionId: "session-1",
            type: "user_input_requested",
        });
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("Keep this freeform answer");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Type another answer");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Choose an answer.");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Choose an answer.");
        app.applySessionEvent({
            createdAt: 2,
            data: { requestId: "request-1", status: "cancelled" },
            id: "event-resolved",
            sessionId: "session-1",
            type: "user_input_resolved",
        });

        app.handleInput("Keep after freeform exit");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
    });

    it("clears a draft on Escape and retrieves it with Up", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("Recover this draft");
        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
        app.handleInput("\x1b[A");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Recover this draft");
        app.handleInput("\x1b[B");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Ask Rig to do anything");
        app.handleInput("\x1b[A");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› Recover this draft");
    });

    it("uses the idle abort command to stop session background processes", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const abort = vi.fn(async () => ({ aborted: false, stoppedProcesses: 1 }));
        const agent = Object.assign(
            new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            { abort },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "/abort");

        await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
            expect(stripAnsi(app.render(80).join("\n"))).toContain("Stopped 1 background process."),
        );
    });

    it("keeps retained input immutable while repainting the live composer theme", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("Theme response."),
        });
        const harness = createJustBashToolHarness();
        const tui = fakeTui();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            theme: DEFAULT_TERMINAL_THEME,
            tui,
        });

        submit(app, "Change the palette.");
        await app.waitForIdle();
        expect(app.render(80).join("\n")).toContain("\x1b[48;5;235m");
        vi.mocked(tui.requestRender).mockClear();

        app.setTheme({
            ...DEFAULT_TERMINAL_THEME,
            inputBackground: "\x1b[48;5;254m",
            isLight: true,
        });

        const updated = app.render(80).join("\n");
        expect(updated).toContain("Change the palette.");
        expect(updated).toContain("\x1b[48;5;254m");
        expect(updated).toContain("\x1b[48;5;235m");
        expect(tui.requestRender).toHaveBeenCalledWith(false);
    });

    it("keeps rendered header and transcript bytes stable across a theme change", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const oldBrand = "\x1b[38;5;201m";
        const oldPrimary = "\x1b[38;5;202m";
        const oldSecondary = "\x1b[38;5;203m";
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            theme: {
                ...DEFAULT_TERMINAL_THEME,
                brand: oldBrand,
                primary: oldPrimary,
                secondary: oldSecondary,
            },
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: {
                message: {
                    blocks: [{ text: "Cached transcript colors.", type: "text" }],
                    id: "assistant-theme",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "assistant-theme-event",
            sessionId: "session-1",
            type: "agent_message",
        });

        const initial = app.render(80);
        const initialJoined = initial.join("\n");
        expect(initialJoined).toContain(oldBrand);
        expect(initialJoined).toContain(oldPrimary);
        const transcriptLine = initial.findIndex((line) =>
            line.includes("Cached transcript colors."),
        );
        expect(transcriptLine).toBeGreaterThanOrEqual(0);

        // Retained rows are append-only: a theme change recolors them through
        // terminal palette redefinition, so the header and transcript must
        // keep serving byte-identical lines instead of repainting.
        app.setTheme({
            ...DEFAULT_TERMINAL_THEME,
            brand: "\x1b[38;5;211m",
            primary: "\x1b[38;5;212m",
            secondary: "\x1b[38;5;213m",
        });

        const updated = app.render(80);
        expect(updated.slice(0, transcriptLine + 1)).toEqual(initial.slice(0, transcriptLine + 1));
    });

    it("renders every markdown table row after streaming finishes", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const tui = fakeTui({ rows: 12 });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui,
        });
        const table = [
            "| Name | Value |",
            "| --- | --- |",
            ...Array.from(
                { length: 30 },
                (_, index) => `| row-${String(index + 1)} | value-${String(index + 1)} |`,
            ),
        ].join("\n");
        const partial: AssistantMessage = {
            api: "test",
            content: [],
            model: model.id,
            provider: "codex",
            role: "assistant",
            stopReason: "stop",
            timestamp: 1,
            usage: zeroUsage(),
        };
        app.applySessionEvent({
            createdAt: 1,
            data: {
                event: {
                    contentIndex: 0,
                    delta: table,
                    messageId: "streaming-table-message",
                    partial,
                    type: "text_delta",
                },
                runId: "run-1",
            },
            id: "streaming-table-delta",
            sessionId: "session-1",
            type: "agent_event",
        });

        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("row-5");

        (tui.terminal as { rows: number }).rows = 20;
        expect(stripAnsi(app.render(100).join("\n"))).toContain("row-5");

        app.applySessionEvent({
            createdAt: 2,
            data: {
                message: {
                    blocks: [{ text: table, type: "text" }],
                    id: "assistant-table",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "assistant-table-event",
            sessionId: "session-1",
            type: "agent_message",
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain("row-30");
    });

    it("keeps only the current width in the header render cache", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        for (let width = 40; width < 80; width += 1) app.render(width);

        expect(app.headerRenderCacheSizeForTesting()).toBe(1);
        expect(app.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
        expect(app.headerRenderCacheSizeForTesting()).toBe(1);
    });

    it("opens Codex-style backtracking on Escape and restores the selected prompt", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const first = {
            blocks: [{ text: "First prompt", type: "text" as const }],
            id: "user-1",
            role: "user" as const,
        };
        const second = {
            blocks: [{ text: "Try this again", type: "text" as const }],
            id: "user-2",
            role: "user" as const,
        };
        const agent = Object.assign(
            new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            { rewind: vi.fn(async () => second) },
        );
        const submitted = (
            message: typeof first | typeof second,
            eventId: string,
        ): SessionEvent => ({
            createdAt: 1,
            data: {
                displayText: message.blocks[0]?.text ?? "",
                message,
                runId: `run-${eventId}`,
            },
            id: eventId,
            sessionId: "session-1",
            type: "message_submitted",
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            initialSessionEvents: [submitted(first, "event-1"), submitted(second, "event-2")],
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        app.handleInput("\x1b");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Rewind conversation");
        app.handleInput("\r");

        await vi.waitFor(() => expect(agent.rewind).toHaveBeenCalledWith("user-2"));
        await vi.waitFor(() =>
            expect(stripAnsi(app.render(100).join("\n"))).toContain("› Try this again"),
        );
    });

    it("renders the lower-case Codex footer with distinct model and cwd colors", () => {
        const codexModel = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const codexProvider = defineProvider({
            id: "codex",
            models: [codexModel],
            stream() {
                return streamText("unused");
            },
        });
        const codexHarness = createJustBashToolHarness();
        const codexAgent = new Agent({
            provider: codexProvider,
            modelId: codexModel.id,
            context: codexHarness.context,
            printToConsole: false,
        });
        const codexApp = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: codexAgent,
            cwd: codexHarness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        const codexRaw = codexApp.render(80).join("\n");
        expect(codexRaw).toContain("\x1b[33mgpt-test off");
        expect(codexRaw).toContain("\x1b[32m/workspace");
        expect(stripAnsi(codexRaw)).toContain("gpt-test off · /workspace · full access");

        const claudeModel = defineModel({
            id: "claude-sonnet-test",
            name: "Claude Sonnet",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const claudeProvider = defineProvider({
            id: "anthropic",
            models: [claudeModel],
            stream() {
                return streamText("unused");
            },
        });
        const claudeHarness = createJustBashToolHarness();
        const claudeAgent = new Agent({
            provider: claudeProvider,
            modelId: claudeModel.id,
            context: claudeHarness.context,
            printToConsole: false,
        });
        const claudeApp = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: claudeAgent,
            cwd: claudeHarness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        const claudeRaw = claudeApp.render(80).join("\n");
        expect(claudeRaw).toContain("\x1b[33mclaude-sonnet-test off");
        expect(claudeRaw).toContain("\x1b[32m/workspace");
    });

    it("keeps a differentiating non-default agent identity in the footer", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            activeAgentLabel: "Audit startup state [subagent]",
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "gpt-test off · /workspace · Audit startup state [subagent] · full access",
        );

        const constrained = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            activeAgentLabel: `${"Very long delegated identity ".repeat(20)}\n\x1b[31munsafe`,
            agent: new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        const constrainedFooter =
            constrained
                .render(60)
                .map(stripAnsi)
                .find((line) => line.includes("full access")) ?? "";
        expect(constrainedFooter).toContain("full access");
        expect(constrainedFooter).not.toContain("\n");
        expect(constrainedFooter).not.toContain("unsafe");
        expect(visibleWidth(constrainedFooter)).toBeLessThanOrEqual(60);
    });

    it("uses the model id without vendor as the displayed model name", () => {
        const model = defineModel({
            id: "openai/gpt-5.5",
            name: "GPT-5.5",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("Model: GPT-5.5");
        expect(rendered).toContain("gpt-5.5 off · /workspace");
        expect(rendered).not.toContain("gpt-5-5");
        expect(rendered).not.toContain("reasoning off");
    });

    it("changes reasoning with Codex-style shortcuts", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off", "low", "medium", "high"],
            defaultThinkingLevel: "low",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            serviceTiers: ["fast"],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
            serviceTier: "fast",
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        expect(stripAnsi(app.render(80).join("\n"))).toContain("gpt-test low");

        app.handleInput("\x1b.");
        expect(agent.snapshot().effort).toBe("medium");
        expect(stripAnsi(app.render(80).join("\n"))).toContain("gpt-test medium");

        app.handleInput("\x1b,");
        expect(agent.snapshot().effort).toBe("low");

        app.handleInput("\x1b[1;2A");
        expect(agent.snapshot().effort).toBe("medium");

        app.handleInput("\x1b[1;2B");
        expect(agent.snapshot().effort).toBe("low");
        expect(defaultModelChanges).toHaveLength(4);
        expect(defaultModelChanges.at(-1)).toEqual({
            effort: "low",
            modelId: model.id,
            providerId: "codex",
            serviceTier: "fast",
        });
    });

    it("replaces the composer with a two-step model and reasoning menu", () => {
        const smallModel = defineModel({
            id: "openai/gpt-small",
            name: "GPT Small",
            thinkingLevels: ["low", "medium"],
            defaultThinkingLevel: "low",
        });
        const proModel = defineModel({
            id: "openai/gpt-pro",
            name: "GPT Pro",
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
        });
        const provider = defineProvider({
            id: "codex",
            models: [smallModel, proModel],
            serviceTiers: ["fast"],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: smallModel.id,
            context: harness.context,
            printToConsole: false,
            serviceTier: "fast",
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/model");

        const modelMenuLines = app.render(80);
        const modelMenu = stripAnsi(modelMenuLines.join("\n"));
        const modelMenuTitle = modelMenuLines.find((line) =>
            stripAnsi(line).includes("Choose Model"),
        );
        const selectedModelLine = modelMenuLines.find((line) =>
            stripAnsi(line).includes("→ GPT Small"),
        );
        expect(modelMenu).toContain("Choose Model");
        expect(modelMenuTitle).toContain("\x1b[48;5;235m");
        expect(stripAnsi(modelMenuTitle ?? "")).toContain("Choose Model");
        expect(stripAnsi(modelMenuTitle ?? "")).not.toContain("›");
        expect(stripAnsi(modelMenuTitle ?? "")).not.toContain("│");
        expect(selectedModelLine).toContain("\x1b[38;5;202m");
        expect(selectedModelLine).not.toContain("\x1b[1m");
        expect(modelMenu).toContain("GPT Small");
        expect(modelMenu).toContain("GPT Pro");
        expect(modelMenu).toContain("Current model");
        expect(modelMenu).toContain("Codex model");
        expect(modelMenu).toContain("Default reasoning: Low");
        expect(modelMenu).not.toContain("Available model");
        expect(modelMenu).toContain("Use ↑/↓ to move, Enter to select, Esc to cancel.");
        expect(modelMenu).not.toContain("Ask Rig to do anything");

        app.handleInput("\x1b[B");
        app.handleInput("\r");

        const reasoningMenu = stripAnsi(app.render(80).join("\n"));
        expect(reasoningMenu).toContain("Choose Reasoning");
        expect(reasoningMenu).toContain("GPT Pro");
        expect(reasoningMenu).toContain("Low");
        expect(reasoningMenu).toContain("High");
        expect(reasoningMenu).toContain("Use light reasoning for simple coding tasks.");
        expect(reasoningMenu).toContain("Spend more time on harder changes.");
        expect(reasoningMenu).not.toContain("Ask Rig to do anything");

        app.handleInput("\x1b[B");
        app.handleInput("\r");

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(agent.model.id).toBe(proModel.id);
        expect(agent.snapshot().effort).toBe("high");
        expect(defaultModelChanges).toEqual([
            {
                modelId: proModel.id,
                providerId: "codex",
                effort: "high",
                serviceTier: "fast",
            },
        ]);
        expect(rendered).toContain("gpt-pro high");
        expect(rendered).toContain("• Model Model changed to GPT Pro with High reasoning.");
        expect(rendered).toContain("Model changed to GPT Pro with High reasoning.");
        expect(rendered).toContain("Ask Rig to do anything");
    });

    it("uses the available fullscreen height before scrolling a model menu", () => {
        const models = Array.from({ length: 12 }, (_, index) =>
            defineModel({
                id: `openai/gpt-${index + 1}`,
                name: `GPT ${index + 1}`,
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            }),
        );
        const firstModel = models[0]!;
        const provider = defineProvider({
            id: "codex",
            models,
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: firstModel.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui({ rows: 20 }),
        });

        submit(app, "/model");

        const modelMenu = stripAnsi(app.render(80).join("\n"));
        expect(modelMenu).toContain("GPT 12");
        expect(modelMenu).not.toContain("(1/12)");
    });

    it("shows Bedrock-only models and sends their provider from the TUI picker", async () => {
        const gpt = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const bedrockOnly = defineModel({
            id: "anthropic/bedrock-only",
            name: "Bedrock Only",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const catalog: ModelCatalog = {
            defaultModelId: gpt.id,
            defaultProviderId: "codex",
            models: [gpt, bedrockOnly],
            providers: [
                { providerId: "codex", models: [gpt] },
                { providerId: "bedrock", models: [gpt, bedrockOnly] },
            ],
        };
        const snapshot = {
            id: "agent-1",
            messages: [],
            modelId: gpt.id,
            providerId: "codex",
            queue: [],
            status: "idle" as const,
            tools: [],
        };
        const session: ProtocolSession = {
            activity: { kind: "idle", label: "Idle", since: 0 },
            agent: {
                depth: 0,
                rootSessionId: "session-1",
                type: "primary",
            },
            archived: false,
            id: "session-1",
            projectId: "project-1",
            scope: { kind: "project", projectId: "project-1" },
            orderKey: "a0",
            agentId: snapshot.id,
            ownerInstanceId: "alocalinstance00000000001",
            cwd: "/workspace",
            modelId: gpt.id,
            modelLocked: false,
            modelCatalog: catalog,
            models: [gpt],
            providerId: "codex",
            permissionMode: "workspace_write",
            mcpServers: [],
            pendingUserInputs: [],
            projectSecretIds: [],
            secretIds: [],
            sessionSecretIds: [],
            tasks: [],
            snapshot,
            status: "idle",
            titleStatus: "idle",
        };
        const bedrockSession: ProtocolSession = {
            ...session,
            modelId: bedrockOnly.id,
            models: [gpt, bedrockOnly],
            providerId: "bedrock",
            snapshot: {
                ...snapshot,
                modelId: bedrockOnly.id,
                providerId: "bedrock",
            },
        };
        const changeModel = vi.fn(async () => ({ session: bedrockSession }));
        const client = { changeModel } as unknown as ProtocolHttpClient;
        const harness = createJustBashToolHarness();
        const agent = new RemoteAgent({
            client,
            context: harness.context,
            modelCatalog: catalog,
            session,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/model");

        const modelMenu = stripAnsi(app.render(100).join("\n"));
        expect(modelMenu).toContain("Bedrock Only");
        expect(modelMenu).toContain("Amazon Bedrock model");

        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\r");

        await vi.waitFor(() =>
            expect(changeModel).toHaveBeenCalledWith("session-1", {
                effort: "off",
                modelId: bedrockOnly.id,
                providerId: "bedrock",
            }),
        );
        await vi.waitFor(() => expect(agent.provider.id).toBe("bedrock"));
        expect(agent.model.id).toBe(bedrockOnly.id);
    });

    it("rolls back a rejected provider change without persisting cleared fast mode", async () => {
        const codexModel = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const claudeModel = defineModel({
            id: "anthropic/claude-test",
            name: "Claude Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const catalog: ModelCatalog = {
            defaultModelId: codexModel.id,
            defaultProviderId: "codex",
            models: [codexModel, claudeModel],
            providers: [
                { providerId: "codex", models: [codexModel], serviceTiers: ["fast"] },
                { providerId: "claude", models: [claudeModel] },
            ],
        };
        const snapshot = {
            id: "agent-1",
            messages: [],
            modelId: codexModel.id,
            providerId: "codex",
            queue: [],
            serviceTier: "fast" as const,
            status: "idle" as const,
            tools: [],
        };
        const session: ProtocolSession = {
            activity: { kind: "idle", label: "Idle", since: 0 },
            agent: { depth: 0, rootSessionId: "session-1", type: "primary" },
            agentId: snapshot.id,
            ownerInstanceId: "alocalinstance00000000001",
            archived: false,
            cwd: "/workspace",
            id: "session-1",
            projectId: "project-1",
            scope: { kind: "project", projectId: "project-1" },
            orderKey: "a0",
            modelId: codexModel.id,
            modelLocked: false,
            modelCatalog: catalog,
            models: [codexModel],
            permissionMode: "workspace_write",
            mcpServers: [],
            pendingUserInputs: [],
            projectSecretIds: [],
            secretIds: [],
            sessionSecretIds: [],
            providerId: "codex",
            serviceTier: "fast",
            snapshot,
            status: "idle",
            tasks: [],
            titleStatus: "idle",
        };
        const changeModel = vi.fn().mockRejectedValue(new Error("provider unavailable"));
        const agent = new RemoteAgent({
            client: { changeModel } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: catalog,
            session,
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: "/workspace",
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "/model");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\r");

        expect(agent.provider.id).toBe("claude");
        expect(agent.snapshot().serviceTier).toBeUndefined();
        await vi.waitFor(() =>
            expect(stripAnsi(app.render(100).join("\n"))).toContain(
                "Could not change to Claude Test: provider unavailable",
            ),
        );
        expect(agent.provider.id).toBe("codex");
        expect(agent.snapshot().serviceTier).toBe("fast");
        expect(defaultModelChanges).toEqual([]);
        expect(stripAnsi(app.render(100).join("\n"))).toContain("gpt-test off fast ·");
    });

    it("does not persist a rejected fast tier through a later model change", async () => {
        const firstModel = defineModel({
            id: "openai/gpt-first",
            name: "GPT First",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const secondModel = defineModel({
            id: "openai/gpt-second",
            name: "GPT Second",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const catalog: ModelCatalog = {
            defaultModelId: firstModel.id,
            defaultProviderId: "codex",
            models: [firstModel, secondModel],
            providers: [
                {
                    providerId: "codex",
                    models: [firstModel, secondModel],
                    serviceTiers: ["fast"],
                },
            ],
        };
        const snapshot = {
            id: "agent-1",
            messages: [],
            modelId: firstModel.id,
            providerId: "codex",
            queue: [],
            status: "idle" as const,
            tools: [],
        };
        const session: ProtocolSession = {
            activity: { kind: "idle", label: "Idle", since: 0 },
            agent: { depth: 0, rootSessionId: "session-1", type: "primary" },
            agentId: snapshot.id,
            ownerInstanceId: "alocalinstance00000000001",
            archived: false,
            cwd: "/workspace",
            id: "session-1",
            projectId: "project-1",
            scope: { kind: "project", projectId: "project-1" },
            orderKey: "a0",
            modelId: firstModel.id,
            modelLocked: false,
            modelCatalog: catalog,
            models: [firstModel, secondModel],
            permissionMode: "workspace_write",
            mcpServers: [],
            pendingUserInputs: [],
            projectSecretIds: [],
            secretIds: [],
            sessionSecretIds: [],
            providerId: "codex",
            snapshot,
            status: "idle",
            tasks: [],
            titleStatus: "idle",
        };
        const changedSession: ProtocolSession = {
            ...session,
            modelId: secondModel.id,
            snapshot: { ...snapshot, modelId: secondModel.id },
        };
        let resolveModelChange!: (value: { session: ProtocolSession }) => void;
        const modelChange = new Promise<{ session: ProtocolSession }>((resolve) => {
            resolveModelChange = resolve;
        });
        const changeModel = vi.fn(() => modelChange);
        const changeServiceTier = vi.fn().mockRejectedValue(new Error("fast unavailable"));
        const agent = new RemoteAgent({
            client: { changeModel, changeServiceTier } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: catalog,
            session,
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: "/workspace",
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "/fast on");
        submit(app, "/model");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\r");

        expect(agent.model.id).toBe(secondModel.id);
        expect(agent.snapshot().serviceTier).toBe("fast");
        await vi.waitFor(() => expect(changeModel).toHaveBeenCalledOnce());
        expect(agent.snapshot().serviceTier).toBeUndefined();
        resolveModelChange({ session: changedSession });
        await vi.waitFor(() =>
            expect(stripAnsi(app.render(100).join("\n"))).toContain(
                "Could not turn fast mode on: fast unavailable",
            ),
        );
        await vi.waitFor(() => expect(defaultModelChanges).toHaveLength(1));
        expect(agent.model.id).toBe(secondModel.id);
        expect(agent.snapshot().serviceTier).toBeUndefined();
        expect(defaultModelChanges).toEqual([
            {
                effort: "off",
                modelId: secondModel.id,
                providerId: "codex",
                serviceTier: null,
            },
        ]);
    });

    it("keeps model choices visible but locked during an active response", () => {
        const smallModel = defineModel({
            id: "openai/gpt-small",
            name: "GPT Small",
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
        });
        const proModel = defineModel({
            id: "openai/gpt-pro",
            name: "GPT Pro",
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
        });
        const provider = defineProvider({
            id: "codex",
            models: [smallModel, proModel],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: smallModel.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            modelLocked: true,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/model");

        const modelMenu = stripAnsi(app.render(100).join("\n"));
        expect(modelMenu).toContain("Choose Model");
        expect(modelMenu).toContain("Wait for the active response to finish");
        expect(modelMenu).toContain("GPT Small");
        expect(modelMenu).toContain("GPT Pro");
        expect(modelMenu).toContain("Unavailable while running");

        app.handleInput("\x1b[B");
        app.handleInput("\r");

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(agent.model.id).toBe(smallModel.id);
        expect(rendered).toContain(
            "Wait for the active response to finish before changing models.",
        );
    });

    it("changes only reasoning from the effort command", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["low", "high"],
            defaultThinkingLevel: "low",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/ford");

        const effortMenu = stripAnsi(app.render(100).join("\n"));
        expect(effortMenu).toContain("Choose Reasoning");
        expect(effortMenu).toContain("GPT Test");

        app.handleInput("\x1b[B");
        app.handleInput("\r");

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(agent.model.id).toBe(model.id);
        expect(agent.snapshot().effort).toBe("high");
        expect(defaultModelChanges).toEqual([
            {
                effort: "high",
                modelId: model.id,
                providerId: "codex",
                serviceTier: null,
            },
        ]);
        expect(rendered).toContain("Reasoning changed to High.");
    });

    it("toggles supported fast inference and shows it in the footer", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["ultra"],
            defaultThinkingLevel: "ultra",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            serviceTiers: ["fast"],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/fast");

        expect(agent.snapshot().serviceTier).toBe("fast");
        let rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain(
            "• Fast mode Fast mode is on. Fast inference uses 2× plan usage.",
        );
        expect(rendered).toContain("Fast mode is on. Fast inference uses 2× plan usage.");
        expect(rendered).toContain("gpt-test ultra fast · /workspace · full access");

        submit(app, "/fast status");
        rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Fast mode is on.");

        submit(app, "/fast off");

        expect(agent.snapshot().serviceTier).toBeUndefined();
        rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Fast mode is off.");
        expect(rendered).toContain("gpt-test ultra · /workspace · full access");
        expect(rendered).not.toContain("gpt-test ultra fast ·");
        submit(app, "/fast turbo");
        rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Usage: /fast [on|off|status]");
        expect(defaultModelChanges).toEqual([
            {
                effort: "ultra",
                modelId: model.id,
                providerId: "codex",
                serviceTier: "fast",
            },
            {
                effort: "ultra",
                modelId: model.id,
                providerId: "codex",
                serviceTier: null,
            },
        ]);
    });

    it("keeps rapid fast config writes ordered with the final toggle", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["ultra"],
            defaultThinkingLevel: "ultra",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            serviceTiers: ["fast"],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const enqueueWrite = createSerialTaskQueue();
        const writes: Array<"fast" | null> = [];
        let releaseFirstWrite!: () => void;
        const firstWriteGate = new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onDefaultModelChange: (preference) =>
                enqueueWrite(async () => {
                    if (preference.serviceTier === "fast") {
                        await firstWriteGate;
                    }
                    writes.push(preference.serviceTier);
                }),
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/fast on");
        submit(app, "/fast off");

        expect(agent.snapshot().serviceTier).toBeUndefined();
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("gpt-test ultra fast ·");
        releaseFirstWrite();
        await vi.waitFor(() => expect(writes).toEqual(["fast", null]));
    });

    it("rolls back a rejected fast change without persisting it", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["ultra"],
            defaultThinkingLevel: "ultra",
        });
        const snapshot = {
            id: "agent-1",
            messages: [],
            modelId: model.id,
            providerId: "codex",
            queue: [],
            status: "idle" as const,
            tools: [],
        };
        const session: ProtocolSession = {
            activity: { kind: "idle", label: "Idle", since: 0 },
            agent: { depth: 0, rootSessionId: "session-1", type: "primary" },
            agentId: snapshot.id,
            ownerInstanceId: "alocalinstance00000000001",
            archived: false,
            cwd: "/workspace",
            id: "session-1",
            projectId: "project-1",
            scope: { kind: "project", projectId: "project-1" },
            orderKey: "a0",
            modelId: model.id,
            modelLocked: false,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ models: [model], providerId: "codex" }],
            },
            models: [model],
            permissionMode: "workspace_write",
            mcpServers: [],
            pendingUserInputs: [],
            projectSecretIds: [],
            secretIds: [],
            sessionSecretIds: [],
            providerId: "codex",
            snapshot,
            status: "idle",
            tasks: [],
            titleStatus: "idle",
        };
        const changeServiceTier = vi.fn().mockRejectedValue(new Error("daemon unavailable"));
        const agent = new RemoteAgent({
            client: { changeServiceTier } as unknown as ProtocolHttpClient,
            context: createJustBashToolHarness().context,
            modelCatalog: {
                defaultModelId: model.id,
                defaultProviderId: "codex",
                models: [model],
                providers: [{ models: [model], providerId: "codex", serviceTiers: ["fast"] }],
            },
            session,
        });
        const defaultModelChanges: Array<{
            effort: string;
            modelId: string;
            providerId: string;
            serviceTier: "fast" | null;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: "/workspace",
            onDefaultModelChange: (preference) => {
                defaultModelChanges.push(preference);
            },
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        submit(app, "/fast on");
        expect(agent.snapshot().serviceTier).toBe("fast");

        await vi.waitFor(() =>
            expect(stripAnsi(app.render(100).join("\n"))).toContain(
                "Could not turn fast mode on: daemon unavailable",
            ),
        );
        expect(agent.snapshot().serviceTier).toBeUndefined();
        expect(defaultModelChanges).toEqual([]);
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("gpt-test ultra fast ·");
    });

    it("only offers fast inference for providers that support it", async () => {
        const model = defineModel({
            id: "claude-test",
            name: "Claude Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const stream = vi.fn();
        const provider = defineProvider({
            id: "anthropic",
            models: [model],
            stream() {
                stream();
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/fast on");

        expect(agent.snapshot().serviceTier).toBeUndefined();
        expect(stream).not.toHaveBeenCalled();
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Fast inference is not available with Claude Test.",
        );

        app.focused = true;
        app.handleInput("/f");
        await delay(30);
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("/fast");
    });

    it("offers the fast command with a clear plan-usage description", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            serviceTiers: ["fast"],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        app.handleInput("/f");
        await delay(30);

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("/fast");
        expect(rendered).toContain("Toggle fastest inference at 2× plan usage.");
    });

    it("renders service-tier changes received from a session", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            serviceTiers: ["fast"],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        agent.setServiceTier("fast");

        app.applySessionEvent({
            createdAt: 1,
            data: {
                changed: ["serviceTier"],
                modelId: "gpt-test",
                providerId: agent.snapshot().providerId,
                serviceTier: "fast",
            },
            id: "event-fast",
            sessionId: "session-1",
            type: "session_configuration_changed",
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Fast mode is on. Fast inference uses 2× plan usage.");
        expect(rendered).toContain("gpt-test off fast · /workspace");
    });

    it("opens the model menu with Alt+M", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        app.handleInput("\x1bm");

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("Choose Model");
        expect(rendered).not.toContain("Ask Rig to do anything");
    });

    it("shows slash command autocomplete with command descriptions", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        app.focused = true;
        app.handleInput("/");
        await delay(30);

        const rawLines = app.render(80);
        const rendered = stripAnsi(rawLines.join("\n"));
        const commandLine = rawLines.find((line) => stripAnsi(line).includes("/model"));
        expect(commandLine).not.toContain("\x1b[48;5;235m");
        expect(commandLine).toContain("\x1b[38;5;202m");
        expect(commandLine).not.toContain("\x1b[1m");
        expect(rendered).toContain("/model");
        expect(rendered).toContain("Choose the model and reasoning level.");
        expect(rendered).toContain("/context");
        expect(rendered).toContain("Add background context for the next request.");
        expect(rendered).toContain("/effort");
        expect(rendered).toContain("Change reasoning for this session.");
        expect(rendered).toContain("/configure");
        expect(rendered).toContain("Configure app settings.");
        expect(rendered).toContain("/permissions");
        expect(rendered).toContain("Choose filesystem, shell, and network access.");
        expect(rendered).toContain("/mcp");
        expect(rendered).toContain("Show configured MCP server connections.");
        expect(rendered).not.toContain("GPT Test Off •");
        expect(rendered).not.toContain("/quit");

        app.handleInput("t");
        const taskCommands = stripAnsi(app.render(80).join("\n"));
        expect(taskCommands).toContain("/tasks");
        expect(taskCommands).toContain("Show the current session task list.");
        app.handleInput("\x7f");

        app.handleInput("\r");
        const modelPicker = stripAnsi(app.render(80).join("\n"));
        expect(modelPicker).toContain("Choose Model");
        expect(modelPicker).not.toContain("/model");
    });

    it("shows MCP connection diagnostics from the mcp command", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            initialMcpServers: [
                { name: "docs", status: "connected", toolCount: 2 },
                {
                    errorMessage: "This MCP server is not trusted on this machine.",
                    name: "project helper",
                    status: "blocked",
                    toolCount: 0,
                },
                {
                    errorMessage: "The server process exited.",
                    name: "issues",
                    status: "failed",
                    toolCount: 0,
                },
            ],
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/mcp");

        const rendered = stripAnsi(app.render(100).join("\n"));
        const normalized = rendered.replace(/\s+/gu, " ");
        expect(normalized).toContain("docs: connected with 2 tools");
        expect(normalized).toContain(
            "project helper: blocked — This MCP server is not trusted on this machine.",
        );
        expect(normalized).toContain("issues: could not connect — The server process exited.");

        app.applySessionEvent({
            createdAt: 1,
            data: {
                servers: [
                    {
                        errorMessage:
                            "MCP servers are available in Auto or Full access because they can act outside Rig's sandbox.",
                        name: "openai_developer_docs",
                        status: "blocked",
                        toolCount: 0,
                    },
                    {
                        errorMessage: "This MCP server is not trusted on this machine.",
                        name: "posthog",
                        status: "blocked",
                        toolCount: 0,
                    },
                ],
            },
            id: "mcp-blocked",
            sessionId: "session-1",
            type: "mcp_servers_changed",
        });
        const wideRows = stripAnsi(app.render(160).join("\n"))
            .split("\n")
            .map((row) => row.trimEnd());
        const wideParent = wideRows.findIndex((row) => row === "• MCP servers blocked");
        expect(wideRows.slice(wideParent, wideParent + 3)).toEqual([
            "• MCP servers blocked",
            "  └ OpenAI Developer Docs — MCP servers are available in Auto or Full access because they can act outside Rig's sandbox.",
            "    PostHog — This MCP server is not trusted on this machine.",
        ]);

        const narrowRows = stripAnsi(app.render(52).join("\n"))
            .split("\n")
            .map((row) => row.trimEnd());
        const narrowParent = narrowRows.findIndex((row) => row === "• MCP servers blocked");
        expect(narrowRows.slice(narrowParent, narrowParent + 6)).toEqual([
            "• MCP servers blocked",
            "  └ OpenAI Developer Docs — MCP servers are",
            "    available in Auto or Full access because they",
            "    can act outside Rig's sandbox.",
            "    PostHog — This MCP server is not trusted on this",
            "    machine.",
        ]);
        expect(narrowRows.every((row) => visibleWidth(row) <= 52)).toBe(true);
        expect(narrowRows.slice(narrowParent, narrowParent + 6).join("\n")).not.toMatch(/[│├↳]/u);

        app.applySessionEvent({
            createdAt: 2,
            data: {
                servers: [
                    {
                        errorMessage:
                            "MCP servers are available in Auto or Full access because they can act outside Rig's sandbox.",
                        name: "Trusted Helper",
                        status: "blocked",
                        toolCount: 0,
                    },
                ],
            },
            id: "mcp-permission-blocked",
            sessionId: "session-1",
            type: "mcp_servers_changed",
        });
        const permissionBlocked = stripAnsi(app.render(100).join("\n")).replace(/\s+/gu, " ");
        expect(permissionBlocked).toContain("OpenAI Developer Docs");
        expect(permissionBlocked).toContain("PostHog");
        expect(permissionBlocked).toContain(
            "Trusted Helper — MCP servers are available in Auto or Full access because they can act outside Rig's sandbox.",
        );
    });

    it("shows authoritative plugin log truncation without marking complete logs", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const readLog = vi
            .fn<PluginContext["readLog"]>()
            .mockResolvedValueOnce({
                folder: "truncated-plugin",
                name: "Truncated plugin",
                source: "current_run",
                status: "running",
                text: "TRUNCATED_LOG_TAIL",
                truncated: true,
                updatedAt: 1,
            })
            .mockResolvedValueOnce({
                folder: "complete-plugin",
                name: "Complete plugin",
                source: "current_run",
                status: "stopped",
                text: "COMPLETE_LOG_OUTPUT",
                truncated: false,
                updatedAt: 2,
            });
        const plugins: PluginContext = {
            async callAppTool() {
                throw new Error("Unused in this test.");
            },
            async discoverRepository() {
                throw new Error("Unused in this test.");
            },
            async install() {
                throw new Error("Unused in this test.");
            },
            async installFromGitHub() {
                throw new Error("Unused in this test.");
            },
            async loadSkills() {
                return [];
            },
            async list() {
                return {
                    failures: [],
                    plugins: [],
                    version: "01900000-0000-7000-8000-000000000001",
                };
            },
            readAppResource() {
                throw new Error("Unused in this test.");
            },
            async readIcon() {
                throw new Error("Unused in this test.");
            },
            readLog,
            async storageDelete() {},
            async storageGet() {
                return undefined;
            },
            async storageList() {
                return [];
            },
            async storageSet() {},
            async uninstall() {
                throw new Error("Unused in this test.");
            },
        };
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: { ...harness.context, plugins },
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/plugins Truncated plugin");
        await vi.waitFor(() =>
            expect(stripAnsi(app.render(100).join("\n"))).toContain("TRUNCATED_LOG_TAIL"),
        );
        const truncated = stripAnsi(app.render(100).join("\n"));
        expect(truncated.replace(/\s+/gu, " ")).toContain(
            "[Earlier plugin output omitted.] TRUNCATED_LOG_TAIL",
        );

        submit(app, "/plugins Complete plugin");
        let complete = "";
        await vi.waitFor(() => {
            const rendered = stripAnsi(app.render(100).join("\n"));
            expect(rendered).toContain("COMPLETE_LOG_OUTPUT");
            complete = rendered;
        });
        const completeEntry = complete.slice(complete.lastIndexOf("Complete plugin · Stopped"));
        expect(completeEntry).toContain("COMPLETE_LOG_OUTPUT");
        expect(completeEntry).not.toContain("[Earlier plugin output omitted.]");
        expect(complete.match(/\[Earlier plugin output omitted\.\]/gu)).toHaveLength(1);
        expect(readLog).toHaveBeenNthCalledWith(1, expect.anything(), "Truncated plugin");
        expect(readLog).toHaveBeenNthCalledWith(2, expect.anything(), "Complete plugin");
    });

    it("shows persisted task progress from the tasks command", () => {
        const model = defineModel({
            id: "anthropic/test",
            name: "Claude Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "claude",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            initialTasks: [
                {
                    blockedBy: [],
                    blocks: [],
                    description: "Implement it.",
                    id: "1",
                    status: "in_progress",
                    subject: "Build the feature",
                },
                {
                    blockedBy: ["1"],
                    blocks: [],
                    description: "Test it.",
                    id: "2",
                    status: "pending",
                    subject: "Verify the feature",
                },
            ],
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/tasks");

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("#1 · In progress · Build the feature");
        expect(rendered).toContain("#2 · Pending · Verify the feature");
    });

    it("shows delegated work status from the agents command", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            initialSubagents: [
                {
                    agentId: "agent-2",
                    createdAt: 1,
                    depth: 1,
                    description: "Inspect the implementation",
                    elapsedMs: 60_000,
                    id: "subagent-1",
                    modelId: model.id,
                    parentSessionId: "session-1",
                    status: "running",
                    taskName: "inspect_implementation",
                    totalTokens: 1_000,
                    updatedAt: 1,
                },
            ],
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                subagent: {
                    agentId: "agent-2",
                    createdAt: 1,
                    depth: 1,
                    description: "Inspect the implementation",
                    elapsedMs: 65_000,
                    id: "subagent-1",
                    modelId: model.id,
                    parentSessionId: "session-1",
                    status: "completed",
                    taskName: "inspect_implementation",
                    totalTokens: 1_250,
                    updatedAt: 2,
                },
            },
            id: "event-1",
            sessionId: "session-1",
            type: "subagent_changed",
        });

        const statusTransition = stripAnsi(app.render(100).join("\n"));
        expect(statusTransition).not.toContain("agent running · /agents to view");
        expect(statusTransition.split("\n").map((line) => line.trimEnd())).toEqual(
            expect.arrayContaining([
                "• Background work",
                '  └ "Inspect the implementation" completed in 1m 5s · 1.3k context tokens.',
            ]),
        );
        app.applySessionEvent({
            createdAt: 3,
            data: {
                displayText: 'Background work "Inspect the implementation" completed.',
                message: {
                    blocks: [{ text: "<subagent-notification>", type: "text" }],
                    id: "notification-1",
                    role: "user",
                },
                runId: "notification-run-1",
                source: "notification",
            },
            id: "event-2",
            sessionId: "session-1",
            type: "message_submitted",
        });
        const completed = stripAnsi(app.render(100).join("\n"));
        expect(completed).not.toContain("agent running · /agents to view");
        expect(completed.match(/"Inspect the implementation" completed/gu)).toHaveLength(1);

        submit(app, "/agents");

        expect(
            stripAnsi(app.render(100).join("\n"))
                .split("\n")
                .map((line) => line.trimEnd()),
        ).toEqual(
            expect.arrayContaining([
                "  Subagents",
                "  → Completed · Inspect the implementation · GPT Test · 1.3k context tokens · 1m 5s",
            ]),
        );
    });

    it("includes every descendant's session token count in the opt-in status", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const parentUsage: Usage = {
            cacheRead: 100,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 900,
            output: 100,
            totalTokens: 1_100,
        };
        const parentEvent: SessionEvent = {
            createdAt: 4,
            data: {
                message: {
                    blocks: [{ text: "Parent complete.", type: "text" }],
                    id: "parent-response",
                    providerId: "codex",
                    requestedModelId: model.id,
                    role: "agent",
                    usage: parentUsage,
                },
                runId: "parent-run",
            },
            id: "parent-message",
            sessionId: "session-1",
            type: "agent_message",
        };
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            cwd: harness.context.fs.cwd,
            initialSessionEvents: [parentEvent],
            initialSubagents: [
                {
                    agentId: "agent-child",
                    createdAt: 1,
                    depth: 1,
                    description: "Cross-provider child",
                    id: "subagent-child",
                    modelId: "anthropic/sonnet-5",
                    parentSessionId: "session-1",
                    sessionTokenCount: { lastContextTokens: 1_000, totalTokens: 1_000 },
                    status: "completed",
                    updatedAt: 2,
                    usage: {
                        cacheRead: 900,
                        cacheWrite: 0,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 100,
                        output: 0,
                        totalTokens: 1_000,
                    },
                },
                {
                    agentId: "agent-nested",
                    createdAt: 2,
                    depth: 2,
                    description: "Nested child",
                    id: "subagent-nested",
                    modelId: "xai/grok-build",
                    parentSessionId: "subagent-child",
                    sessionTokenCount: { lastContextTokens: 1_200, totalTokens: 1_200 },
                    status: "completed",
                    updatedAt: 3,
                    usage: {
                        cacheRead: 0,
                        cacheWrite: 100,
                        cost: {
                            cacheRead: 0,
                            cacheWrite: 0,
                            input: 0,
                            output: 0,
                            total: 0,
                        },
                        input: 1_000,
                        output: 100,
                        totalTokens: 1_200,
                    },
                },
            ],
            initialSessionTokenCount: { lastContextTokens: 1_100, totalTokens: 1_100 },
            initialUsage: parentUsage,
            initialUsageEventId: parentEvent.id,
            processManager: new NativeProcessManager(),
            showUsage: true,
            tui: fakeTui(),
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain("3.3k tokens · 32% cache hit");
    });

    it("shows context tokens from active subagents only in the live summary", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            initialSubagents: [
                {
                    agentId: "agent-completed",
                    createdAt: 1,
                    depth: 1,
                    description: "Historical task",
                    elapsedMs: 60_000,
                    id: "subagent-completed",
                    modelId: model.id,
                    parentSessionId: "session-1",
                    status: "completed",
                    taskName: "historical_task",
                    totalTokens: 6_000_000,
                    updatedAt: 2,
                },
                {
                    activeSince: 2,
                    agentId: "agent-running",
                    createdAt: 2,
                    depth: 1,
                    description: "Current task",
                    elapsedMs: 0,
                    id: "subagent-running",
                    modelId: model.id,
                    parentSessionId: "session-1",
                    status: "running",
                    taskName: "current_task",
                    totalTokens: 100_000,
                    updatedAt: 2,
                },
            ],
            now: () => 2,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        const rendered = stripAnsi(app.render(120).join("\n"));
        expect(rendered).toContain("1 agent running · /agents to view · 0s · 100k context tokens");
        expect(rendered).not.toContain("6.1m context tokens");
    });

    it("starts and manages a persistent goal from slash commands", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        let goal:
            | {
                  createdAt: number;
                  objective: string;
                  status: "active" | "blocked" | "complete" | "paused";
                  updatedAt: number;
              }
            | undefined;
        const setGoal = vi.fn(async (objective: string) => {
            goal = { createdAt: 1, objective, status: "active", updatedAt: 1 };
        });
        const changeGoalStatus = vi.fn(
            async (status: "active" | "blocked" | "complete" | "paused") => {
                if (goal !== undefined) goal = { ...goal, status, updatedAt: 2 };
            },
        );
        const clearGoal = vi.fn(async () => {
            goal = undefined;
        });
        Object.defineProperties(agent, {
            changeGoalStatus: { value: changeGoalStatus },
            clearGoal: { value: clearGoal },
            goal: { get: () => goal },
            setGoal: { value: setGoal },
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/goal Ship a verified release");
        await vi.waitFor(() => expect(setGoal).toHaveBeenCalledWith("Ship a verified release"));
        submit(app, "/goal");
        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Status: Active");
        expect(rendered).toContain("Objective: Ship a verified release");

        submit(app, "/goal pause");
        await vi.waitFor(() => expect(changeGoalStatus).toHaveBeenCalledWith("paused"));
        submit(app, "/goal clear");
        await vi.waitFor(() => expect(clearGoal).toHaveBeenCalledOnce());
    });

    it("compacts conversation history from the compact command", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) => completedCompaction(context),
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Do the work." }],
                },
                {
                    role: "agent",
                    id: "agent-1",
                    blocks: [{ type: "text", text: "The work is done." }],
                },
            ],
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        const compact = vi.spyOn(agent, "compact");

        for (const character of "/compact") app.handleInput(character);
        app.handleInput("\r");
        const compaction = compact.mock.results[0];
        expect(compaction?.type).toBe("return");
        if (compaction?.type !== "return") throw new Error("Compaction did not start.");
        await compaction.value;

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("Context compacted");
        expect(rendered).toContain("Summarized 2 older messages;");
        expect(rendered).toMatch(/The full\s+transcript remains visible\./u);
        expect(agent.snapshot().messages).toHaveLength(3);
        expect(agent.snapshot().messages.at(-1)).toMatchObject({
            role: "compaction",
            replacedMessageIds: expect.any(Array),
        });
        expect(agent.snapshot().contextMessages).toHaveLength(1);
    });

    it("animates manual conversation compaction only while it is running", async () => {
        vi.useFakeTimers();
        try {
            const model = defineModel({
                id: "openai/gpt-test",
                name: "GPT Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const started = deferred<void>();
            const release = deferred<void>();
            const provider = defineProvider({
                id: "codex",
                models: [model],
                compact: async (_ctx, { context }) => {
                    started.resolve();
                    await release.promise;
                    return completedCompaction(context);
                },
                stream() {
                    return streamText("unused");
                },
            });
            const harness = createJustBashToolHarness();
            const agent = new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                messages: [
                    {
                        role: "user",
                        id: "user-1",
                        blocks: [{ type: "text", text: "Do the work." }],
                    },
                    {
                        role: "agent",
                        id: "agent-1",
                        blocks: [{ type: "text", text: "The work is done." }],
                    },
                ],
                printToConsole: false,
            });
            const tui = fakeTui();
            const app = new CodingAssistantApp({
                ctx: createTestRootContext().named("app"),
                agent,
                cwd: harness.context.fs.cwd,
                processManager: new NativeProcessManager(),
                tui,
            });
            const compact = vi.spyOn(agent, "compact");

            submit(app, "/compact");
            const compaction = compact.mock.results[0];
            expect(compaction?.type).toBe("return");
            if (compaction?.type !== "return") throw new Error("Compaction did not start.");
            await started.promise;

            vi.mocked(tui.requestRender).mockClear();
            vi.advanceTimersByTime(530);
            expect(tui.requestRender).toHaveBeenCalled();

            release.resolve();
            await compaction.value;
            vi.mocked(tui.requestRender).mockClear();
            vi.advanceTimersByTime(530);
            expect(tui.requestRender).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects overlapping submissions while conversation compaction is running", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        const release = deferred<void>();
        let requests = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            compact: async (_ctx, { context }) => {
                requests += 1;
                started.resolve();
                await release.promise;
                return completedCompaction(context);
            },
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            messages: [
                {
                    role: "user",
                    id: "user-1",
                    blocks: [{ type: "text", text: "Do the work." }],
                },
                {
                    role: "agent",
                    id: "agent-1",
                    blocks: [{ type: "text", text: "The work is done." }],
                },
            ],
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        const compact = vi.spyOn(agent, "compact");

        for (const character of "/compact") app.handleInput(character);
        app.handleInput("\r");
        const compaction = compact.mock.results[0];
        expect(compaction?.type).toBe("return");
        if (compaction?.type !== "return") throw new Error("Compaction did not start.");
        await started.promise;
        for (const character of "new prompt") app.handleInput(character);
        app.handleInput("\r");

        expect(stripAnsi(app.render(80).join("\n"))).toContain(
            "Wait for conversation compaction to finish before submitting.",
        );
        expect(requests).toBe(1);
        expect(agent.queue).toEqual([]);

        release.resolve();
        await compaction.value;
        expect(agent.snapshot().contextMessages).toHaveLength(1);
    });

    it("renders file mentions in the slash-command footer and completes them", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const searchFiles = vi.fn(async () => [
            {
                fileName: "CodingAssistantApp.ts",
                path: "packages/rig/sources/app/CodingAssistantApp.ts",
            },
            {
                fileName: "createCodingAssistantAgent.ts",
                path: "packages/rig/sources/runtime/createCodingAssistantAgent.ts",
            },
        ]);
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            searchFiles,
            tui: fakeTui(),
        });

        app.focused = true;
        for (const character of "Review @coding") {
            app.handleInput(character);
        }
        await delay(160);

        expect(searchFiles).toHaveBeenLastCalledWith("coding");
        const rawLines = app.render(100);
        const mentionLine = rawLines.find((line) =>
            stripAnsi(line).includes("CodingAssistantApp.ts"),
        );
        expect(mentionLine).toBeDefined();
        expect(mentionLine).toContain("\x1b[38;5;202m");
        expect(mentionLine).not.toContain("\x1b[48;5;235m");
        expect(stripAnsi(mentionLine ?? "")).not.toContain("@CodingAssistantApp.ts");
        expect(stripAnsi(mentionLine ?? "")).toContain(
            "packages/rig/sources/app/CodingAssistantApp.ts",
        );

        app.handleInput("x");
        const renderedWhileSearching = stripAnsi(app.render(100).join("\n"));
        expect(renderedWhileSearching).toContain("Review @codingx");
        expect(renderedWhileSearching).toContain("CodingAssistantApp.ts");

        await delay(160);
        app.handleInput("\x1b");
        app.handleInput("y");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Review @codingxy");

        await delay(160);
        app.handleInput("\x1b[B");
        app.handleInput("\t");
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Review @packages/rig/sources/runtime/createCodingAssistantAgent.ts ",
        );
    });

    it("shows loaded skills as slash command autocomplete items", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/.git": "gitdir: here",
                "/workspace/.agents/skills/review/SKILL.md":
                    "---\nname: review\ndescription: Review changes carefully.\n---\n\n# Review\n",
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        await delay(30);
        app.handleInput("/skill:");
        await delay(30);

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("/skill:review");
        expect(rendered).toContain("Review changes carefully.");
    });

    it("shows plugin skills from the shared catalog as slash command autocomplete items", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const filePath = "/plugins/release/skills/release-check/SKILL.md";
        const harness = createJustBashToolHarness({
            files: {
                [filePath]:
                    "---\nname: release-check\ndescription: Check releases.\n---\n\n# Release\n",
            },
        });
        const pluginSkill: Skill = {
            baseDir: "/plugins/release/skills/release-check",
            description: "Check releases.",
            filePath,
            name: "release-check",
            source: { folder: "release", plugin: "Release", type: "plugin" },
        };
        const loadSkills = vi.fn(async () => [pluginSkill]);
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: {
                ...harness.context,
                plugins: createPluginContext({ loadSkills }),
            },
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        await delay(30);
        app.handleInput("/skill:");
        await delay(30);

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("/skill:release-check");
        expect(rendered).toContain("Check releases.");
        expect(loadSkills).toHaveBeenCalledWith(expect.anything(), harness.context.fs);
    });

    it("limits visible skill slash command autocomplete rows", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const skillFiles = Object.fromEntries(
            Array.from({ length: 24 }, (_, index) => {
                const name = `skill-${index.toString().padStart(2, "0")}`;
                return [
                    `/workspace/.agents/skills/${name}/SKILL.md`,
                    `---\nname: ${name}\ndescription: Skill ${index} with a long description that should stay on one rendered row.\n---\n\n# ${name}\n`,
                ];
            }),
        );
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/.git": "gitdir: here",
                ...skillFiles,
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        await delay(30);
        app.handleInput("/skill:");
        await delay(30);

        const visibleSkillRows = stripAnsi(app.render(100).join("\n"))
            .split("\n")
            .filter((line) => line.includes("/skill:skill-"));
        expect(visibleSkillRows).toHaveLength(6);
        expect(visibleSkillRows[0]).toContain("/skill:skill-00");
        expect(visibleSkillRows[5]).toContain("/skill:skill-05");
    });

    it("renders each skill autocomplete suggestion as a single terminal row", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const skillFiles = Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => {
                const name = `skill-${index.toString().padStart(2, "0")}`;
                return [
                    `/workspace/.agents/skills/${name}/SKILL.md`,
                    [
                        "---",
                        `name: ${name}`,
                        "description: |",
                        "  First description line that is intentionally too long for a narrow terminal.",
                        "  Second description line must not become a second physical row.",
                        "---",
                        "",
                        `# ${name}`,
                    ].join("\n"),
                ];
            }),
        );
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/.git": "gitdir: here",
                ...skillFiles,
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const tui = fakeTui({ rows: 10, columns: 48 });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui,
        });

        app.focused = true;
        await delay(30);
        app.handleInput("/skill:");
        await delay(30);
        vi.mocked(tui.requestRender).mockClear();
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[A");

        const width = 48;
        const lines = app.render(width);
        const physicalRows = stripAnsi(lines.join("\n")).split("\n");
        const autocompleteRows = lines.filter((line) => stripAnsi(line).includes("/skill:skill-"));

        expect(tui.requestRender).toHaveBeenCalled();
        expect(tui.requestRender).not.toHaveBeenCalledWith(true);
        expect(physicalRows).toHaveLength(lines.length);
        expect(autocompleteRows).toHaveLength(6);
        for (const row of autocompleteRows) {
            expect(row).not.toContain("\n");
            expect(visibleWidth(row)).toBeLessThan(width);
        }
    });

    it("keeps transcript history while slash autocomplete is open", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("answer with enough text to leave transcript rows behind");
            },
        });
        const skillFiles = Object.fromEntries(
            Array.from({ length: 20 }, (_, index) => {
                const name = `skill-${index.toString().padStart(2, "0")}`;
                return [
                    `/workspace/.agents/skills/${name}/SKILL.md`,
                    `---\nname: ${name}\ndescription: Skill ${index}.\n---\n\n# ${name}\n`,
                ];
            }),
        );
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/.git": "gitdir: here",
                ...skillFiles,
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui({ rows: 8 }),
        });

        submit(app, "first");
        await app.waitForIdle();
        submit(app, "second");
        await app.waitForIdle();
        app.focused = true;
        app.handleInput("/skill:");
        await delay(30);

        const lines = app.render(100);
        const rendered = stripAnsi(lines.join("\n"));
        expect(lines.length).toBeGreaterThan(8);
        expect(rendered).toContain("› first");
        expect(rendered).toContain("› second");
        expect(rendered).toContain("• answer with enough text to leave transcript rows behind");
        expect(rendered).toContain("› /skill:");
        expect(rendered).toContain("/skill:skill-00");
        expect(rendered).toContain("/skill:skill-05");
        expect(rendered).not.toContain("/skill:skill-06");
    });

    it("uses normal diff redraw while navigating a large skill autocomplete list", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const skillFiles = Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => {
                const name = `skill-${index.toString().padStart(2, "0")}`;
                return [
                    `/workspace/.agents/skills/${name}/SKILL.md`,
                    `---\nname: ${name}\ndescription: Skill ${index}.\n---\n\n# ${name}\n`,
                ];
            }),
        );
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/.git": "gitdir: here",
                ...skillFiles,
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const tui = fakeTui({ rows: 8 });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui,
        });

        app.focused = true;
        await delay(30);
        app.handleInput("/skill:");
        await delay(30);
        vi.mocked(tui.requestRender).mockClear();

        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[A");

        expect(tui.requestRender).toHaveBeenCalled();
        expect(tui.requestRender).not.toHaveBeenCalledWith(true);
        expect(app.render(100).length).toBeGreaterThan(8);
    });

    it("expands a skill slash command before sending it to the model", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText("skill used");
            },
        });
        const harness = createJustBashToolHarness({
            files: {
                "/workspace/.git": "gitdir: here",
                "/workspace/.agents/skills/review/SKILL.md": [
                    "---",
                    "name: review",
                    "description: Review changes carefully.",
                    "allowed-tools:",
                    "  - Bash",
                    "---",
                    "",
                    "# Review",
                    "Use the word cobalt.",
                ].join("\n"),
            },
        });
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/skill:review inspect this diff");
        await app.waitForIdle();

        const sentMessage = contexts[0]?.messages[0];
        const sentContent =
            sentMessage?.role === "user" && Array.isArray(sentMessage.content)
                ? sentMessage.content[0]
                : undefined;
        const sentText =
            typeof sentContent === "string"
                ? sentContent
                : sentContent?.type === "text"
                  ? sentContent.text
                  : "";
        expect(sentText).toContain(
            '<skill name="review" location="/workspace/.agents/skills/review/SKILL.md">',
        );
        expect(sentText).toContain("References are relative to /workspace/.agents/skills/review.");
        expect(sentText).toContain("# Review");
        expect(sentText).toContain("Use the word cobalt.");
        expect(sentText).toContain("</skill>\n\ninspect this diff");
        expect(sentText).not.toContain("allowed-tools");

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("› /skill:review inspect this diff");
        expect(rendered.match(/› \/skill:review inspect this diff/gu)).toHaveLength(1);
        expect(rendered).toContain("• skill used");
        expect(rendered).not.toContain("Use the word cobalt.");
    });

    it("uses a bounded no-follow read when invoking a plugin skill", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("skill used");
            },
        });
        const filePath = "/plugins/release/skills/release-check/SKILL.md";
        const harness = createJustBashToolHarness({
            files: {
                [filePath]:
                    "---\nname: release-check\ndescription: Check releases.\n---\n\n# Release\n",
            },
        });
        const readFile = vi.fn(harness.context.fs.readFile);
        const readFileBuffer = vi.fn(harness.context.fs.readFileBuffer);
        const pluginSkill: Skill = {
            baseDir: "/plugins/release/skills/release-check",
            description: "Check releases.",
            filePath,
            name: "release-check",
            source: { folder: "release", plugin: "Release", type: "plugin" },
        };
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: {
                ...harness.context,
                fs: {
                    ...harness.context.fs,
                    readFile,
                    readFileBuffer,
                },
                plugins: createPluginContext({
                    loadSkills: async () => [pluginSkill],
                }),
            },
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/skill:release-check");
        await app.waitForIdle();

        expect(readFileBuffer).toHaveBeenCalledWith(filePath, {
            maxBytes: MAXIMUM_SKILL_FILE_BYTES,
            noFollow: true,
        });
        expect(readFile).not.toHaveBeenCalledWith(filePath);
    });

    it("restores transcript entries from session events", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const initialSessionEvents: SessionEvent[] = [
            {
                createdAt: 1_700_000_000_000,
                data: {
                    displayText: "resume this",
                    message: {
                        blocks: [{ text: "resume this", type: "text" }],
                        id: "user-message-1",
                        role: "user",
                    },
                    runId: "run-1",
                },
                id: "018bcfe5-6800-7001-8000-000000000001",
                sessionId: "session-1",
                type: "message_submitted",
            },
            {
                createdAt: 1_700_000_000_001,
                data: {
                    message: {
                        blocks: [{ text: "restored answer", type: "text" }],
                        id: "message-1",
                        role: "agent",
                    },
                    runId: "run-1",
                },
                id: "018bcfe5-6801-7001-8000-000000000002",
                sessionId: "session-1",
                type: "agent_message",
            },
            {
                createdAt: 1_700_000_000_002,
                data: {
                    agentRunId: "agent-run-1",
                    modelLocked: false,
                    runId: "run-1",
                    stopReason: "stop",
                },
                id: "018bcfe5-6802-7001-8000-000000000003",
                sessionId: "session-1",
                type: "run_finished",
            },
        ];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            initialSessionEvents,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("› resume this");
        expect(rendered).toContain("• restored answer");
    });

    it("finds new session command by reset and clears agent state", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("previous answer");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        submit(app, "previous prompt");
        await app.waitForIdle();
        expect(agent.snapshot().messages.length).toBeGreaterThan(0);

        app.handleInput("/reset");
        const resetAutocomplete = stripAnsi(app.render(80).join("\n"));
        expect(resetAutocomplete).toContain("/new");
        expect(resetAutocomplete).toContain("Reset this session and start fresh.");
        app.handleInput("\r");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(agent.snapshot().messages).toEqual([]);
        expect(rendered).toContain("Session reset. Started a new session.");
        expect(rendered).not.toContain("previous prompt");
        expect(rendered).not.toContain("previous answer");
    });

    it("dismisses the model menu before Ctrl+C exits", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const tui = fakeTui();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui,
        });

        app.handleInput("\x1bm");
        app.handleInput("\x1b");

        expect(stripAnsi(app.render(80).join("\n"))).toContain("Ask Rig to do anything");

        app.handleInput("\x1bm");
        app.handleInput("\x03");
        expect(tui.stop).not.toHaveBeenCalled();

        app.handleInput("\x03");

        await vi.waitFor(() => expect(tui.stop).toHaveBeenCalled());
    });

    it("renders one red session interruption notice when Escape aborts a run", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, _context, options) {
                return streamAbortAfterSignal(options?.signal, started.resolve);
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        submit(app, "work");
        await started.promise;
        app.handleInput("/");
        expect(stripAnsi(app.render(80).join("\n"))).toContain("/model");
        app.handleInput("\x1b");
        app.handleInput("\x1b");
        app.handleInput("\x1b");
        await app.waitForIdle();

        const raw = app.render(80).join("\n");
        const rendered = stripAnsi(raw);
        expect(raw).toContain("\x1b[31m");
        expect(rendered.match(/Session interrupted/gu)).toHaveLength(1);
        expect(rendered).toContain("The active run was stopped.");
        expect(rendered).not.toContain("request aborted");
        expect(rendered).not.toContain("message aborted");
        expect(rendered).not.toContain("Run aborted.");
        expect(rendered).not.toContain("Stopped: aborted");
        expect(rendered).toContain("› Ask Rig to do anything");
    });

    it("uses Enter to steer and Tab to queue while a run is active", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const gate = createTextStartStreamGate("first response");
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return contexts.length === 1 ? gate.stream() : streamText("done");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "first");
        await gate.startedText;
        app.handleInput("queued later");
        app.handleInput("\t");
        const queued = stripAnsi(app.render(100).join("\n"));
        expect(queued).toContain("↳ queued queued later");
        expect(queued).not.toContain("Enter steers");
        expect(queued).not.toContain("Tab queues");

        submit(app, "steer now");
        gate.release();
        await app.waitForIdle();

        expect(contexts).toHaveLength(3);
        expect(contexts[1]?.messages.at(-1)).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "steer now" }],
        });
        expect(contexts[2]?.messages.at(-1)).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "queued later" }],
        });
    });

    it("restores queued prompts to the composer when Escape interrupts", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const started = deferred<void>();
        let requests = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, _context, options) {
                requests += 1;
                return streamAbortAfterSignal(options?.signal, started.resolve);
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "first");
        await started.promise;
        app.handleInput("queued follow-up");
        app.handleInput("\t");
        app.handleInput("current draft");
        app.handleInput("\x1b");
        app.handleInput("\x1b");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(requests).toBe(1);
        expect(rendered).toContain("› queued follow-up");
        expect(rendered).not.toContain("  current draft");
        expect(rendered).not.toContain("↳ queued");
    });

    it("keeps the composer cursor steady without idle redraws", () => {
        vi.useFakeTimers();
        try {
            const model = defineModel({
                id: "openai/gpt-test",
                name: "GPT Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const provider = defineProvider({
                id: "codex",
                models: [model],
                stream() {
                    return streamText("unused");
                },
            });
            const harness = createJustBashToolHarness();
            const agent = new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            });
            const tui = fakeTui();
            const app = new CodingAssistantApp({
                ctx: createTestRootContext().named("app"),
                agent,
                cwd: harness.context.fs.cwd,
                processManager: new NativeProcessManager(),
                tui,
            });

            app.focused = true;
            app.handleInput("h");
            vi.mocked(tui.requestRender).mockClear();
            vi.advanceTimersByTime(530);
            expect(app.render(80).join("\n")).toContain("\x1b[48;5;244m\x1b[38;5;232m ");

            vi.advanceTimersByTime(530);
            expect(app.render(80).join("\n")).toContain("\x1b[48;5;244m\x1b[38;5;232m ");
            expect(tui.requestRender).not.toHaveBeenCalled();
            app.focused = false;
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps input background after the visible cursor", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        app.handleInput("ab");
        app.handleInput("\x1b[D");

        const inputLine = app.render(80).find((line) => stripAnsi(line).includes("› ab"));
        expect(inputLine).toContain("\x1b[48;5;244m\x1b[38;5;232mb\x1b[48;5;235m\x1b[39m");
    });

    it("inserts bracketed paste into the composer", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("\x1b[200~hello from clipboard\x1b[201~");

        expect(stripAnsi(app.render(80).join("\n"))).toContain("› hello from clipboard");
    });

    it("inserts split bracketed paste chunks into the composer", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("\x1b[200~multi ");
        app.handleInput("chunk");
        app.handleInput(" paste\x1b[201~");

        expect(stripAnsi(app.render(80).join("\n"))).toContain("› multi chunk paste");
    });

    it("pastes clipboard images as chips and sends image content", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            readClipboardImage: async () => ({
                data: validPng32Base64,
                mediaType: "image/png",
                path: "/workspace/.context/clipboard-images/image.png",
            }),
            tui: fakeTui(),
        });

        app.handleInput("\x16");
        await delay(0);

        const raw = app.render(80).join("\n");
        expect(stripAnsi(raw)).toContain("› [Image #1 PNG]");
        expect(raw).toContain("\x1b[48;5;240m\x1b[38;5;255m[Image #1 PNG]");

        app.handleInput("\r");
        await app.waitForIdle();

        expect(contexts[0]?.messages[0]).toMatchObject({
            role: "user",
            content: [{ type: "image", mimeType: "image/png", data: validPng32Base64 }],
        });
        expect(stripAnsi(app.render(80).join("\n"))).toContain("› [Image #1 PNG]");
    });

    it("restores image history as a real attachment after clearing and submitting", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText("image restored");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => 100,
            processManager: new NativeProcessManager(),
            readClipboardImage: async () => ({
                data: validPng32Base64,
                mediaType: "image/png",
                path: "/workspace/.context/clipboard-images/history.png",
            }),
            tui: fakeTui(),
        });

        app.handleInput("explain ");
        app.handleInput("\x16");
        await delay(0);
        app.handleInput("\x1b");
        app.handleInput("\x1b");
        app.handleInput("\x1b[A");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("› explain [Image #1 PNG]");

        app.handleInput("\r");
        await app.waitForIdle();
        app.handleInput("\x1b[A");
        app.handleInput("\r");
        await app.waitForIdle();

        expect(contexts).toHaveLength(2);
        for (const context of contexts) {
            expect(
                context.messages.filter((message) => message.role === "user").at(-1),
            ).toMatchObject({
                role: "user",
                content: [
                    { type: "text", text: "explain " },
                    { type: "image", mimeType: "image/png", data: validPng32Base64 },
                ],
            });
        }
    });

    it("pastes multiple clipboard images into one prompt", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText("unused");
            },
        });
        const images = [
            {
                data: validPng32Base64,
                mediaType: "image/png",
                path: "/workspace/.context/clipboard-images/first.png",
            },
            {
                data: validJpeg32Base64,
                mediaType: "image/jpeg",
                path: "/workspace/.context/clipboard-images/second.jpg",
            },
        ];
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            readClipboardImage: async () => images.shift(),
            tui: fakeTui(),
        });

        app.handleInput("compare ");
        app.handleInput("\x16");
        await delay(0);
        app.handleInput("and ");
        app.handleInput("\x16");
        await delay(0);

        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "› compare [Image #1 PNG] and [Image #2 JPG]",
        );

        app.handleInput("\r");
        await app.waitForIdle();

        expect(contexts[0]?.messages[0]).toMatchObject({
            role: "user",
            content: [
                { type: "text", text: "compare " },
                { type: "image", mimeType: "image/png", data: validPng32Base64 },
                { type: "text", text: " and " },
                { type: "image", mimeType: "image/jpeg", data: validJpeg32Base64 },
            ],
        });
    });

    it("keeps long multiline input scrollable around the cursor", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui({ rows: 10 }),
        });

        for (let line = 1; line <= 9; line += 1) {
            app.handleInput(`line ${line}`);
            if (line < 9) app.handleInput("\x1b[13;2~");
        }

        expect(stripAnsi(app.render(80).join("\n"))).toContain("↑ 4 more");
        for (let line = 1; line <= 8; line += 1) app.handleInput("\x1b[A");
        expect(stripAnsi(app.render(80).join("\n"))).toContain("↓ 4 more");
    });

    it("hides the composer cursor while the terminal is unfocused", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        app.handleInput("draft");
        expect(app.render(80).join("\n")).toContain("\x1b[48;5;244m");

        app.handleInput("\x1b[O");
        expect(app.render(80).join("\n")).not.toContain("\x1b[48;5;244m");
    });

    it("inserts plain multi-character paste without treating it as shortcuts", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("/model");

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("› /model");
        expect(rendered).not.toContain("Choose Model");
    });

    it("renders composer padding while typing", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.focused = true;
        app.handleInput("h");

        const rawLines = app.render(80);
        const renderedLines = rawLines.map(stripAnsi);
        const inputLineIndex = renderedLines.findIndex((line) => line.includes("› h"));
        expect(inputLineIndex).toBeGreaterThan(0);
        expect(rawLines[inputLineIndex - 1]).toContain("\x1b[48;5;235m");
        expect(rawLines[inputLineIndex]).toContain("\x1b[39m");
        expect(rawLines[inputLineIndex + 1]).toContain("\x1b[48;5;235m");
    });

    it("clears input on the first Ctrl+C and exits on the next press", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const tui = fakeTui();
        const processManager = new SlowKillProcessManager();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager,
            tui,
        });

        app.handleInput("h");
        app.handleInput("\x03");

        expect(tui.requestRender).toHaveBeenCalled();
        expect(tui.requestRender).not.toHaveBeenCalledWith(true);
        expect(stripAnsi(app.render(80).join("\n"))).not.toContain("› h");
        expect(tui.stop).not.toHaveBeenCalled();

        app.handleInput("\x03");

        await vi.waitFor(() => expect(tui.stop).toHaveBeenCalled());
        expect(processManager.killAllStarted).toBe(true);
        app.handleInput("z");
        expect(stripAnsi(app.render(80).join("\n"))).not.toContain("› hz");

        processManager.finishKillAll();
    });

    it("also exits immediately on Kitty-style Ctrl+C", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const tui = fakeTui();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui,
        });

        app.handleInput("\x1b[99;5u");

        await vi.waitFor(() => expect(tui.stop).toHaveBeenCalled());
    });

    it("uses Shift-Enter for multiline input without submitting", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("line one");
        app.handleInput("\x1b[13;2~");
        app.handleInput("line two");

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("› line one");
        expect(rendered).toContain("  line two");
        expect(contexts).toHaveLength(0);

        app.handleInput("\x1b[A");
        app.handleInput("\r");
        await app.waitForIdle();

        expect(contexts[0]?.messages[0]).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "line one\nline two" }],
        });
    });

    it("does not render a turn separator before the first user turn", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("answer");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/clear");
        submit(app, "first");
        await app.waitForIdle();

        const renderedLines = app.render(80).map(stripAnsi);
        const userLineIndex = renderedLines.findIndex((line) => line.includes("› first"));
        const answerLineIndex = renderedLines.findIndex((line) => line.includes("• answer"));
        const separatorLineIndex = renderedLines.findIndex((line) => line.includes("Worked for"));

        expect(userLineIndex).toBeGreaterThan(0);
        expect(answerLineIndex).toBeGreaterThan(userLineIndex);
        expect(separatorLineIndex).toBeGreaterThan(answerLineIndex);
    });

    it("reports provider token usage and shows optional live footer status", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
            contextWindow: 200_000,
        });
        const usage: Usage = {
            input: 1_200,
            output: 300,
            cacheRead: 100,
            cacheWrite: 0,
            totalTokens: 1_600,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamMessage({
                    role: "assistant",
                    content: [{ type: "text", text: "Measured." }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    contextTokens: usage.totalTokens,
                    usage,
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showUsage: true,
            tui: fakeTui(),
        });

        submit(app, "Measure this turn.");
        await app.waitForIdle();
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "1.6k tokens · 8% cache hit · 99% ctx left",
        );

        app.applySessionEvent({
            createdAt: 2,
            data: {
                changed: ["model"],
                modelId: model.id,
                providerId: agent.snapshot().providerId,
                serviceTier: null,
            },
            id: "model-changed",
            sessionId: "session-1",
            type: "session_configuration_changed",
        });
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "1.6k tokens · 8% cache hit · 100% ctx left",
        );

        app.applySessionEvent({
            createdAt: 3,
            data: {
                event: {
                    compactionId: "compaction-1",
                    compactedMessageCount: 4,
                    elapsedMs: 25,
                    estimatedTokensAfter: 600,
                    estimatedTokensBefore: 4_200,
                    reason: "threshold",
                    type: "context_compacted",
                },
                runId: "run-1",
            },
            id: "context-compacted",
            sessionId: "session-1",
            type: "agent_event",
        });
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "1.6k tokens · 8% cache hit · 100% ctx left",
        );

        submit(app, "/usage");
        const report = stripAnsi(app.render(100).join("\n"));
        expect(report).toContain("Input: 1.2k");
        expect(report).toContain("Output: 300");
        expect(report).toContain("Session tokens: 1.6k");

        submit(app, "/new");
        await app.waitForIdle();
        submit(app, "/usage");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Session tokens: 0");
    });

    it("summarizes generated tokens and cache hits on each completed turn when usage is shown", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let turn = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                turn += 1;
                return streamMessage({
                    role: "assistant",
                    content: [{ type: "text", text: `Turn ${turn} done.` }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: {
                        input: 1_200,
                        output: 300,
                        cacheRead: 100,
                        cacheWrite: 0,
                        totalTokens: 1_600,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                    timestamp: turn,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showUsage: true,
            tui: fakeTui(),
        });

        submit(app, "First turn.");
        await app.waitForIdle();
        expect(stripAnsi(app.render(100).join("\n"))).toContain("300 generated · 8% cache hit");

        submit(app, "Second turn.");
        await app.waitForIdle();
        const rendered = stripAnsi(app.render(100).join("\n"));
        // The first turn keeps the totals it was completed with; only the newest row grows.
        expect(rendered).toContain("300 generated · 8% cache hit");
        expect(rendered).toContain("600 generated · 8% cache hit");
    });

    it("hides the completed turn usage summary while token status is off", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamMessage({
                    role: "assistant",
                    content: [{ type: "text", text: "Quiet turn." }],
                    api: "test",
                    provider: "codex",
                    model: model.id,
                    usage: {
                        input: 1_200,
                        output: 300,
                        cacheRead: 100,
                        cacheWrite: 0,
                        totalTokens: 1_600,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "Quiet turn.");
        await app.waitForIdle();
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("generated");
    });

    it("keeps out-of-tokens reset countdowns live after the error is rendered", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "claude",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        let now = 1_000;
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: now,
            data: {
                event: {
                    error: {
                        api: "test",
                        content: [],
                        errorMessage: "Credit balance is too low",
                        model: model.id,
                        provider: provider.id,
                        providerError: { resetAt: 181_000, type: "out_of_tokens" },
                        role: "assistant",
                        stopReason: "error",
                        timestamp: now,
                        usage: zeroUsage(),
                    },
                    messageId: "out-of-tokens-message",
                    reason: "error",
                    type: "error",
                },
                runId: "run-1",
            },
            id: "event-out-of-tokens",
            sessionId: "session-1",
            type: "agent_event",
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Claude Code is out of tokens. Resets in 3m 0s.",
        );

        now = 2_500;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Claude Code is out of tokens. Resets in 2m 59s.",
        );

        now = 121_000;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Claude Code is out of tokens. Resets in 1m 0s.",
        );
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("Resets in 3m 0s.");

        now = 181_000;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Claude Code is out of tokens. Resets now.",
        );
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("Resets in 1s.");
    });

    it("keeps rate-limit reset countdowns live after session resume", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "kirill_claude",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        let now = 1_000;
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            initialSessionEvents: [
                {
                    createdAt: now,
                    data: {
                        event: {
                            error: {
                                api: "test",
                                content: [],
                                errorMessage: "rate limited",
                                model: model.id,
                                provider: provider.id,
                                providerError: { resetAt: 661_000, type: "rate_limit" },
                                role: "assistant",
                                stopReason: "error",
                                timestamp: now,
                                usage: zeroUsage(),
                            },
                            messageId: "rate-limit-message",
                            reason: "error",
                            type: "error",
                        },
                        runId: "run-1",
                    },
                    id: "event-rate-limit",
                    sessionId: "session-1",
                    type: "agent_event",
                },
            ],
            now: () => now,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Kirill Claude is rate limited. Try again in 11m 0s.",
        );

        now = 2_500;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Kirill Claude is rate limited. Try again in 10m 59s.",
        );

        now = 301_000;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Kirill Claude is rate limited. Try again in 6m 0s.",
        );
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("Try again in 11m 0s.");

        now = 661_000;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Kirill Claude is rate limited. Try again now.",
        );
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("Try again in 1s.");
    });

    it("repaints rate-limit countdowns once more after the reset expires", () => {
        vi.useFakeTimers();
        try {
            const model = defineModel({
                id: "openai/gpt-test",
                name: "GPT Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const provider = defineProvider({
                id: "kirill_claude",
                models: [model],
                stream: () => streamText("unused"),
            });
            const harness = createJustBashToolHarness();
            let now = 1_000;
            const tui = fakeTui();
            const app = new CodingAssistantApp({
                ctx: createTestRootContext().named("app"),
                agent: new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                cwd: harness.context.fs.cwd,
                now: () => now,
                processManager: new NativeProcessManager(),
                sessionBacked: true,
                tui,
            });

            app.applySessionEvent({
                createdAt: now,
                data: {
                    event: {
                        error: {
                            api: "test",
                            content: [],
                            errorMessage: "rate limited",
                            model: model.id,
                            provider: provider.id,
                            providerError: { resetAt: 1_500, type: "rate_limit" },
                            role: "assistant",
                            stopReason: "error",
                            timestamp: now,
                            usage: zeroUsage(),
                        },
                        messageId: "rate-limit-message",
                        reason: "error",
                        type: "error",
                    },
                    runId: "run-1",
                },
                id: "event-rate-limit-expire",
                sessionId: "session-1",
                type: "agent_event",
            });

            expect(stripAnsi(app.render(100).join("\n"))).toContain(
                "Kirill Claude is rate limited. Try again in 1s.",
            );

            vi.mocked(tui.requestRender).mockClear();
            now = 1_500;
            vi.advanceTimersByTime(1_000);
            expect(tui.requestRender).toHaveBeenCalled();
            expect(stripAnsi(app.render(100).join("\n"))).toContain(
                "Kirill Claude is rate limited. Try again now.",
            );

            vi.mocked(tui.requestRender).mockClear();
            vi.advanceTimersByTime(1_000);
            expect(tui.requestRender).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("shows live compaction tokens and elapsed time until the paired finish event", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        let now = 1_000;
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        const apply = (id: string, event: AgentLoopEvent) =>
            app.applySessionEvent({
                createdAt: now,
                data: { event, runId: "run-1" },
                id,
                sessionId: "session-1",
                type: "agent_event",
            });

        app.applySessionEvent({
            createdAt: now,
            data: { runId: "run-1" },
            id: "run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        apply("compaction-started", {
            compactionId: "compaction-1",
            estimatedTokensBefore: 4_200,
            reason: "threshold",
            type: "context_compaction_started",
        });
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Compacting context · 4.2k tokens (0s · esc to interrupt)",
        );

        now = 3_500;
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Compacting context · 4.2k tokens (2s · esc to interrupt)",
        );

        apply("context-compacted", {
            compactionId: "compaction-1",
            compactedMessageCount: 4,
            elapsedMs: 2_500,
            estimatedTokensAfter: 600,
            estimatedTokensBefore: 4_200,
            reason: "threshold",
            type: "context_compacted",
        });
        apply("compaction-finished", {
            compactionId: "compaction-1",
            elapsedMs: 2_500,
            status: "completed",
            type: "context_compaction_finished",
        });
        const finished = stripAnsi(app.render(100).join("\n"));
        expect(finished).toContain("Context compacted");
        expect(finished).not.toContain("Compacting context");

        app.applySessionEvent({
            createdAt: now,
            data: {
                modelLocked: true,
                runId: "run-1",
                stopReason: "stop",
            },
            id: "run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        apply("stale-compaction-started", {
            compactionId: "stale-compaction",
            estimatedTokensBefore: 9_000,
            reason: "threshold",
            type: "context_compaction_started",
        });
        app.applySessionEvent({
            createdAt: now,
            data: { runId: "run-2" },
            id: "next-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        const nextRun = stripAnsi(app.render(100).join("\n"));
        expect(nextRun).toContain("Working");
        expect(nextRun).not.toContain("Compacting context ·");
        app.applySessionEvent({
            createdAt: now,
            data: {
                modelLocked: true,
                runId: "run-2",
                stopReason: "stop",
            },
            id: "next-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
    });

    it("renders the durable backend usage summary for session-backed agents", async () => {
        const model = defineModel({
            contextWindow: 200_000,
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const agent = Object.assign(
            new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            {
                getUsage: vi.fn(async () => ({
                    context: {
                        approximate: false,
                        modelId: model.id,
                        providerId: "codex",
                        requestedModelId: model.id,
                        totalTokens: 1_300,
                    },
                    currentProviderId: "codex",
                    groups: [
                        {
                            kind: "attributed" as const,
                            modelId: model.id,
                            providerId: "codex",
                            requestedModelId: model.id,
                            usage: {
                                cacheRead: 40,
                                cacheWrite: 30,
                                cost: {
                                    cacheRead: 0,
                                    cacheWrite: 0,
                                    input: 0,
                                    output: 0,
                                    total: 0,
                                },
                                input: 1_200,
                                output: 100,
                                totalTokens: 1_370,
                            },
                        },
                    ],
                    sessionTokenCount: { lastContextTokens: 1_370, totalTokens: 1_370 },
                    quotas: [
                        {
                            providerId: "codex",
                            quota: {
                                capturedAt: 1,
                                source: "codex" as const,
                                windows: {
                                    fiveHour: {
                                        capturedAt: 1,
                                        resetsAt: 8_041_000,
                                        status: "available" as const,
                                        usedPercent: 32,
                                    },
                                    weekly: { status: "unavailable" as const },
                                },
                            },
                        },
                    ],
                })),
            },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            now: () => 1_000,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/usage");
        await vi.waitFor(() => {
            const rows = stripAnsi(app.render(64).join("\n"))
                .split("\n")
                .map((row) => row.trimEnd());
            const usageIndex = rows.indexOf("• Usage");
            expect(rows.slice(usageIndex, usageIndex + 10)).toEqual([
                "• Usage",
                "  └ Codex",
                "      GPT Test",
                "        1.2k input · 100 output · 40 cache read · 30 cache write",
                "        Context: 1.3k / 200k · 99.4% left",
                "      Account quota",
                "        5-hour: 68% left · resets in 2h 14m",
                "        Weekly: unavailable",
                "    Session tokens: 1.4k",
                "",
            ]);
            expect(rows.filter((row) => row.includes("└"))).toEqual(["  └ Codex"]);
            expect(rows.every((row) => visibleWidth(row) <= 64)).toBe(true);
        });
    });

    it("discards a pending durable usage response when a newer run starts", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const pendingUsage = deferred<GetSessionUsageResponse>();
        const agent = Object.assign(
            new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            { getUsage: vi.fn(() => pendingUsage.promise) },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/usage");
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "newer-run" },
            id: "newer-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        pendingUsage.resolve({
            currentProviderId: "codex",
            groups: [],
            quotas: [],
            sessionTokenCount: { lastContextTokens: 0, totalTokens: 0 },
        });
        await pendingUsage.promise;
        await Promise.resolve();

        expect(stripAnsi(app.render(80).join("\n"))).not.toContain("• Usage");
    });

    it("keeps the focused empty placeholder stable without inserting padding", () => {
        vi.useFakeTimers();
        try {
            const model = defineModel({
                id: "openai/gpt-test",
                name: "GPT Test",
                thinkingLevels: ["off"],
                defaultThinkingLevel: "off",
            });
            const provider = defineProvider({
                id: "codex",
                models: [model],
                stream() {
                    return streamText("unused");
                },
            });
            const harness = createJustBashToolHarness();
            const agent = new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            });
            const tui = fakeTui();
            const app = new CodingAssistantApp({
                ctx: createTestRootContext().named("app"),
                agent,
                cwd: harness.context.fs.cwd,
                processManager: new NativeProcessManager(),
                tui,
            });

            app.focused = true;
            const visibleCursor = app.render(80).join("\n");
            expect(visibleCursor).toContain("\x1b_pi:c\x07");
            expect(visibleCursor).toContain("\x1b[48;5;244m\x1b[38;5;232mA");
            expect(stripAnsi(visibleCursor)).toContain("› Ask Rig to do anything");
            expect(stripAnsi(visibleCursor)).not.toContain("›  Ask Rig to do anything");

            vi.mocked(tui.requestRender).mockClear();
            vi.advanceTimersByTime(530);

            const steadyCursor = app.render(80).join("\n");
            expect(steadyCursor).toContain("\x1b[48;5;244m\x1b[38;5;232mA");
            expect(stripAnsi(steadyCursor)).toContain("› Ask Rig to do anything");
            expect(stripAnsi(steadyCursor)).not.toContain("›  Ask Rig to do anything");
            expect(tui.requestRender).not.toHaveBeenCalled();
            app.focused = false;
        } finally {
            vi.useRealTimers();
        }
    });

    it("submits input to the agent and renders streamed assistant output", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText("hello from agent");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            idFactory: createDeterministicIds(),
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.handleInput("h");
        app.handleInput("i");
        app.handleInput("\r");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(contexts[0]?.messages[0]).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "hi" }],
        });
        expect(rendered).toContain("› hi");
        expect(rendered).toContain("• hello from agent");
        const composerLines = app
            .render(80)
            .filter((line) => line.includes("\x1b[48;5;235m") && line.includes("\x1b[39m"));
        expect(composerLines.length).toBeGreaterThanOrEqual(1);
    });

    it("removes tentative reasoning, text, and tool rows when inference resets", () => {
        const model = defineModel({
            id: "anthropic/test",
            name: "Claude Test",
            thinkingLevels: ["high"],
            defaultThinkingLevel: "high",
        });
        const provider = defineProvider({
            id: "claude",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            showReasoning: true,
            tui: fakeTui(),
        });
        const partial: AssistantMessage = {
            api: "claude",
            content: [
                { type: "thinking", thinking: "Tentative reasoning" },
                { type: "text", text: "Tentative answer" },
                {
                    type: "toolCall",
                    id: "tentative-tool",
                    name: "Bash",
                    arguments: { command: "echo tentative" },
                },
            ],
            model: model.id,
            provider: provider.id,
            role: "assistant",
            stopReason: "toolUse",
            timestamp: 1,
            usage: zeroUsage(),
        };
        const apply = (id: string, event: AgentLoopEvent) =>
            app.applySessionEvent({
                createdAt: 1,
                data: { event, runId: "run-1" },
                id,
                sessionId: "session-1",
                type: "agent_event",
            });

        app.applySessionEvent({
            createdAt: 0,
            data: { runId: "run-1" },
            id: "reset-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        apply("thinking-start", {
            type: "thinking_start",
            contentIndex: 0,
            messageId: "reset-message",
            partial,
        });
        apply("thinking-delta", {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Tentative reasoning",
            messageId: "reset-message",
            partial,
        });
        apply("text-start", {
            type: "text_start",
            contentIndex: 1,
            messageId: "reset-message",
            partial,
        });
        apply("text-delta", {
            type: "text_delta",
            contentIndex: 1,
            delta: "Tentative answer",
            messageId: "reset-message",
            partial,
        });
        apply("tool-start", {
            type: "toolcall_start",
            contentIndex: 2,
            messageId: "reset-message",
            partial,
        });
        apply("tool-end", {
            type: "toolcall_end",
            contentIndex: 2,
            messageId: "reset-message",
            toolCall: partial.content[2] as Extract<
                AssistantMessage["content"][number],
                { type: "toolCall" }
            >,
            partial,
        });

        const tentative = stripAnsi(app.render(100).join("\n"));
        expect(tentative).toContain("Tentative reasoning");
        expect(tentative).toContain("Tentative answer");
        expect(tentative).toContain("echo tentative");

        apply("inference-reset", {
            messageId: "reset-message",
            partial: {
                ...partial,
                content: [],
            },
            type: "block_reset",
        });

        const reset = stripAnsi(app.render(100).join("\n"));
        expect(reset).not.toContain("Tentative reasoning");
        expect(reset).not.toContain("Tentative answer");
        expect(reset).not.toContain("echo tentative");
        expect(reset).toContain("Working");
    });

    it("renders multiline assistant output as one marked message", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("first line\nsecond line\n\nthird line");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "multiline");
        await app.waitForIdle();

        const renderedLines = app.render(80).map((line) => stripAnsi(line).trimEnd());
        const firstLineIndex = renderedLines.findIndex((line) => line === "• first line");
        const secondLineIndex = renderedLines.findIndex((line) => line === "  second line");
        const thirdLineIndex = renderedLines.findIndex((line) => line === "  third line");

        expect(firstLineIndex).toBeGreaterThan(0);
        expect(secondLineIndex).toBe(firstLineIndex + 1);
        expect(thirdLineIndex).toBe(secondLineIndex + 2);
        expect(renderedLines[secondLineIndex + 1]).toBe("");
        expect(renderedLines).not.toContain("• second line");
        expect(renderedLines).not.toContain("• third line");
    });

    it("renders tool rows with a two-line Codex-style call and one-line result", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-call-1",
                                name: "test_command",
                                arguments: {
                                    cmd: "printf 'line one\\nline two\\n'",
                                    shell: "/bin/zsh",
                                },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return streamText("done");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            toolSelector: selectTestTools,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "status");
        await app.waitForIdle();

        const raw = app.render(80).join("\n");
        const rendered = stripAnsi(raw);
        expect(raw).toContain("\x1b[38;5;202m\x1b[1mRan\x1b[22m");
        expect(raw).toContain("\x1b[38;5;75mprintf\x1b[39m");
        expect(raw).toContain("\x1b[38;5;71m'line one\\nline two\\n'\x1b[39m");
        expect(rendered).toContain("• Ran printf 'line one\\nline two\\n'");
        expect(rendered).toContain("  └ line one");
        expect(rendered).toContain("    line two");
        expect(rendered.slice(rendered.indexOf("› status"))).not.toContain("│");
        const resultLines = rendered.split("\n").filter((line) => /^[ ]+└ /u.test(line));
        expect(resultLines).toHaveLength(1);
        expect(contexts[1]?.messages[2]).toMatchObject({
            role: "toolResult",
            providerToolCallId: "tool-call-1",
            toolCallId: expect.any(String),
            toolName: "test_command",
            content: [
                {
                    type: "text",
                    text: expect.stringContaining("line one\nline two"),
                },
            ],
        });
    });

    it("caps giant shell output in the transcript without truncating model context", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-call-giant-output",
                                name: "test_command",
                                arguments: {
                                    cmd: "printf 'MODEL_%s_HEAD_' OUTPUT; printf '%05000d' 0; printf '_MODEL_%s_SENTINEL_' MIDDLE; printf '%05000d' 0; printf '_MODEL_%s_TAIL' OUTPUT",
                                },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return streamText("done");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                toolSelector: selectTestTools,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "inspect sessions");
        await app.waitForIdle();

        const renderedLines = app.render(80).map(stripAnsi);
        const toolStart = renderedLines.findIndex((line) => line.includes("• Ran printf"));
        const finalAnswer = renderedLines.findIndex((line) => line.includes("• done"));
        const renderedTool = renderedLines.slice(toolStart, finalAnswer).join("\n");
        expect(toolStart).toBeGreaterThanOrEqual(0);
        expect(finalAnswer).toBeGreaterThan(toolStart);
        expect(finalAnswer - toolStart).toBeLessThanOrEqual(15);
        expect(renderedTool).toContain("MODEL_OUTPUT_HEAD_");
        expect(renderedTool).toContain("MODEL_OUTPUT_TAIL");
        expect(renderedTool).toContain("output truncated");
        expect(renderedTool).not.toContain("MODEL_MIDDLE_SENTINEL");

        const modelContext = JSON.stringify(contexts[1]?.messages);
        expect(modelContext).toContain("MODEL_OUTPUT_HEAD_");
        expect(modelContext).toContain("MODEL_MIDDLE_SENTINEL");
        expect(modelContext).toContain("MODEL_OUTPUT_TAIL");
        expect(modelContext).toContain("0".repeat(5_000));
        expect(modelContext).not.toContain("output truncated");
    });

    it("renders persisted exploration and failed Bash call presentations", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: 1,
            data: {
                message: {
                    blocks: [
                        {
                            arguments: { file_path: "/workspace/src/example.ts" },
                            id: "read-source",
                            name: "Read",
                            presentation: {
                                type: "exploration",
                                operations: [{ kind: "read", name: "example.ts" }],
                            },
                            type: "tool_call",
                        },
                        {
                            arguments: { command: "pnpm test" },
                            id: "failed-bash",
                            name: "Bash",
                            presentation: {
                                command: "pnpm test",
                                type: "exec_command",
                            },
                            type: "tool_call",
                        },
                        {
                            display: "Command exited with code 1.",
                            failure: {
                                kind: "execution_failed",
                                message: "Command exited with code 1.",
                            },
                            isError: true,
                            rendered: [{ text: "Command exited with code 1.", type: "text" }],
                            toolCallId: "failed-bash",
                            toolName: "Bash",
                            type: "tool_result",
                        },
                    ],
                    id: "agent-message",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "agent-event",
            sessionId: "session-1",
            type: "agent_message",
        });

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("• Explored");
        expect(rendered).toContain("└ Read example.ts");
        expect(rendered).toContain("• Failed pnpm test");
        expect(rendered).toContain("Command exited with code 1.");
        expect(rendered).not.toContain("Failed Bash");
    });

    it("renders durable retry and terminal inference errors once", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });
        app.applySessionEvent({
            createdAt: 1,
            data: { runId: "run-1" },
            id: "run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                message: {
                    attempt: 2,
                    blocks: [{ text: "Connection lost.", type: "text" }],
                    id: "retry-2",
                    outcome: "retried",
                    role: "error",
                },
                runId: "run-1",
            },
            id: "retry-message",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: {
                message: {
                    blocks: [{ text: "Provider unavailable.", type: "text" }],
                    id: "failed-message",
                    outcome: "failed",
                    role: "error",
                },
                runId: "run-1",
            },
            id: "failure-message",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 4,
            data: {
                errorMessage: "Provider unavailable.",
                modelLocked: false,
                runId: "run-1",
            },
            id: "run-error",
            sessionId: "session-1",
            type: "run_error",
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Inference attempt 2 failed and was retried");
        expect(rendered).toContain("Connection lost.");
        expect(rendered.match(/Provider unavailable\./gu)).toHaveLength(1);
    });

    it("renders structured MCP calls, replayed results, errors, and approval detail", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: 0,
            data: { runId: "run-1" },
            id: "mcp-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 1,
            data: {
                message: {
                    blocks: [
                        {
                            arguments: { title: "List tabs", timeout_ms: 30_000 },
                            id: "mcp-success",
                            name: "mcp__node_repl__js",
                            type: "tool_call",
                        },
                        {
                            display: "Node Repl · Js",
                            isError: false,
                            rendered: [
                                { type: "text", text: "{ ready: true }" },
                                { type: "text", text: "tabs: 3" },
                            ],
                            toolCallId: "mcp-success",
                            toolName: "mcp__node_repl__js",
                            type: "tool_result",
                        },
                        {
                            arguments: {
                                arguments: { query: "TUI" },
                                name: "find_docs",
                                server: "search",
                            },
                            id: "mcp-error",
                            name: "call_mcp_tool",
                            type: "tool_call",
                        },
                        {
                            display: "Called Find Docs from Search",
                            isError: true,
                            rendered: [
                                { type: "text", text: "Error: network timeout" },
                                { type: "text", text: "Try again later." },
                            ],
                            toolCallId: "mcp-error",
                            toolName: "call_mcp_tool",
                            type: "tool_result",
                        },
                        {
                            arguments: { issue: 42 },
                            id: "mcp-pending",
                            name: "mcp__issues__close_ticket",
                            type: "tool_call",
                        },
                    ],
                    id: "mcp-message",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "mcp-agent-message",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: {
                event: {
                    action: "Close ticket 42",
                    toolCallId: "mcp-pending",
                    toolName: "mcp__issues__close_ticket",
                    type: "permission_review_started",
                },
                runId: "run-1",
            },
            id: "mcp-permission-started",
            sessionId: "session-1",
            type: "agent_event",
        });
        expect(stripAnsi(app.render(120).join("\n"))).toContain("Reviewing permissions");
        app.applySessionEvent({
            createdAt: 3,
            data: {
                event: {
                    action: "Close ticket 42",
                    decision: "deny",
                    reason: "This changes external issue state.",
                    risk: "medium",
                    toolCallId: "mcp-pending",
                    type: "permission_review",
                    userAuthorization: "low",
                },
                runId: "run-1",
            },
            id: "mcp-permission",
            sessionId: "session-1",
            type: "agent_event",
        });
        const reviewedOnly = stripAnsi(app.render(120).join("\n"));
        expect(reviewedOnly).toContain("Refused: This changes external issue state.");
        // Auto decides on the user's behalf, so a refusal never turns into a question.
        expect(reviewedOnly).not.toContain("Reviewing permissions");
        expect(reviewedOnly).not.toContain("Waiting for approval");
        app.applySessionEvent({
            createdAt: 4,
            data: {
                event: {
                    display: "Closing the ticket",
                    toolCallId: "mcp-pending",
                    type: "tool_execution_progress",
                },
                runId: "run-1",
            },
            id: "mcp-progress",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 5,
            data: {
                event: {
                    toolCall: {
                        arguments: { issue: 42 },
                        id: "mcp-pending",
                        name: "mcp__issues__close_ticket",
                        type: "toolCall",
                    },
                    type: "tool_execution_start",
                },
                runId: "run-1",
            },
            id: "mcp-start",
            sessionId: "session-1",
            type: "agent_event",
        });

        const raw = app.render(120).join("\n");
        const rendered = stripAnsi(raw);
        expect(rendered).toContain(
            '• Called node_repl.js({"title":"List tabs","timeout_ms":30000})',
        );
        expect(rendered).toContain("  └ { ready: true }");
        expect(rendered).toContain("    tabs: 3");
        expect(rendered).toContain('• Called search.find_docs({"query":"TUI"})');
        expect(rendered).toContain("  └ Error: network timeout");
        expect(rendered).toContain("    Try again later.");
        expect(rendered).not.toContain("Failed search.find_docs");
        expect(rendered).toContain('◦ Calling issues.close_ticket({"issue":42})');
        expect(rendered).toContain("Refused: This changes external issue state.");
        expect(rendered).toContain("Risk: Medium. User authorization: Low.");
        expect(rendered).not.toContain("Risk: medium");
        expect(raw).toContain("\x1b[36mnode_repl");
        expect(raw).toContain("\x1b[31m\x1b[1m•");

        app.applySessionEvent({
            createdAt: 6,
            data: {
                errorMessage: "The daemon restarted during the tool call.",
                modelLocked: false,
                runId: "run-1",
            },
            id: "mcp-run-error",
            sessionId: "session-1",
            type: "run_error",
        });
        const afterRunError = stripAnsi(app.render(120).join("\n"));
        expect(afterRunError).not.toContain('◦ Calling issues.close_ticket({"issue":42})');
        expect(afterRunError).toContain('• Called issues.close_ticket({"issue":42})');
        expect(afterRunError).toContain("Interrupted.");
    });

    it("keeps reverse-completing parallel MCP calls live until durable ordered results arrive", () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => streamText("unused"),
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                context: harness.context,
                modelId: model.id,
                printToConsole: false,
                provider,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        const calls = [
            { arguments: {}, id: "slow", name: "mcp__service__slow", type: "tool_call" as const },
            {
                arguments: {},
                id: "fast",
                name: "mcp__service__fast_empty",
                type: "tool_call" as const,
            },
        ];
        app.applySessionEvent({
            createdAt: 1,
            data: { message: { blocks: calls, id: "calls", role: "agent" }, runId: "run-1" },
            id: "calls-event",
            sessionId: "session-1",
            type: "agent_message",
        });
        for (const [index, call] of calls.entries()) {
            app.applySessionEvent({
                createdAt: 2 + index,
                data: {
                    event: {
                        toolCall: { ...call, type: "toolCall" },
                        type: "tool_execution_start",
                    },
                    runId: "run-1",
                },
                id: `start-${call.id}`,
                sessionId: "session-1",
                type: "agent_event",
            });
        }
        const result = (
            call: (typeof calls)[number],
            rendered: Array<{ text: string; type: "text" }>,
        ) => ({
            display: call.id,
            isError: false,
            rendered,
            toolCallId: call.id,
            toolName: call.name,
            type: "tool_result" as const,
        });
        for (const [index, item] of [
            result(calls[1]!, []),
            result(calls[0]!, [{ type: "text", text: "slow result" }]),
        ].entries()) {
            app.applySessionEvent({
                createdAt: 4 + index,
                data: { event: { result: item, type: "tool_execution_end" }, runId: "run-1" },
                id: `end-${item.toolCallId}`,
                sessionId: "session-1",
                type: "agent_event",
            });
        }

        const staged = stripAnsi(app.render(100).join("\n"));
        expect(staged).toContain("◦ Calling service.slow({})");
        expect(staged).toContain("◦ Calling service.fast_empty({})");
        expect(staged).not.toContain("• Called service.fast_empty({})");

        app.applySessionEvent({
            createdAt: 6,
            data: {
                message: {
                    blocks: [
                        result(calls[0]!, [{ type: "text", text: "slow result" }]),
                        result(calls[1]!, []),
                    ],
                    id: "results",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "results-event",
            sessionId: "session-1",
            type: "agent_message",
        });

        const finalRows = stripAnsi(app.render(100).join("\n")).split("\n");
        const slowIndex = finalRows.findIndex((row) => row.includes("Called service.slow"));
        const fastIndex = finalRows.findIndex((row) => row.includes("Called service.fast_empty"));
        expect(slowIndex).toBeGreaterThanOrEqual(0);
        expect(fastIndex).toBeGreaterThan(slowIndex);
        expect(finalRows.slice(fastIndex, fastIndex + 2)).toEqual([
            "• Called service.fast_empty({})",
            "  └ (empty result)",
        ]);
        expect(
            finalRows.slice(fastIndex, fastIndex + 2).filter((row) => row.includes("└")),
        ).toHaveLength(1);
    });

    it("replays durable syntax-highlighted file diffs and never presents failed changes", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        const successfulPresentation = {
            type: "file_diff" as const,
            files: [
                {
                    path: "src/greet.ts",
                    kind: "update" as const,
                    hunks: [
                        {
                            oldStart: 1,
                            newStart: 1,
                            lines: [
                                {
                                    kind: "context" as const,
                                    text: "export function greet(name: string) {",
                                },
                                {
                                    kind: "delete" as const,
                                    text: "  return `goodbye, ${name}`;",
                                },
                                {
                                    kind: "add" as const,
                                    text: "  return `hello, ${name}`;",
                                },
                                { kind: "context" as const, text: "}" },
                            ],
                        },
                    ],
                },
            ],
        };

        app.applySessionEvent({
            createdAt: 1,
            data: {
                message: {
                    blocks: [
                        {
                            arguments: { patch: "successful patch" },
                            id: "patch-success",
                            name: "apply_patch",
                            type: "tool_call",
                        },
                        {
                            display: "Applied patch",
                            isError: false,
                            presentation: successfulPresentation,
                            rendered: [{ type: "text", text: "Success." }],
                            toolCallId: "patch-success",
                            toolName: "apply_patch",
                            type: "tool_result",
                        },
                        {
                            arguments: { patch: "failed patch" },
                            id: "patch-error",
                            name: "apply_patch",
                            type: "tool_call",
                        },
                        {
                            display: "Tool 'apply_patch' failed: hunk did not match",
                            isError: true,
                            presentation: {
                                type: "file_diff",
                                files: [
                                    {
                                        path: "SHOULD_NOT_RENDER.ts",
                                        kind: "add",
                                        hunks: [],
                                    },
                                ],
                            },
                            rendered: [
                                {
                                    type: "text",
                                    text: "Tool 'apply_patch' failed: hunk did not match",
                                },
                            ],
                            toolCallId: "patch-error",
                            toolName: "apply_patch",
                            type: "tool_result",
                        },
                        {
                            arguments: { patch: "empty patch" },
                            id: "patch-empty",
                            name: "apply_patch",
                            type: "tool_call",
                        },
                        {
                            display: "Applied patch",
                            isError: false,
                            presentation: { type: "file_diff", files: [] },
                            rendered: [{ type: "text", text: "Applied patch" }],
                            toolCallId: "patch-empty",
                            toolName: "apply_patch",
                            type: "tool_result",
                        },
                    ],
                    id: "patch-message",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "patch-agent-message",
            sessionId: "session-1",
            type: "agent_message",
        });

        const raw = app.render(100).join("\n");
        const rendered = stripAnsi(raw);
        expect(rendered).toContain("• Edited src/greet.ts (+1 -1)");
        expect(rendered).toContain("    2 -  return `goodbye, ${name}`;");
        expect(rendered).toContain("    2 +  return `hello, ${name}`;");
        expect(rendered).toContain("• Failed Apply patch");
        expect(rendered).toContain("hunk did not match");
        expect(rendered).not.toContain("SHOULD_NOT_RENDER");
        expect(rendered).toContain("• Edited Apply patch");
        expect(rendered).toContain("  └ Applied patch");
        expect(raw).toContain("\x1b[48;5;52m");
        expect(raw).toContain("\x1b[48;5;22m");
        expect(raw).toContain("\x1b[38;2;148;226;213mexport");

        app.applySessionEvent({
            createdAt: 2,
            data: {
                message: {
                    blocks: [
                        {
                            display: "Applied large patch",
                            isError: false,
                            presentation: {
                                type: "file_diff",
                                omittedFiles: 4,
                                files: Array.from({ length: 20 }, (_, fileIndex) => ({
                                    path: `generated/file-${fileIndex}.ts`,
                                    kind: "add" as const,
                                    hunks: [
                                        {
                                            oldStart: 0,
                                            newStart: 1,
                                            lines: Array.from({ length: 20 }, (_, lineIndex) => ({
                                                kind: "add" as const,
                                                text: `export const value${lineIndex} = ${lineIndex};`,
                                            })),
                                        },
                                    ],
                                })),
                            },
                            rendered: [{ type: "text", text: "Applied large patch" }],
                            toolCallId: "patch-large",
                            toolName: "apply_patch",
                            type: "tool_result",
                        },
                    ],
                    id: "patch-large-message",
                    role: "agent",
                },
                runId: "run-2",
            },
            id: "patch-large-agent-message",
            sessionId: "session-1",
            type: "agent_message",
        });

        const largeRendered = app.render(100).map(stripAnsi);
        const largeStart = largeRendered.findIndex((line) =>
            line.includes("• Added generated/file-0.ts"),
        );
        const largeEnd = largeRendered.findIndex(
            (line, index) => index >= largeStart && line.includes("more rows"),
        );
        const omittedFilesRow = largeRendered.findIndex(
            (line, index) => index >= largeStart && line.includes("… 4 more files"),
        );
        expect(largeStart).toBeGreaterThanOrEqual(0);
        expect(largeEnd).toBeGreaterThan(largeStart);
        expect(omittedFilesRow).toBeGreaterThan(largeEnd);
        expect(omittedFilesRow - largeStart + 1).toBe(120);
    });

    it("names an unavailable model tool instead of presenting its argument as the failed action", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "unavailable-tool-call",
                                name: "erase_everything",
                                arguments: { path: "/workspace/protected.txt" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: model.id,
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return streamText("done");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "Check the file without changing it.");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("• Failed Erase everything");
        expect(rendered).toContain(
            'The model requested "Erase everything", but that tool is not available in this session.',
        );
        expect(rendered).not.toContain("• Failed /workspace/protected.txt");
        expect(rendered).not.toContain("erase_everything");

        const narrowRendered = stripAnsi(app.render(60).join("\n")).replace(/\s+/gu, " ");
        expect(narrowRendered).toContain(
            'The model requested "Erase everything", but that tool is not available in this session.',
        );
    });

    it("keeps progress active until execution ends and clears it after interruption", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });
        const toolCall = {
            arguments: { cmd: "printf progress" },
            id: "progress-tool",
            name: "exec_command",
            type: "toolCall" as const,
        };

        app.applySessionEvent({
            createdAt: 0,
            data: { runId: "run-1" },
            id: "event-run-start",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 1,
            data: {
                message: {
                    blocks: [
                        {
                            arguments: toolCall.arguments,
                            id: toolCall.id,
                            name: toolCall.name,
                            type: "tool_call",
                        },
                    ],
                    id: "tool-message",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "event-message",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 2,
            data: { event: { toolCall, type: "tool_execution_start" }, runId: "run-1" },
            id: "event-start",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: {
                event: {
                    display: "Processed 5 rows",
                    toolCallId: toolCall.id,
                    type: "tool_execution_progress",
                },
                runId: "run-1",
            },
            id: "event-progress",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 3,
            data: {
                event: {
                    status: "Waiting for the workflow to complete",
                    toolCallId: toolCall.id,
                    type: "tool_execution_status",
                },
                runId: "run-1",
            },
            id: "event-status",
            sessionId: "session-1",
            type: "agent_event",
        });

        const active = stripAnsi(app.render(80).join("\n"));
        expect(active).toContain("• Running printf progress");
        expect(active).toContain("└ Processed 5 rows");
        expect(active).toContain("Waiting for the workflow to complete");
        expect(active).not.toContain("Running 1 tool");
        expect(active).not.toContain("• Ran printf progress");

        app.applySessionEvent({
            createdAt: 4,
            data: {
                event: {
                    result: {
                        display: "Command finished with exit code 0.",
                        isError: false,
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        type: "tool_result",
                    },
                    type: "tool_execution_end",
                },
                runId: "run-1",
            },
            id: "event-end",
            sessionId: "session-1",
            type: "agent_event",
        });

        const completed = stripAnsi(app.render(80).join("\n"));
        expect(completed).toContain("• Ran printf progress");
        expect(completed).toContain("└ Command finished with exit code 0.");
        expect(completed).not.toContain("• Running printf progress");

        app.applySessionEvent({
            createdAt: 5,
            data: {
                agentRunId: "agent-run-1",
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            },
            id: "event-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
        const interruptedToolCall = {
            arguments: { cmd: "sleep 10" },
            id: "interrupted-tool",
            name: "exec_command",
            type: "toolCall" as const,
        };
        app.applySessionEvent({
            createdAt: 6,
            data: { runId: "run-2" },
            id: "event-interrupted-run-start",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 7,
            data: {
                message: {
                    blocks: [
                        {
                            arguments: interruptedToolCall.arguments,
                            id: interruptedToolCall.id,
                            name: interruptedToolCall.name,
                            type: "tool_call",
                        },
                    ],
                    id: "interrupted-tool-message",
                    role: "agent",
                },
                runId: "run-2",
            },
            id: "event-interrupted-message",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 8,
            data: {
                event: { toolCall: interruptedToolCall, type: "tool_execution_start" },
                runId: "run-2",
            },
            id: "event-interrupted-start",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 9,
            data: {
                event: {
                    display: "Waiting for the command",
                    toolCallId: interruptedToolCall.id,
                    type: "tool_execution_progress",
                },
                runId: "run-2",
            },
            id: "event-interrupted-progress",
            sessionId: "session-1",
            type: "agent_event",
        });
        expect(stripAnsi(app.render(80).join("\n"))).toContain("• Running sleep 10");

        app.applySessionEvent({
            createdAt: 10,
            data: {
                event: {
                    result: {
                        display: "Cancelled at the user's request.",
                        failure: { kind: "interrupted" },
                        isError: true,
                        toolCallId: interruptedToolCall.id,
                        toolName: interruptedToolCall.name,
                        type: "tool_result",
                    },
                    type: "tool_execution_end",
                },
                runId: "run-2",
            },
            id: "event-interrupted-end",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 11,
            data: {
                event: {
                    error: {
                        api: "test",
                        content: [],
                        model: model.id,
                        provider: provider.id,
                        role: "assistant",
                        stopReason: "aborted",
                        timestamp: 10,
                        usage: zeroUsage(),
                    },
                    messageId: "aborted-message",
                    reason: "aborted",
                    type: "error",
                },
                runId: "run-2",
            },
            id: "event-interrupted-error",
            sessionId: "session-1",
            type: "agent_event",
        });
        app.applySessionEvent({
            createdAt: 12,
            data: {
                agentRunId: "agent-run-2",
                modelLocked: false,
                runId: "run-2",
                stopReason: "aborted",
            },
            id: "event-interrupted-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        const interrupted = stripAnsi(app.render(80).join("\n"));
        expect(interrupted).toContain("Session interrupted");
        expect(interrupted).toContain("• Stopped sleep 10");
        expect(interrupted).not.toContain("• Running sleep 10");
        expect(interrupted).not.toContain("• Ran sleep 10");
        expect(app.render(80).join("\n")).toContain(
            "\x1b[31m•\x1b[0m \x1b[38;5;202m\x1b[1mStopped",
        );

        app.applySessionEvent({
            createdAt: 13,
            data: { runId: "run-3" },
            id: "event-later-run-start",
            sessionId: "session-1",
            type: "run_started",
        });
        const laterRun = stripAnsi(app.render(80).join("\n"));
        expect(laterRun).toContain("• Stopped sleep 10");
        expect(laterRun).not.toContain("• Running sleep 10");
        expect(laterRun).not.toContain("• Ran sleep 10");
        app.applySessionEvent({
            createdAt: 14,
            data: {
                agentRunId: "agent-run-3",
                modelLocked: false,
                runId: "run-3",
                stopReason: "stop",
            },
            id: "event-later-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });
    });

    it("shows Working while a tool call is still being generated", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let streamCalls = 0;
        const gate = createToolCallStartStreamGate();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return gate.stream();
                }

                return streamText("done");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            toolSelector: selectTestTools,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "status");
        await gate.startedToolCall;

        const renderedWhileToolCallStreams = stripAnsi(app.render(80).join("\n"));
        expect(renderedWhileToolCallStreams).toContain("• I will inspect files.");
        expect(renderedWhileToolCallStreams).toContain("◦ Working");
        expect(renderedWhileToolCallStreams.match(/◦ Working/gu)).toHaveLength(1);
        expect(renderedWhileToolCallStreams).not.toContain("printf ok");
        expect(renderedWhileToolCallStreams).not.toContain("Ran");
        expect(renderedWhileToolCallStreams).not.toContain("Used Working");

        gate.release();
        await app.waitForIdle();

        const renderedAfterToolCall = stripAnsi(app.render(80).join("\n"));
        expect(renderedAfterToolCall).toContain("• Ran printf ok");
        expect(renderedAfterToolCall).toContain("└ ok");
        expect(renderedAfterToolCall).not.toContain("◦ Working");
        expect(renderedAfterToolCall.match(/Ran printf ok/gu)).toHaveLength(1);
    });

    it("removes an incomplete Working placeholder when a streamed tool call is interrupted", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const gate = createToolCallStartStreamGate();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream: () => gate.stream(),
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "status");
        await gate.startedToolCall;
        app.handleInput("\x1b");

        const interrupted = stripAnsi(app.render(80).join("\n"));
        expect(interrupted).toContain("Session interrupted");
        expect(interrupted).not.toContain("Working");
        expect(interrupted).not.toContain("printf ok");

        gate.release();
        await app.waitForIdle();
    });

    it("sanitizes terminal controls from shell progress and results", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-call-ansi",
                                name: "test_command",
                                arguments: { cmd: "printf '\\033[2Junsafe'" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return streamText("done");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            toolSelector: selectTestTools,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "use tool");
        await app.waitForIdle();

        const raw = app.render(80).join("\n");
        expect(raw).not.toContain("\x1b[2J");
        expect(stripAnsi(raw)).toContain("└ unsafe");
    });

    it("renders one completion separator after the final response across tool cycles", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls <= 2) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: `tool-call-${String(streamCalls)}`,
                                name: "test_command",
                                arguments: { cmd: `printf tool-${String(streamCalls)}` },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return streamText("after tools");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            toolSelector: selectTestTools,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "use tool");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(streamCalls).toBe(3);
        expect(rendered).toContain("• Ran printf tool-1");
        expect(rendered).toContain("└ tool-1");
        expect(rendered).toContain("• Ran printf tool-2");
        expect(rendered).toContain("└ tool-2");
        expect(rendered.match(/Worked for/gu)).toHaveLength(1);
        expect(rendered.indexOf("• after tools")).toBeLessThan(rendered.indexOf("Worked for"));
    });

    it("places completion directly after the tool result when there is no final text", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let now = 0;
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-call-no-final-text",
                                name: "test_command",
                                arguments: { cmd: "printf tool-only" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                now = 65_000;
                return streamMessage({
                    role: "assistant",
                    content: [],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-test",
                    usage: zeroUsage(),
                    stopReason: "stop",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                toolSelector: selectTestTools,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "use one tool");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered.indexOf("└ tool-only")).toBeLessThan(rendered.indexOf("Worked for 1m 5s"));
        expect(rendered.match(/Worked for/gu)).toHaveLength(1);
    });

    it("keeps completion before a queued follow-up turn", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let now = 0;
        let streamCalls = 0;
        const gate = createBeforeTextStartStreamGate("first answer");
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-before-queued-turn",
                                name: "test_command",
                                arguments: { cmd: "printf queued-tool" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }
                if (streamCalls === 2) return gate.stream();
                return streamText("queued answer");
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                toolSelector: selectTestTools,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "use a tool first");
        await gate.started;
        app.handleInput("queued follow-up");
        app.handleInput("\t");
        now = 65_000;
        gate.release();
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        const firstAnswer = rendered.indexOf("• first answer");
        const completion = rendered.indexOf("Worked for 1m 5s");
        const queuedUser = rendered.indexOf("› queued follow-up");
        const queuedAnswer = rendered.indexOf("• queued answer");
        expect([firstAnswer, completion, queuedUser, queuedAnswer]).toEqual(
            [...new Set([firstAnswer, completion, queuedUser, queuedAnswer])].sort(
                (left, right) => left - right,
            ),
        );
        expect(rendered.match(/Worked for/gu)).toHaveLength(2);
    });

    it("does not leak deferred completion after a tool-using provider error", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let now = 0;
        let streamCalls = 0;
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-before-error",
                                name: "test_command",
                                arguments: { cmd: "printf before-error" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                now = 65_000;
                return streamMessage({
                    role: "assistant",
                    content: [],
                    api: "test",
                    provider: "codex",
                    model: "openai/gpt-test",
                    usage: zeroUsage(),
                    stopReason: "error",
                    errorMessage: "SCRIPTED_PROVIDER_ERROR",
                    timestamp: 1,
                });
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "fail after the tool");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("SCRIPTED_PROVIDER_ERROR");
        expect(rendered).not.toContain("Worked for");
    });

    it("does not leak deferred completion after a tool-using interruption", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let now = 0;
        let streamCalls = 0;
        const started = deferred<void>();
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, _context, options) {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-before-interruption",
                                name: "test_command",
                                arguments: { cmd: "printf before-interruption" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }
                return streamAbortAfterSignal(options?.signal, () => started.resolve());
            },
        });
        const harness = createJustBashToolHarness();
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "interrupt after the tool");
        await started.promise;
        now = 65_000;
        app.handleInput("\x1b");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(80).join("\n"));
        expect(rendered).toContain("Session interrupted");
        expect(rendered).not.toContain("Worked for");
    });

    it("shows Working before second inference content starts", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        let streamCalls = 0;
        const gate = createBeforeTextStartStreamGate("after tools");
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                streamCalls += 1;
                if (streamCalls === 1) {
                    return streamMessage({
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "tool-call-1",
                                name: "test_command",
                                arguments: { cmd: "printf ok" },
                            },
                        ],
                        api: "test",
                        provider: "codex",
                        model: "openai/gpt-test",
                        usage: zeroUsage(),
                        stopReason: "toolUse",
                        timestamp: 1,
                    });
                }

                return gate.stream();
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "use tool");
        await gate.started;

        const renderedDuringSecondTurn = stripAnsi(app.render(80).join("\n"));
        expect(streamCalls).toBe(2);
        expect(renderedDuringSecondTurn).not.toContain(
            "────────────────────────────────────────────────────────────────────────────────",
        );
        expect(renderedDuringSecondTurn).toContain("◦ Working");
        expect(renderedDuringSecondTurn.match(/◦ Working/gu)).toHaveLength(1);
        expect(renderedDuringSecondTurn).not.toContain("• after tools");

        gate.release();
        await app.waitForIdle();
    });

    it("shows active thinking inside the composer instead of the footer", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["high"],
            defaultThinkingLevel: "high",
        });
        let now = 10_000;
        const gate = createThinkingStreamGate("done");
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return gate.stream();
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            effort: "high",
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "think");
        await gate.startedThinking;
        now = 75_000;

        const rawWhileThinking = app.render(80);
        const thinkingLine =
            rawWhileThinking.find((line) => stripAnsi(line).includes("◦ Thinking")) ?? "";
        const renderedWhileThinking = stripAnsi(rawWhileThinking.join("\n"));
        expect(renderedWhileThinking).toContain("◦ Thinking (1m 5s · esc to interrupt)");
        expect(renderedWhileThinking).toContain("gpt-test high");
        expect(renderedWhileThinking).not.toContain("Idle |");
        expect(thinkingLine).toContain("\x1b[38;5;255m");
        expect(thinkingLine).toContain("\x1b[38;5;244m");
        expect(thinkingLine).toContain("\x1b[2m\x1b[2m\x1b[39m(1m 5s · esc to interrupt)");
        expect(thinkingLine).not.toContain("\x1b[38;5;255m(");
        expect(thinkingLine).not.toContain("\x1b[38;5;244m(");

        gate.release();
        await app.waitForIdle();
    });

    it("keeps elapsed history based on the composer message across permission answers", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        let now = 10_000;
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: 10_000,
            data: {
                displayText: "Complete the task.",
                message: {
                    blocks: [{ text: "Complete the task.", type: "text" }],
                    id: "user-message-1",
                    role: "user",
                },
                runId: "run-1",
            },
            id: "event-user-message",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 10_001,
            data: { runId: "run-1" },
            id: "event-run-started",
            sessionId: "session-1",
            type: "run_started",
        });

        now = 40_000;
        app.applySessionEvent({
            createdAt: 40_000,
            data: {
                questions: [
                    {
                        header: "Permission",
                        id: "permission",
                        multiSelect: false,
                        options: [
                            { label: "Allow", description: "Run this command once." },
                            { label: "Deny", description: "Do not run this command." },
                        ],
                        question: "Allow this command?",
                    },
                ],
                requestId: "tool-call-1:permission",
            },
            id: "event-permission-requested",
            sessionId: "session-1",
            type: "user_input_requested",
        });
        app.applySessionEvent({
            createdAt: 60_000,
            data: {
                answers: { permission: ["Allow"] },
                requestId: "tool-call-1:permission",
                status: "answered",
            },
            id: "event-permission-resolved",
            sessionId: "session-1",
            type: "user_input_resolved",
        });

        now = 75_000;
        app.applySessionEvent({
            createdAt: 75_000,
            data: {
                message: {
                    blocks: [{ text: "TASK_COMPLETE", type: "text" }],
                    id: "agent-message-1",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "event-agent-message",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 75_000,
            data: {
                agentRunId: "agent-run-1",
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            },
            id: "event-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("TASK_COMPLETE");
        expect(rendered).toContain("Worked for 1m 5s");
        expect(rendered).not.toContain("esc to interrupt");
    });

    it("measures immutable completion from the latest steering message", () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        let now = 10_000;
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            now: () => now,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: 10_000,
            data: {
                displayText: "Start the task.",
                message: {
                    blocks: [{ text: "Start the task.", type: "text" }],
                    id: "user-message-1",
                    role: "user",
                },
                runId: "run-1",
            },
            id: "event-user-message",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 10_001,
            data: { runId: "run-1" },
            id: "event-run-started",
            sessionId: "session-1",
            type: "run_started",
        });
        app.applySessionEvent({
            createdAt: 10_002,
            data: {
                message: {
                    blocks: [
                        {
                            arguments: { cmd: "printf done" },
                            id: "tool-call-1",
                            name: "test_command",
                            type: "tool_call",
                        },
                        {
                            display: "Completed command",
                            presentation: { type: "file_diff", files: [] },
                            rendered: [{ text: "done", type: "text" }],
                            toolCallId: "tool-call-1",
                            toolName: "test_command",
                            type: "tool_result",
                        },
                    ],
                    id: "tool-message-1",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "event-tool-message",
            sessionId: "session-1",
            type: "agent_message",
        });

        now = 70_000;
        app.applySessionEvent({
            createdAt: 70_000,
            data: {
                delivery: "steer",
                displayText: "Finish with the concise result.",
                message: {
                    blocks: [{ text: "Finish with the concise result.", type: "text" }],
                    id: "steering-message-1",
                    role: "user",
                },
                runId: "run-1",
            },
            id: "event-steering-message",
            sessionId: "session-1",
            type: "message_submitted",
        });
        app.applySessionEvent({
            createdAt: 70_001,
            data: { messageIds: ["steering-message-1"], runId: "run-1" },
            id: "event-steering-applied",
            sessionId: "session-1",
            type: "steering_applied",
        });
        now = 75_000;
        app.applySessionEvent({
            createdAt: 75_000,
            data: {
                message: {
                    blocks: [{ text: "STEERED_TASK_COMPLETE", type: "text" }],
                    id: "agent-message-final",
                    role: "agent",
                },
                runId: "run-1",
            },
            id: "event-agent-message-final",
            sessionId: "session-1",
            type: "agent_message",
        });
        app.applySessionEvent({
            createdAt: 75_000,
            data: {
                agentRunId: "agent-run-1",
                modelLocked: false,
                runId: "run-1",
                stopReason: "stop",
            },
            id: "event-run-finished",
            sessionId: "session-1",
            type: "run_finished",
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("STEERED_TASK_COMPLETE");
        expect(rendered).toContain("Worked for 5s");
    });

    it("renders completed thinking blocks as transcript text", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["high"],
            defaultThinkingLevel: "high",
        });
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                {
                    type: "thinking",
                    thinking: "I should **inspect** `renderer` before changing the UI.",
                },
                { type: "text", text: "Done." },
            ],
            api: "test",
            provider: "codex",
            model: "openai/gpt-test",
            usage: zeroUsage(),
            stopReason: "stop",
            timestamp: 1,
        };
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamMessage(message);
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            effort: "high",
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        submit(app, "show reasoning");
        await app.waitForIdle();

        const raw = app.render(100).join("\n");
        const rendered = stripAnsi(raw);
        expect(rendered).toContain("• I should inspect renderer before changing the UI.");
        expect(rendered).not.toContain("Thinking");
        expect(rendered).toContain("• Done.");
        expect(raw).toContain("\x1b[2m•\x1b[0m");
        expect(raw).toContain("\x1b[1m");
    });

    it("renders streamed thinking deltas without duplicating the final block", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["high"],
            defaultThinkingLevel: "high",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamThinkingText(
                    "I should read the transcript renderer and then update tests.",
                    "Done.",
                );
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            effort: "high",
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            showReasoning: true,
            tui: fakeTui(),
        });

        submit(app, "show streamed reasoning");
        await app.waitForIdle();

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain(
            "• I should read the transcript renderer and then update tests.",
        );
        expect(rendered).not.toContain("Thinking");
        expect(
            rendered.split("I should read the transcript renderer and then update tests."),
        ).toHaveLength(2);
        expect(rendered).toContain("• Done.");
    });

    it("toggles reasoning display from the configure menu", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["high"],
            defaultThinkingLevel: "high",
        });
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                {
                    type: "thinking",
                    thinking: "This reasoning text can be hidden.",
                },
                { type: "text", text: "Final answer stays visible." },
            ],
            api: "test",
            provider: "codex",
            model: "openai/gpt-test",
            usage: zeroUsage(),
            stopReason: "stop",
            timestamp: 1,
        };
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamMessage(message);
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            effort: "high",
            printToConsole: false,
        });
        const settingsChanges: Array<{
            inferenceMaxRetries: number;
            compactCompletedTurns: boolean;
            completionChime: boolean;
            durableGlobalEventQueue: boolean;
            showReasoning: boolean;
            showUsage: boolean;
        }> = [];
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            onSettingsChange: (settings) => {
                settingsChanges.push(settings);
            },
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "show reasoning");
        await app.waitForIdle();

        expect(stripAnsi(app.render(100).join("\n"))).not.toContain(
            "This reasoning text can be hidden.",
        );

        submit(app, "/configure");
        const menu = stripAnsi(app.render(100).join("\n"));
        expect(menu).toContain("Configure");
        expect(menu).toContain("Show reasoning");
        expect(menu).toContain("Show token status");
        expect(menu).toContain("Enable completion chime");
        expect(menu).toContain("Enable durable event queue");
        expect(menu).toContain("Inference retries · 10");

        app.handleInput("\r");

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(settingsChanges).toEqual([
            {
                inferenceMaxRetries: 10,
                compactCompletedTurns: false,
                completionChime: false,
                durableGlobalEventQueue: false,
                showReasoning: true,
                showUsage: false,
            },
        ]);
        expect(rendered).toContain("This reasoning text can be hidden.");
        expect(rendered).toContain("Final answer stays visible.");
        expect(rendered).toContain("Reasoning display enabled.");

        submit(app, "/configure");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");

        expect(settingsChanges.at(-1)).toEqual({
            inferenceMaxRetries: 10,
            compactCompletedTurns: false,
            completionChime: true,
            durableGlobalEventQueue: false,
            showReasoning: true,
            showUsage: false,
        });
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Completion chime enabled.");

        submit(app, "/configure");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");

        expect(settingsChanges.at(-1)).toEqual({
            inferenceMaxRetries: 10,
            compactCompletedTurns: false,
            completionChime: true,
            durableGlobalEventQueue: true,
            showReasoning: true,
            showUsage: false,
        });
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Durable event queue enabled.");

        submit(app, "/configure");
        for (let index = 0; index < 5; index += 1) app.handleInput("\x1b[B");
        app.handleInput("\r");
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Enter a whole number from 0 to 100.",
        );
        app.handleInput("8");
        app.handleInput("\r");
        await Promise.resolve();

        expect(settingsChanges.at(-1)).toEqual({
            inferenceMaxRetries: 8,
            compactCompletedTurns: false,
            completionChime: true,
            durableGlobalEventQueue: true,
            showReasoning: true,
            showUsage: false,
        });
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Inference retries set to 8.");
    });

    it("changes the session permission mode from the permissions menu", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        harness.context.permissions = createPermissionContext("workspace_write");
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "/permissions");

        const menu = stripAnsi(app.render(100).join("\n"));
        expect(menu).toContain("Choose Permissions");
        expect(menu).toContain("Auto");
        expect(menu).toContain("Workspace write");
        expect(menu).toContain("Read only");
        expect(menu).toContain("Full access");
        expect(menu).toContain("Applies to this session and its subagents");

        app.handleInput("\x1b[B");
        app.handleInput("\r");

        await vi.waitFor(() => expect(agent.permissionMode).toBe("read_only"));
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Permissions changed to Read only.",
        );
    });

    it("collects structured questions and sends a free-form answer", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const respondUserInput = vi.fn(async () => undefined);
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            respondUserInput,
            tui: fakeTui(),
        });
        const request = {
            requestId: "call-1",
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [
                        { label: "PostgreSQL", description: "Use the relational stack." },
                        { label: "SQLite", description: "Keep local setup small." },
                    ],
                    question: "Which database should be used?",
                },
                {
                    header: "Region",
                    id: "region",
                    multiSelect: false,
                    options: [
                        { label: "US West", description: "Deploy near the current team." },
                        { label: "US East", description: "Deploy near most customers." },
                    ],
                    question: "Which region should host it?",
                },
            ],
        };

        app.applySessionEvent({
            createdAt: 1,
            data: request,
            id: "event-1",
            sessionId: "session-1",
            type: "user_input_requested",
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Which database should be used? · 1 of 2",
        );
        app.handleInput("\r");
        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "Which region should host it? · 2 of 2",
        );

        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Type another answer");
        app.handleInput("Europe West");
        app.handleInput("\r");

        await vi.waitFor(() =>
            expect(respondUserInput).toHaveBeenCalledWith("call-1", {
                answers: {
                    database: ["PostgreSQL"],
                    region: ["Europe West"],
                },
            }),
        );
    });

    it("collects multiple selections for one structured question", async () => {
        const model = defineModel({
            id: "anthropic/test",
            name: "Claude Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "claude",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const respondUserInput = vi.fn(async () => undefined);
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            respondUserInput,
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: 1,
            data: {
                requestId: "call-2",
                questions: [
                    {
                        header: "Alerts",
                        id: "question_1",
                        multiSelect: true,
                        options: [
                            { label: "Email", description: "Send email alerts." },
                            { label: "Push", description: "Send device alerts." },
                        ],
                        question: "Which alert channels should be enabled?",
                    },
                ],
            },
            id: "event-2",
            sessionId: "session-1",
            type: "user_input_requested",
        });

        app.handleInput("\r");
        expect(stripAnsi(app.render(100).join("\n"))).toContain("✓ Email");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");

        await vi.waitFor(() =>
            expect(respondUserInput).toHaveBeenCalledWith("call-2", {
                answers: { question_1: ["Email", "Push"] },
            }),
        );
    });

    it("restores a pending approval after replaying completed historical runs", () => {
        const model = defineModel({
            id: "anthropic/test",
            name: "Claude Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "claude",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const permissionRequest = {
            requestId: "edit-1:permission",
            questions: [
                {
                    header: "Permission",
                    id: "permission",
                    multiSelect: false,
                    options: [
                        { label: "Allow once", description: "Permit this edit once." },
                        { label: "Deny", description: "Reject this edit." },
                    ],
                    question: "Allow editing /tmp/rig_tool_test.txt?",
                },
            ],
        };
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            initialSessionEvents: [
                {
                    createdAt: 1,
                    data: { runId: "old-run" },
                    id: "old-start",
                    sessionId: "session-1",
                    type: "run_started",
                },
                {
                    createdAt: 2,
                    data: {
                        modelLocked: false,
                        runId: "old-run",
                        stopReason: "stop",
                    },
                    id: "old-finished",
                    sessionId: "session-1",
                    type: "run_finished",
                },
                {
                    createdAt: 3,
                    data: { runId: "current-run" },
                    id: "current-start",
                    sessionId: "session-1",
                    type: "run_started",
                },
            ],
            initialUserInputs: [permissionRequest],
            processManager: new NativeProcessManager(),
            respondUserInput: vi.fn(async () => undefined),
            sessionBacked: true,
            tui: fakeTui(),
        });

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Allow editing /tmp/rig_tool_test.txt?");
        expect(rendered).toContain("Allow once");
        expect(rendered).toContain("Deny");
    });

    it("submits optional structured questions without an answer", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const respondUserInput = vi.fn(async () => undefined);
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            respondUserInput,
            tui: fakeTui(),
        });

        app.applySessionEvent({
            createdAt: 1,
            data: {
                requestId: "call-optional",
                questions: [
                    {
                        header: "Nickname",
                        id: "nickname",
                        multiSelect: false,
                        options: [],
                        question: "Choose an optional nickname.",
                        required: false,
                    },
                ],
            },
            id: "event-optional",
            sessionId: "session-1",
            type: "user_input_requested",
        });

        expect(stripAnsi(app.render(100).join("\n"))).toContain("Leave unset");
        app.handleInput("\r");

        await vi.waitFor(() =>
            expect(respondUserInput).toHaveBeenCalledWith("call-optional", { answers: {} }),
        );
    });

    it("keeps activity visible after text_start until the first text delta", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const gate = createTextStartStreamGate("done");
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return gate.stream();
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            tui: fakeTui(),
        });

        submit(app, "stream");
        await gate.startedText;

        const renderedAfterTextStart = stripAnsi(app.render(80).join("\n"));
        expect(renderedAfterTextStart).toContain("◦ Working");
        expect(renderedAfterTextStart).not.toContain("• \n");

        gate.release();
        await app.waitForIdle();

        const renderedAfterDelta = stripAnsi(app.render(80).join("\n"));
        expect(renderedAfterDelta).toContain("• done");
        expect(renderedAfterDelta).not.toContain("◦ Working");
    });

    it("keeps stable transcript rows as source for a width-change redraw", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const contexts: Context[] = [];
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream(_ctx, _model, context) {
                contexts.push(context);
                return streamText(`answer ${contexts.length}`);
            },
        });
        const harness = createJustBashToolHarness();
        const agent = new Agent({
            provider,
            modelId: model.id,
            context: harness.context,
            printToConsole: false,
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent,
            cwd: harness.context.fs.cwd,
            idFactory: createDeterministicIds(),
            processManager: new NativeProcessManager(),
            tui: fakeTui({ rows: 8 }),
        });

        submit(app, "first");
        await app.waitForIdle();
        submit(app, "second");
        await app.waitForIdle();
        submit(app, "third");
        await app.waitForIdle();
        submit(app, "fourth");
        await app.waitForIdle();

        const lines = app.render(80);
        const rendered = stripAnsi(lines.join("\n"));
        expect(lines.length).toBeGreaterThan(8);
        expect(rendered).toContain("› first");
        expect(rendered).toContain("• answer 4");
        expect(rendered.match(/Worked for/gu)).toHaveLength(4);

        const resized = stripAnsi(app.render(48).join("\n"));
        expect(resized).toContain("██████╗");
        expect(resized).toContain("› first");
        expect(resized).toContain("• answer 4");
        expect(resized).toContain("Ask Rig to do anything");

        submit(app, "fifth");
        await app.waitForIdle();
        const nextTurn = stripAnsi(app.render(48).join("\n"));
        expect(nextTurn).toContain("› fifth");
        expect(nextTurn).toContain("• answer 5");
        expect(nextTurn).toContain("› fourth");
    });

    it("lists source-aware secret attachments and defaults attachment scope to Session", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const attachSecret = vi.fn(async () => {});
        const detachSecret = vi.fn(async () => {});
        const unregisterSecret = vi.fn(async () => true);
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            attachSecret,
            cwd: harness.context.fs.cwd,
            detachSecret,
            initialProjectSecretIds: ["project-only", "both"],
            initialSessionSecretIds: ["session-only", "both"],
            listSecrets: async () => [
                {
                    id: "session-only",
                    description: "Session token",
                    environmentVariables: ["SESSION_TOKEN"],
                },
                {
                    id: "project-only",
                    description: "Project token",
                    environmentVariables: ["PROJECT_TOKEN"],
                },
                {
                    id: "both",
                    description: "Shared token",
                    environmentVariables: ["SHARED_TOKEN"],
                },
            ],
            processManager: new NativeProcessManager(),
            registerSecret: async () => ({
                id: "unused",
                description: "Unused",
                environmentVariables: ["UNUSED"],
            }),
            tui: fakeTui(),
            unregisterSecret,
        });

        submit(app, "/secrets");
        await delay(10);

        const listed = stripAnsi(app.render(120).join("\n"));
        expect(listed).toContain("session-only");
        expect(listed).toContain("Attached: Session");
        expect(listed).toContain("project-only");
        expect(listed).toContain("Attached: Project");
        expect(listed).toContain("both");
        expect(listed).toContain("Attached: Session and Project");

        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\r");

        const scopeMenu = stripAnsi(app.render(100).join("\n"));
        expect(scopeMenu.indexOf("Session")).toBeLessThan(scopeMenu.indexOf("Project"));

        app.handleInput("\r");
        await delay(10);

        expect(attachSecret).toHaveBeenCalledWith("project-only", "session");
        expect(stripAnsi(app.render(120).join("\n"))).toContain("Attached: Session and Project");

        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        await delay(10);

        expect(detachSecret).toHaveBeenCalledWith("project-only", "project");

        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        await delay(10);

        expect(unregisterSecret).toHaveBeenCalledWith("session-only");
    });

    it("registers multiple masked values without rendering them or exposing callback errors", async () => {
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const harness = createJustBashToolHarness();
        const registerSecret = vi.fn(
            async (registration: { environment: Record<string, string> }) => {
                throw new Error(`Server echoed ${registration.environment.API_TOKEN}`);
            },
        );
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            attachSecret: async () => {},
            cwd: harness.context.fs.cwd,
            detachSecret: async () => {},
            listSecrets: async () => [],
            processManager: new NativeProcessManager(),
            registerSecret,
            tui: fakeTui(),
            unregisterSecret: async () => true,
        });

        submit(app, "/secrets");
        await delay(10);
        app.handleInput("\r");
        app.handleInput("service");
        app.handleInput("\r");
        app.handleInput("Service credentials");
        app.handleInput("\r");
        app.handleInput("API_TOKEN");
        app.handleInput("\r");
        app.handleInput("top-secret-value");

        const masked = stripAnsi(app.render(100).join("\n"));
        expect(masked).not.toContain("top-secret-value");
        expect(masked).toContain("****************");

        app.handleInput("\r");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        app.handleInput("api_token");
        app.handleInput("\r");

        expect(stripAnsi(app.render(100).join("\n"))).toContain(
            "That environment variable is already in this bundle.",
        );

        app.handleInput("CLIENT_SECRET");
        app.handleInput("\r");
        app.handleInput("also-private");
        app.handleInput("\r");
        app.handleInput("\r");
        await delay(10);

        expect(registerSecret).toHaveBeenCalledWith({
            id: "service",
            description: "Service credentials",
            environment: {
                API_TOKEN: "top-secret-value",
                CLIENT_SECRET: "also-private",
            },
        });
        const rendered = stripAnsi(app.render(120).join("\n"));
        expect(rendered).not.toContain("top-secret-value");
        expect(rendered).not.toContain("also-private");
        expect(rendered).toContain(
            "Could not register the secret. Check the ID and environment names.",
        );
    });

    it("keeps the shared draft while a freeform question borrows the composer", async () => {
        const setDraft = vi.fn(async () => {});
        const respondUserInput = vi.fn(async () => undefined);
        const app = createDraftApp({ draft: "Keep this draft", respondUserInput, setDraft });

        app.applySessionEvent(freeformQuestionEvent());

        // "Type another answer" is the last option, so the composer becomes the
        // answer field for the question.
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");
        expect(stripAnsi(app.render(100).join("\n"))).not.toContain("Keep this draft");

        app.handleInput("MongoDB");
        app.handleInput("\r");

        await vi.waitFor(() =>
            expect(respondUserInput).toHaveBeenCalledWith("question-1", {
                answers: { database: ["MongoDB"] },
            }),
        );
        await delay(400);

        // Answering the question must not clear the draft the other clients show.
        expect(setDraft).not.toHaveBeenCalledWith("", expect.anything());
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Keep this draft");
    });

    it("returns the shared draft when a freeform answer is abandoned", async () => {
        const setDraft = vi.fn(async () => {});
        const respondUserInput = vi.fn(async () => undefined);
        const app = createDraftApp({ draft: "Keep this draft", respondUserInput, setDraft });

        app.applySessionEvent(freeformQuestionEvent());
        app.handleInput("\x1b[B");
        app.handleInput("\x1b[B");
        app.handleInput("\r");

        // Escaping an empty answer goes back to the listed options.
        app.handleInput("\x1b");
        app.handleInput("\r");

        await vi.waitFor(() =>
            expect(respondUserInput).toHaveBeenCalledWith("question-1", {
                answers: { database: ["PostgreSQL"] },
            }),
        );
        await delay(400);

        expect(setDraft).not.toHaveBeenCalledWith("", expect.anything());
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Keep this draft");
    });

    it("restores the session draft into the composer and shares later edits", async () => {
        const setDraft = vi.fn(async () => {});
        const harness = createJustBashToolHarness();
        const model = defineModel({
            id: "openai/gpt-test",
            name: "GPT Test",
            thinkingLevels: ["off"],
            defaultThinkingLevel: "off",
        });
        const provider = defineProvider({
            id: "codex",
            models: [model],
            stream() {
                return streamText("unused");
            },
        });
        const app = new CodingAssistantApp({
            ctx: createTestRootContext().named("app"),
            agent: Object.assign(
                new Agent({
                    provider,
                    modelId: model.id,
                    context: harness.context,
                    printToConsole: false,
                }),
                { draft: "Unsent from the last terminal", setDraft },
            ),
            cwd: harness.context.fs.cwd,
            processManager: new NativeProcessManager(),
            sessionBacked: true,
            tui: fakeTui(),
        });

        // The message typed before the last terminal closed is waiting here.
        expect(stripAnsi(app.render(100).join("\n"))).toContain("Unsent from the last terminal");

        app.handleInput(" and still unsent");
        await vi.waitFor(() =>
            expect(setDraft).toHaveBeenCalledWith(
                "Unsent from the last terminal and still unsent",
                {
                    origin: expect.any(String),
                    updatedAt: expect.any(Number),
                },
            ),
        );

        // A draft written by another client replaces the composer.
        app.applySessionEvent({
            createdAt: 1,
            data: { draft: "Sent from another terminal", origin: "other-terminal" },
            id: "draft-event",
            sessionId: "session-1",
            type: "session_draft_changed",
        } as SessionEvent);

        const rendered = stripAnsi(app.render(100).join("\n"));
        expect(rendered).toContain("Sent from another terminal");
        expect(rendered).not.toContain("Unsent from the last terminal");
    });
});

function createDraftApp(options: {
    draft: string;
    respondUserInput?: (requestId: string, response: unknown) => Promise<void>;
    setDraft: (draft: string, options?: { origin?: string }) => Promise<void>;
}): CodingAssistantApp {
    const model = defineModel({
        id: "openai/gpt-test",
        name: "GPT Test",
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
    });
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream() {
            return streamText("unused");
        },
    });
    const harness = createJustBashToolHarness();
    return new CodingAssistantApp({
        ctx: createTestRootContext().named("app"),
        agent: Object.assign(
            new Agent({
                provider,
                modelId: model.id,
                context: harness.context,
                printToConsole: false,
            }),
            { draft: options.draft, setDraft: options.setDraft },
        ),
        cwd: harness.context.fs.cwd,
        processManager: new NativeProcessManager(),
        ...(options.respondUserInput === undefined
            ? {}
            : { respondUserInput: options.respondUserInput }),
        sessionBacked: true,
        tui: fakeTui(),
    });
}

function freeformQuestionEvent(): SessionEvent {
    return {
        createdAt: 1,
        data: {
            requestId: "question-1",
            questions: [
                {
                    header: "Database",
                    id: "database",
                    multiSelect: false,
                    options: [
                        { label: "PostgreSQL", description: "Use the relational stack." },
                        { label: "SQLite", description: "Keep it lightweight." },
                    ],
                    question: "Which database should this use?",
                },
            ],
        },
        id: "question-event",
        sessionId: "session-1",
        type: "user_input_requested",
    } as SessionEvent;
}

function createDeterministicIds(): () => string {
    let next = 0;
    return () => `app-id-${++next}`;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function fakeTui(options: { rows?: number; columns?: number } = {}): TUI {
    return {
        addChild: vi.fn(),
        requestRender: vi.fn(),
        setFocus: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        terminal: {
            rows: options.rows ?? 20,
            columns: options.columns ?? 80,
            write: vi.fn(),
        },
    } as unknown as TUI;
}

class SlowKillProcessManager extends NativeProcessManager {
    killAllStarted = false;
    #finishKillAll: (() => void) | undefined;

    override async killAll(..._args: Parameters<NativeProcessManager["killAll"]>): Promise<void> {
        this.killAllStarted = true;
        await new Promise<void>((resolve) => {
            this.#finishKillAll = resolve;
        });
    }

    finishKillAll(): void {
        this.#finishKillAll?.();
    }
}

function submit(app: CodingAssistantApp, text: string): void {
    app.handleInput(text);
    app.handleInput("\r");
}

function streamText(text: string): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            yield { type: "text_start" as const, contentIndex: 0, partial: message };
            yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: "hello ",
                partial: message,
            };
            yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: "from agent",
                partial: message,
            };
            yield {
                type: "text_end" as const,
                contentIndex: 0,
                content: text,
                partial: message,
            };
            yield { type: "done" as const, reason: "stop", message };
        },
        async result() {
            return message;
        },
    };
}

function streamMessage(message: AssistantMessage): InferenceStream {
    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            if (message.stopReason === "error" || message.stopReason === "aborted") {
                yield {
                    type: "error" as const,
                    reason: message.stopReason,
                    error: message,
                };
                return;
            }
            yield {
                type: "done" as const,
                reason: message.stopReason,
                message,
            };
        },
        async result() {
            return message;
        },
    };
}

function streamAbortAfterSignal(
    signal: AbortSignal | undefined,
    started: () => void,
): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "aborted",
        timestamp: 1,
        errorMessage: "request aborted: message aborted",
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            started();
            if (!signal?.aborted) {
                await new Promise<void>((resolve) => {
                    signal?.addEventListener("abort", () => resolve(), { once: true });
                });
            }
            yield {
                type: "error" as const,
                reason: "aborted" as const,
                error: message,
            };
        },
        async result() {
            return message;
        },
    };
}

function createThinkingStreamGate(text: string): {
    release: () => void;
    startedThinking: Promise<void>;
    stream: () => InferenceStream;
} {
    let release: () => void = () => {};
    let startedThinking: () => void = () => {};
    const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
    });
    const startedThinkingPromise = new Promise<void>((resolve) => {
        startedThinking = resolve;
    });

    return {
        release,
        startedThinking: startedThinkingPromise,
        stream() {
            return streamThinking(text, startedThinking, releasePromise);
        },
    };
}

function createTextStartStreamGate(text: string): {
    release: () => void;
    startedText: Promise<void>;
    stream: () => InferenceStream;
} {
    let release: () => void = () => {};
    let startedText: () => void = () => {};
    const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
    });
    const startedTextPromise = new Promise<void>((resolve) => {
        startedText = resolve;
    });

    return {
        release,
        startedText: startedTextPromise,
        stream() {
            return streamTextStart(text, startedText, releasePromise);
        },
    };
}

function createBeforeTextStartStreamGate(text: string): {
    release: () => void;
    started: Promise<void>;
    stream: () => InferenceStream;
} {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
    });

    return {
        release,
        started: startedPromise,
        stream() {
            started();
            return streamBeforeTextStart(text, releasePromise);
        },
    };
}

function createToolCallStartStreamGate(): {
    release: () => void;
    startedToolCall: Promise<void>;
    stream: () => InferenceStream;
} {
    let release: () => void = () => {};
    let startedToolCall: () => void = () => {};
    const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
    });
    const startedToolCallPromise = new Promise<void>((resolve) => {
        startedToolCall = resolve;
    });

    return {
        release,
        startedToolCall: startedToolCallPromise,
        stream() {
            return streamTextThenToolCall(startedToolCall, releasePromise);
        },
    };
}

function streamThinking(
    text: string,
    startedThinking: () => void,
    releasePromise: Promise<void>,
): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            yield { type: "thinking_start" as const, contentIndex: 0, partial: message };
            startedThinking();
            await releasePromise;
            yield { type: "text_start" as const, contentIndex: 0, partial: message };
            yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: text,
                partial: message,
            };
            yield {
                type: "text_end" as const,
                contentIndex: 0,
                content: text,
                partial: message,
            };
            yield { type: "done" as const, reason: "stop", message };
        },
        async result() {
            return message;
        },
    };
}

function streamTextThenToolCall(
    startedToolCall: () => void,
    releasePromise: Promise<void>,
): InferenceStream {
    const text = "I will inspect files.";
    const toolCall = {
        type: "toolCall" as const,
        id: "tool-call-1",
        name: "test_command",
        arguments: { cmd: "printf ok" },
    };
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }, toolCall],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "toolUse",
        timestamp: 1,
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            yield { type: "text_start" as const, contentIndex: 0, partial: message };
            yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: text,
                partial: message,
            };
            yield {
                type: "text_end" as const,
                contentIndex: 0,
                content: text,
                partial: message,
            };
            yield { type: "toolcall_start" as const, contentIndex: 1, partial: message };
            yield {
                type: "toolcall_delta" as const,
                contentIndex: 1,
                delta: '{"cmd":"printf ok"}',
                partial: message,
            };
            startedToolCall();
            await releasePromise;
            yield {
                type: "toolcall_end" as const,
                contentIndex: 1,
                toolCall,
                partial: message,
            };
            yield { type: "done" as const, reason: "toolUse", message };
        },
        async result() {
            return message;
        },
    };
}

function streamThinkingText(thinking: string, text: string): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "thinking", thinking },
            { type: "text", text },
        ],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };
    const midpoint = Math.floor(thinking.length / 2);

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            yield { type: "thinking_start" as const, contentIndex: 0, partial: message };
            yield {
                type: "thinking_delta" as const,
                contentIndex: 0,
                delta: thinking.slice(0, midpoint),
                partial: message,
            };
            yield {
                type: "thinking_delta" as const,
                contentIndex: 0,
                delta: thinking.slice(midpoint),
                partial: message,
            };
            yield {
                type: "thinking_end" as const,
                contentIndex: 0,
                content: thinking,
                partial: message,
            };
            yield { type: "text_start" as const, contentIndex: 1, partial: message };
            yield {
                type: "text_delta" as const,
                contentIndex: 1,
                delta: text,
                partial: message,
            };
            yield {
                type: "text_end" as const,
                contentIndex: 1,
                content: text,
                partial: message,
            };
            yield { type: "done" as const, reason: "stop", message };
        },
        async result() {
            return message;
        },
    };
}

function streamTextStart(
    text: string,
    startedText: () => void,
    releasePromise: Promise<void>,
): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            yield { type: "text_start" as const, contentIndex: 0, partial: message };
            startedText();
            await releasePromise;
            yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: text,
                partial: message,
            };
            yield {
                type: "text_end" as const,
                contentIndex: 0,
                content: text,
                partial: message,
            };
            yield { type: "done" as const, reason: "stop", message };
        },
        async result() {
            return message;
        },
    };
}

function streamBeforeTextStart(text: string, releasePromise: Promise<void>): InferenceStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "test",
        provider: "codex",
        model: "openai/gpt-test",
        usage: zeroUsage(),
        stopReason: "stop",
        timestamp: 1,
    };

    return {
        async *[Symbol.asyncIterator]() {
            yield { type: "start" as const, partial: message };
            await releasePromise;
            yield { type: "text_start" as const, contentIndex: 0, partial: message };
            yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: text,
                partial: message,
            };
            yield {
                type: "text_end" as const,
                contentIndex: 0,
                content: text,
                partial: message,
            };
            yield { type: "done" as const, reason: "stop", message };
        },
        async result() {
            return message;
        },
    };
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
}

function createPluginContext(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
        async callAppTool() {
            throw new Error("Unused in this test.");
        },
        async discoverRepository() {
            throw new Error("Unused in this test.");
        },
        async install() {
            throw new Error("Unused in this test.");
        },
        async installFromGitHub() {
            throw new Error("Unused in this test.");
        },
        async list() {
            return {
                failures: [],
                plugins: [],
                version: "01900000-0000-7000-8000-000000000001",
            };
        },
        async readIcon() {
            throw new Error("Unused in this test.");
        },
        async loadSkills() {
            return [];
        },
        readAppResource() {
            throw new Error("Unused in this test.");
        },
        async readLog() {
            throw new Error("Unused in this test.");
        },
        async storageDelete() {},
        async storageGet() {
            return undefined;
        },
        async storageList() {
            return [];
        },
        async storageSet() {},
        async uninstall() {
            throw new Error("Unused in this test.");
        },
        ...overrides,
    };
}

function completedCompaction(context: Context) {
    return {
        status: "completed" as const,
        context: {
            ...context,
            messages: [
                {
                    role: "user" as const,
                    content: "A concise continuation brief.",
                    timestamp: 1,
                },
            ],
        },
        usage: zeroUsage(),
    };
}

/** These exercise boundary handling, not transcript rebuilding. */
function emptyTranscript() {
    return { complete: true, messages: [], turns: [] };
}
