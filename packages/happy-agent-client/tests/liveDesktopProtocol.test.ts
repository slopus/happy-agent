import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    healthResponseSchema,
    liveControlClientMessageSchema,
    liveControlServerMessageSchema,
    liveDesktopActionResultSchema,
    liveDesktopActionSchema,
    liveDesktopContextSchema,
    liveDesktopTargetSchema,
    type LiveDesktopAction,
    type LiveDesktopContext,
} from "../sources/index.js";

const target = { connectionId: "local", groupId: "workspace-one", sessionId: "session-one" };
const context: LiveDesktopContext = {
    windowId: "desktop-window",
    connections: [{ connectionId: "local", name: "This computer", online: true }],
    activeConnectionId: "local",
    activeTarget: { kind: "session", ...target },
    projects: [
        {
            target: {
                kind: "project",
                connectionId: "local",
                projectId: "project-one",
                groupId: "project-group",
            },
            name: "Happy",
        },
    ],
    workspaces: [
        {
            target: {
                kind: "workspace",
                connectionId: "local",
                projectId: "project-one",
                workspaceId: "workspace-one",
                groupId: "workspace-one",
            },
            name: "Voice",
            status: "ready",
        },
    ],
    sessions: [{ target, title: "Add voice", status: "awaitingInput" }],
    bots: [],
    activeSession: {
        target,
        status: "running",
        messages: [{ id: "m1", role: "assistant", text: "Working on it." }],
        composerHasDraft: true,
        writeRefusal: null,
    },
    truncated: false,
};

const actions: LiveDesktopAction[] = [
    { type: "desktopState" },
    { type: "desktopOpen", target: { kind: "session", ...target } },
    { type: "workspaceCreate", project: { connectionId: "local", projectId: "project-one" } },
    {
        type: "sessionCreate",
        group: { connectionId: "local", groupId: "workspace-one" },
        prompt: "Draft task",
    },
    { type: "botCreate", connectionId: "local", name: "Scout", prompt: "Draft instructions" },
    { type: "sessionRead", target },
    { type: "sessionSend", target, text: "Review this change" },
    { type: "sessionWatch", target, enabled: true },
    { type: "composerDraftAppend", target, text: "Also add tests" },
];

describe("GPT-Live desktop control protocol", () => {
    it.each(actions)("supports the fixed $type action", (action) => {
        expect(Value.Check(liveDesktopActionSchema, action)).toBe(true);
        expect(
            Value.Check(liveControlServerMessageSchema, {
                type: "actionRequested",
                actionId: "action-1",
                contextRevision: 1,
                inputTranscriptIds: ["fragment-1"],
                action,
            }),
        ).toBe(true);
    });

    it.each([
        "shell",
        "executeJavaScript",
        "apiCall",
        "permissionAllow",
        "questionAnswer",
        "sessionAbort",
    ])("does not expose %s", (type) => {
        expect(Value.Check(liveDesktopActionSchema, { type })).toBe(false);
    });

    it.each(actions)("rejects injected authority on $type", (action) => {
        expect(
            Value.Check(liveDesktopActionSchema, { ...action, permissionMode: "full_access" }),
        ).toBe(false);
    });

    it("requires every namespace and explicit group identity", () => {
        expect(Value.Check(liveDesktopContextSchema, context)).toBe(true);
        expect(Value.Check(liveDesktopTargetSchema, context.projects[0]!.target)).toBe(true);
        expect(
            Value.Check(liveDesktopTargetSchema, {
                kind: "project",
                connectionId: "local",
                projectId: "project-one",
            }),
        ).toBe(false);
        expect(
            Value.Check(liveDesktopActionSchema, {
                type: "sessionRead",
                target: { groupId: target.groupId, sessionId: target.sessionId },
            }),
        ).toBe(false);
        expect(
            Value.Check(liveDesktopActionSchema, {
                type: "sessionRead",
                target: { ...target, connectionId: "" },
            }),
        ).toBe(false);
        expect(
            Value.Check(liveDesktopActionSchema, {
                type: "sessionRead",
                target: { ...target, connectionId: "peer\n" },
            }),
        ).toBe(false);
    });

    it("keeps pending distinct from completion", () => {
        expect(Value.Check(liveDesktopActionResultSchema, { status: "pending" })).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "succeeded",
                output: { type: "pending" },
            }),
        ).toBe(false);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "succeeded",
                output: { type: "context", context },
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "succeeded",
                output: { type: "created", target: { kind: "session", ...target } },
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "refused",
                code: "staleContext",
                message: "The selected conversation changed.",
            }),
        ).toBe(true);
        expect(
            Value.Check(liveDesktopActionResultSchema, {
                status: "refused",
                code: "run_shell",
                message: "No",
            }),
        ).toBe(false);
    });

    it("excludes private reasoning, tools, and draft contents from context", () => {
        for (const role of ["system", "developer", "tool", "reasoning"]) {
            expect(
                Value.Check(liveDesktopContextSchema, {
                    ...context,
                    activeSession: {
                        ...context.activeSession,
                        messages: [{ id: "m1", role, text: "private" }],
                    },
                }),
            ).toBe(false);
        }
        expect(
            Value.Check(liveDesktopContextSchema, {
                ...context,
                activeSession: { ...context.activeSession, draftText: "private draft" },
            }),
        ).toBe(false);
        expect(Value.Check(liveDesktopContextSchema, { ...context, token: "secret" })).toBe(false);
        expect(
            Value.Check(liveDesktopContextSchema, {
                ...context,
                activeSession: {
                    ...context.activeSession,
                    messages: [
                        { id: "m1", role: "assistant", text: "public", reasoning: "private" },
                    ],
                },
            }),
        ).toBe(false);
    });

    it("bounds catalogs, messages, text, and source identities", () => {
        expect(
            Value.Check(liveDesktopContextSchema, {
                ...context,
                connections: Array.from({ length: 101 }, () => context.connections[0]),
            }),
        ).toBe(false);
        expect(
            Value.Check(liveDesktopContextSchema, {
                ...context,
                activeSession: {
                    ...context.activeSession,
                    messages: Array.from({ length: 51 }, () => ({
                        id: "m1",
                        role: "user",
                        text: "hi",
                    })),
                },
            }),
        ).toBe(false);
        for (const text of ["", " ", "x".repeat(16_385)]) {
            expect(
                Value.Check(liveDesktopActionSchema, { type: "composerDraftAppend", target, text }),
            ).toBe(false);
        }
        expect(
            Value.Check(liveControlServerMessageSchema, {
                type: "actionRequested",
                actionId: "a1",
                contextRevision: 1,
                inputTranscriptIds: ["f1", "f1"],
                action: actions[0],
            }),
        ).toBe(false);
    });

    it("validates both control directions and positive safe context revisions", () => {
        expect(
            Value.Check(liveControlClientMessageSchema, {
                type: "desktopContext",
                revision: 1,
                context,
            }),
        ).toBe(true);
        for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(
                Value.Check(liveControlClientMessageSchema, {
                    type: "desktopContext",
                    revision,
                    context,
                }),
            ).toBe(false);
        }
        expect(
            Value.Check(liveControlClientMessageSchema, {
                type: "actionResult",
                actionId: "a1",
                result: { status: "pending" },
            }),
        ).toBe(true);
        expect(
            Value.Check(liveControlClientMessageSchema, {
                type: "sessionUpdate",
                target,
                status: "waiting",
                messages: [],
                truncated: false,
            }),
        ).toBe(true);
        expect(
            Value.Check(liveControlClientMessageSchema, {
                type: "hello",
                sessionId: "l1",
                windowId: "w1",
                contextRevision: 1,
            }),
        ).toBe(false);
        expect(
            Value.Check(liveControlServerMessageSchema, {
                type: "hello",
                sessionId: "l1",
                windowId: "w1",
                contextRevision: 1,
            }),
        ).toBe(true);
        expect(
            Value.Check(liveControlServerMessageSchema, {
                type: "status",
                status: "failed",
                error: "Voice is unavailable.",
            }),
        ).toBe(true);
    });

    it("carries transcript fragments without invented completed turns", () => {
        const fragment = {
            type: "transcript",
            transcriptId: "f1",
            role: "user",
            text: " the the ",
            startMs: 100,
            endMs: 500,
        };
        expect(Value.Check(liveControlServerMessageSchema, fragment)).toBe(true);
        expect(Value.Check(liveControlServerMessageSchema, { ...fragment, final: true })).toBe(
            false,
        );
        expect(Value.Check(liveControlServerMessageSchema, { ...fragment, role: "tool" })).toBe(
            false,
        );
        expect(Value.Check(liveControlServerMessageSchema, { ...fragment, startMs: -1 })).toBe(
            false,
        );
    });

    it("uses the same CUID2 identity for control hello and the Live resource", () => {
        expect(
            Value.Check(liveControlServerMessageSchema, {
                type: "hello",
                sessionId: "foreign/session",
                windowId: "window-1",
                contextRevision: 1,
            }),
        ).toBe(false);
    });

    it("keeps capability detection optional on older health responses", () => {
        const health = {
            healthy: true,
            ready: true,
            status: "ready",
            version: { protocol: 25, daemon: "test" },
        };
        expect(Value.Check(healthResponseSchema, health)).toBe(true);
        expect(
            Value.Check(healthResponseSchema, {
                ...health,
                capabilities: { desktopLiveControl: true },
            }),
        ).toBe(true);
        expect(
            Value.Check(healthResponseSchema, {
                ...health,
                capabilities: { desktopLiveControl: "true" },
            }),
        ).toBe(false);
    });

    it("builds the namespaced control URL without putting credentials in it", () => {
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=route",
            token: "private-token",
        });
        const url = new URL(client.liveSessionControlUrl("id/with space", "window #one"));
        expect(url.pathname).toBe("/prefix/v0/live/sessions/id%2Fwith%20space/control");
        expect(url.searchParams.get("windowId")).toBe("window #one");
        expect(url.searchParams.get("transport")).toBe("route");
        expect(url.toString()).not.toContain("private-token");
    });
});
