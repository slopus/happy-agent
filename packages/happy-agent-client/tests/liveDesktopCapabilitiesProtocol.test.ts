import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    LIVE_DESKTOP_CAPABILITIES,
    configPatchSchema,
    configResponseSchema,
    createLiveSessionRequestSchema,
    healthResponseSchema,
    liveAppStateSchema,
    liveControlClientMessageSchema,
    liveControlServerMessageSchema,
    liveDesktopActionResultSchema,
    liveDesktopActionSchema,
    liveDesktopTargetSchema,
    voiceConfigPatchSchema,
    voiceConfigSchema,
    type LiveAppState,
} from "../sources/index.js";

const session = { connectionId: "local", groupId: "workspace-one", sessionId: "session-one" };
const task = {
    kind: "task",
    connectionId: "local",
    groupId: "task-workspace",
    sessionId: "task-agent",
    taskId: "task-one",
} as const;
const appState: LiveAppState = {
    timeZone: "America/Los_Angeles",
    servers: [
        {
            connectionId: "local",
            name: "This Mac",
            kind: "local",
            online: true,
            catalog: "ready",
            bots: [
                {
                    target: {
                        kind: "bot",
                        connectionId: "local",
                        groupId: "bot-workspace",
                        sessionId: "bot-agent",
                        botId: "bot-one",
                    },
                    name: "Happy",
                    status: "running",
                    lastActivityAt: 1_791_675_600_000,
                },
            ],
            tasks: [{ target: task, name: "Fix login", status: "idle", lastActivityAt: null }],
            projects: [
                {
                    target: {
                        kind: "project",
                        connectionId: "local",
                        projectId: "project-one",
                        groupId: "project-group",
                    },
                    name: "Observatory",
                    sessions: [],
                    workspaces: [
                        {
                            target: {
                                kind: "workspace",
                                connectionId: "local",
                                projectId: "project-one",
                                workspaceId: "workspace-one",
                                groupId: "workspace-one",
                            },
                            name: "Garden",
                            status: "ready",
                            sessions: [
                                {
                                    target: session,
                                    title: "Garden notes",
                                    status: "idle",
                                    lastActivityAt: 1_791_675_600_000,
                                },
                            ],
                        },
                    ],
                },
            ],
            models: [
                {
                    providerId: "claude",
                    providerName: "Claude",
                    modelId: "anthropic/sonnet-5",
                    name: "Sonnet 5",
                    efforts: ["low", "medium", "high"],
                    defaultEffort: "medium",
                },
            ],
        },
    ],
    focused: {
        target: { kind: "session", ...session },
        title: "Garden notes",
        latestMessage: { state: "loaded", role: "assistant", text: "Done.", truncated: false },
    },
    truncated: false,
};

describe("GPT-Live desktop capability protocol", () => {
    it("names the six additive capabilities", () => {
        expect(LIVE_DESKTOP_CAPABILITIES).toEqual([
            "appState",
            "voiceFocus",
            "taskCreate",
            "sessionModelChange",
            "agentTargets",
            "failureReasons",
        ]);
    });

    it("carries a typed failure reason only as an optional field", () => {
        const status = { type: "status", status: "failed", error: "The sign-in expired." };
        expect(Value.Check(liveControlServerMessageSchema, status)).toBe(true);
        expect(Value.Check(liveControlServerMessageSchema, { ...status, reason: "signIn" })).toBe(
            true,
        );
        expect(Value.Check(liveControlServerMessageSchema, { ...status, reason: "other" })).toBe(
            false,
        );
    });

    it("lets actions and results name a local agent but keeps context and focus on desktop targets", () => {
        const agent = { kind: "agent", connectionId: "local", agentId: "voiceagent1" } as const;
        for (const action of [
            { type: "desktopOpen", target: agent },
            { type: "sessionRead", target: agent },
            { type: "sessionSend", target: agent, text: "Please rerun the tests." },
            { type: "composerDraftAppend", target: agent, text: "Also add tests" },
            { type: "sessionModelChange", target: agent, providerId: "codex", modelId: "m" },
        ])
            expect(Value.Check(liveDesktopActionSchema, action)).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "succeeded",
                output: { type: "created", target: agent },
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "succeeded",
                output: {
                    type: "session",
                    target: agent,
                    status: "idle",
                    messages: [],
                    truncated: false,
                },
            }),
        ).toBe(true);
        expect(Value.Check(liveDesktopTargetSchema, agent)).toBe(false);
        expect(
            Value.Check(liveControlServerMessageSchema, {
                type: "voiceFocus",
                focusId: "f1",
                contextRevision: 1,
                target: agent,
                reason: "mention",
            }),
        ).toBe(false);
        expect(
            Value.Check(liveControlClientMessageSchema, {
                type: "sessionUpdate",
                target: agent,
                status: "idle",
                messages: [],
                truncated: false,
            }),
        ).toBe(false);
        for (const invalid of [
            { ...agent, agentId: "" },
            { ...agent, agentId: "x".repeat(129) },
            { ...agent, sessionId: "extra" },
        ])
            expect(
                Value.Check(liveDesktopActionSchema, { type: "desktopOpen", target: invalid }),
            ).toBe(false);
    });

    it("accepts a complete AppState with tasks, models, and every latest-message state", () => {
        expect(Value.Check(liveAppStateSchema, appState)).toBe(true);
        for (const latestMessage of [{ state: "empty" }, { state: "notLoaded" }]) {
            expect(
                Value.Check(liveAppStateSchema, {
                    ...appState,
                    focused: { ...appState.focused, latestMessage },
                }),
            ).toBe(true);
        }
        expect(Value.Check(liveAppStateSchema, { ...appState, focused: null })).toBe(true);
    });

    it("keeps private and unbounded data out of AppState", () => {
        expect(Value.Check(liveAppStateSchema, { ...appState, draft: "secret" })).toBe(false);
        expect(
            Value.Check(liveAppStateSchema, {
                ...appState,
                focused: {
                    ...appState.focused,
                    latestMessage: { state: "loaded", role: "tool", text: "x", truncated: false },
                },
            }),
        ).toBe(false);
        expect(
            Value.Check(liveAppStateSchema, {
                ...appState,
                servers: Array.from({ length: 33 }, () => appState.servers[0]),
            }),
        ).toBe(false);
        expect(Value.Check(liveAppStateSchema, { ...appState, timeZone: "" })).toBe(false);
        expect(
            Value.Check(liveAppStateSchema, {
                ...appState,
                servers: [{ ...appState.servers[0], subtasks: [] }],
            }),
        ).toBe(false);
    });

    it("adds the task target and both new actions", () => {
        expect(Value.Check(liveDesktopTargetSchema, task)).toBe(true);
        expect(
            Value.Check(liveDesktopActionSchema, {
                type: "taskCreate",
                connectionId: "local",
                name: "Fix login",
                text: "Investigate the redirect loop.",
                model: { providerId: "claude", modelId: "anthropic/sonnet-5" },
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionSchema, {
                type: "taskCreate",
                connectionId: "local",
                text: "Investigate.",
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionSchema, {
                type: "sessionModelChange",
                target: session,
                providerId: "claude",
                modelId: "anthropic/sonnet-5",
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "succeeded",
                output: { type: "created", target: task },
            }),
        ).toBe(true);
    });

    it("requires the opening text, a complete model choice, and an explicit session", () => {
        for (const invalid of [
            { type: "taskCreate", connectionId: "local" },
            { type: "taskCreate", connectionId: "local", text: " " },
            {
                type: "taskCreate",
                connectionId: "local",
                text: "x",
                model: { providerId: "claude" },
            },
            { type: "taskCreate", connectionId: "local", text: "x", sent: true },
            { type: "sessionModelChange", providerId: "claude", modelId: "anthropic/sonnet-5" },
            {
                type: "sessionModelChange",
                target: session,
                providerId: "claude",
                modelId: "anthropic/sonnet-5",
                effort: "max",
            },
            { type: "composerDraftAppend", text: "Also add tests" },
        ]) {
            expect(Value.Check(liveDesktopActionSchema, invalid)).toBe(false);
        }
    });

    it("negotiates capabilities in creation and hello without breaking older peers", () => {
        const base = {
            windowId: "window-1",
            sdp: "offer",
            credential: { type: "codex_subscription", providerId: "codex" },
            contextRevision: 1,
            context: {
                windowId: "window-1",
                connections: [],
                activeConnectionId: null,
                activeTarget: null,
                projects: [],
                workspaces: [],
                sessions: [],
                bots: [],
                activeSession: null,
                truncated: false,
            },
        };
        expect(Value.Check(createLiveSessionRequestSchema, base)).toBe(true);
        expect(
            Value.Check(createLiveSessionRequestSchema, {
                ...base,
                desktopCapabilities: ["appState", "voiceFocus", "somethingNew"],
                appState,
            }),
        ).toBe(true);
        expect(
            Value.Check(createLiveSessionRequestSchema, {
                ...base,
                desktopCapabilities: ["appState", "agentTargets"],
                appState,
                localConnectionId: "local",
            }),
        ).toBe(true);
        expect(
            Value.Check(createLiveSessionRequestSchema, { ...base, localConnectionId: "" }),
        ).toBe(false);
        expect(
            Value.Check(createLiveSessionRequestSchema, {
                ...base,
                desktopCapabilities: ["appState", "appState"],
            }),
        ).toBe(false);
        const hello = { type: "hello", sessionId: "l1", windowId: "w1", contextRevision: 1 };
        expect(Value.Check(liveControlServerMessageSchema, hello)).toBe(true);
        expect(
            Value.Check(liveControlServerMessageSchema, { ...hello, capabilities: ["appState"] }),
        ).toBe(true);
    });

    it("carries AppState and voice focus frames", () => {
        expect(Value.Check(liveControlClientMessageSchema, { type: "appState", appState })).toBe(
            true,
        );
        const focus = {
            type: "voiceFocus",
            focusId: "focus-1",
            contextRevision: 3,
            target: task,
            reason: "mention",
        };
        expect(Value.Check(liveControlServerMessageSchema, focus)).toBe(true);
        expect(
            Value.Check(liveControlServerMessageSchema, {
                ...focus,
                target: null,
                reason: "navigation",
            }),
        ).toBe(true);
        expect(Value.Check(liveControlServerMessageSchema, { ...focus, reason: "navigate" })).toBe(
            false,
        );
        expect(Value.Check(liveControlClientMessageSchema, focus)).toBe(false);
    });

    it("advertises desktop capabilities in health", () => {
        expect(
            Value.Check(healthResponseSchema, {
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol: 25, daemon: "test" },
                capabilities: {
                    desktopLiveControl: true,
                    desktopLiveCapabilities: [...LIVE_DESKTOP_CAPABILITIES],
                },
            }),
        ).toBe(true);
    });

    it("reads and patches voice settings", () => {
        const voice = {
            controller: { providerId: null, modelId: null, effort: null, fastMode: false },
            effectiveController: {
                providerId: "codex",
                modelId: "openai/gpt-6.1-sol",
                effort: "low",
                serviceTier: null,
                notice: null,
            },
            defaultSystemPrompt: "You are Happy.",
            systemPromptOverride: null,
            effectiveSystemPrompt: "You are Happy.",
        };
        expect(Value.Check(voiceConfigSchema, voice)).toBe(true);
        expect(
            Value.Check(voiceConfigPatchSchema, {
                controller: { providerId: "claude", modelId: "anthropic/sonnet-5", effort: null },
                systemPrompt: null,
            }),
        ).toBe(true);
        expect(Value.Check(voiceConfigPatchSchema, { controller: { fastMode: true } })).toBe(true);
        expect(Value.Check(voiceConfigPatchSchema, { controller: { fastMode: null } })).toBe(true);
        for (const invalid of [
            { systemPrompt: "" },
            { systemPrompt: "   " },
            { systemPrompt: "x".repeat(32_769) },
            { controller: { model: "x" } },
            { instructions: "x" },
        ]) {
            expect(Value.Check(voiceConfigPatchSchema, invalid)).toBe(false);
        }
        expect(Value.Check(configPatchSchema, { voice: { systemPrompt: "Be brief." } })).toBe(true);
        expect(Value.Check(configResponseSchema.properties.config.properties.voice, voice)).toBe(
            true,
        );
    });
});
