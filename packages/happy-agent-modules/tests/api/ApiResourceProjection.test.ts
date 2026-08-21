import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { eventIdSchema } from "../../sources/events/index.js";
import { apiResourceVersion } from "../../sources/api/ApiResourceProjection.js";
import {
    messageHiddenFromUser,
    messageResource,
    providerMessageContent,
    reviewedToolCalls,
} from "../../sources/api/ApiMessageProjection.js";
import { toolCallResource } from "../../sources/api/ApiToolPresentation.js";

describe("apiResourceVersion", () => {
    it("projects a numeric module version into a deterministic ordered UUIDv7", () => {
        const first = apiResourceVersion(1_755_400_000_000, 7, "project-a");
        const repeated = apiResourceVersion(1_755_400_000_000, 7, "project-a");
        const next = apiResourceVersion(1_755_400_000_000, 8, "project-a");

        expect(Value.Check(eventIdSchema, first)).toBe(true);
        expect(repeated).toBe(first);
        expect(next > first).toBe(true);
    });

    it("keeps resource identities distinct at the same timestamp and counter", () => {
        expect(apiResourceVersion(1, 1, "a")).not.toBe(apiResourceVersion(1, 1, "b"));
    });
});

describe("messageHiddenFromUser", () => {
    it("hides a durable AGENTS.md notice the daemon injected for the model alone", () => {
        expect(
            messageHiddenFromUser({
                at: 100,
                blocks: [
                    {
                        type: "text",
                        text: "These AGENTS.md instructions replace earlier instructions.",
                    },
                ],
                hideFromUser: true,
                recordId: "agents-md-notice",
                role: "system",
            }),
        ).toBe(true);
    });

    it("shows a system notice the daemon did not mark internal", () => {
        expect(
            messageHiddenFromUser({
                at: 100,
                blocks: [{ type: "text", text: "The workspace moved." }],
                recordId: "system-notice",
                role: "system",
            }),
        ).toBe(false);
    });
});

describe("messageResource", () => {
    it("projects a durable system notice with its role intact", () => {
        expect(
            messageResource({
                at: 100,
                blocks: [{ type: "text", text: "The workspace moved." }],
                recordId: "system-notice",
                role: "system",
            }),
        ).toEqual({
            id: "system-notice",
            role: "system",
            createdAt: 100,
            content: [{ type: "text", text: "The workspace moved." }],
            metadata: {},
        });
    });

    it("projects a completed command with the same display-ready tool presentation", () => {
        expect(
            messageResource({
                at: 100,
                blocks: [
                    {
                        type: "tool_call",
                        callId: "call-a",
                        name: "exec_command",
                        arguments: { cmd: "pnpm test" },
                    },
                    {
                        type: "tool_result",
                        callId: "call-a",
                        toolName: "exec_command",
                        display: "Tool exec_command returned 9 characters.",
                        output: "42 passed",
                    },
                ],
                recordId: "message-a",
                role: "assistant",
            }),
        ).toEqual({
            id: "message-a",
            role: "agent",
            createdAt: 100,
            content: [
                {
                    type: "tool_call",
                    id: "call-a",
                    name: "exec_command",
                    status: "completed",
                    arguments: { cmd: "pnpm test" },
                    result: { output: "42 passed" },
                    presentation: {
                        type: "exec_command",
                        command: "pnpm test",
                        output: "42 passed",
                    },
                },
            ],
            metadata: {},
        });
    });

    it("projects typed message provenance and keeps permission review on live tool updates", () => {
        const historyMessage = {
            at: 100,
            blocks: [
                {
                    type: "tool_call" as const,
                    callId: "call-reviewed",
                    name: "exec_command",
                    arguments: { cmd: "git push" },
                    elevated: true,
                    review: {
                        outcome: "allowed" as const,
                        reason: "The user explicitly asked to push.",
                        risk: "high" as const,
                        userAuthorization: "high" as const,
                    },
                },
            ],
            model: "openai/gpt-5.6-sol",
            provider: "codex",
            recordId: "message-reviewed",
            role: "assistant" as const,
        };

        expect(messageResource(historyMessage)).toMatchObject({
            metadata: { modelId: "openai/gpt-5.6-sol", providerId: "codex" },
            content: [
                {
                    type: "tool_call",
                    elevated: true,
                    review: {
                        outcome: "allowed",
                        reason: "The user explicitly asked to push.",
                        risk: "high",
                        userAuthorization: "high",
                    },
                },
            ],
        });
        expect(
            providerMessageContent(
                [
                    {
                        type: "toolCall",
                        id: "call-reviewed",
                        name: "exec_command",
                        arguments: { cmd: "git push" },
                    },
                ],
                reviewedToolCalls(historyMessage),
            ),
        ).toMatchObject([
            {
                type: "tool_call",
                elevated: true,
                review: { outcome: "allowed" },
            },
        ]);
    });

    it("uses exactly the same completed tool-call shape for events and history", () => {
        const historical = messageResource({
            at: 100,
            blocks: [
                {
                    type: "tool_call",
                    callId: "call-a",
                    name: "exec_command",
                    arguments: { cmd: "pnpm test" },
                },
                {
                    type: "tool_result",
                    callId: "call-a",
                    toolName: "exec_command",
                    display: "Tool exec_command returned 9 characters.",
                    output: "42 passed",
                },
            ],
            recordId: "message-a",
            role: "assistant",
        });
        const live = providerMessageContent([
            {
                type: "toolCall",
                id: "call-a",
                name: "exec_command",
                arguments: { cmd: "pnpm test" },
            },
            {
                type: "tool_result",
                toolCallId: "call-a",
                toolName: "exec_command",
                display: "Tool exec_command returned 9 characters.",
                rendered: [{ type: "text", text: "42 passed" }],
            },
        ]);

        expect(live).toEqual(historical.content);
    });

    it("omits raw data only after projecting a presentation", () => {
        const message = messageResource(
            {
                at: 100,
                blocks: [
                    {
                        type: "tool_call",
                        callId: "call-a",
                        name: "exec_command",
                        arguments: { cmd: "pnpm test" },
                    },
                    {
                        type: "tool_result",
                        callId: "call-a",
                        toolName: "exec_command",
                        output: "42 passed",
                    },
                    {
                        type: "tool_call",
                        callId: "call-b",
                        name: "custom_tool",
                        arguments: { secret: "still needed to render" },
                    },
                    {
                        type: "tool_result",
                        callId: "call-b",
                        toolName: "custom_tool",
                        output: "custom output",
                    },
                ],
                recordId: "message-a",
                role: "assistant",
            },
            { omitToolData: true },
        );

        expect(message.content).toEqual([
            {
                type: "tool_call",
                id: "call-a",
                name: "exec_command",
                status: "completed",
                presentation: {
                    type: "exec_command",
                    command: "pnpm test",
                    output: "42 passed",
                },
            },
            {
                type: "tool_call",
                id: "call-b",
                name: "custom_tool",
                status: "completed",
                arguments: { secret: "still needed to render" },
                result: { output: "custom output" },
            },
        ]);
    });
});

describe("toolCallResource", () => {
    it("projects fixed vendor exploration and search tools", () => {
        expect(
            toolCallResource({
                id: "call-read",
                name: "Read",
                status: "running",
                arguments: { file_path: "/workspace/auth.ts" },
            }),
        ).toMatchObject({
            presentation: {
                type: "exploration",
                operations: [{ kind: "read", name: "/workspace/auth.ts" }],
            },
        });
        expect(
            toolCallResource({
                id: "call-search",
                name: "grok_x_search",
                status: "completed",
                arguments: { query: "Happy Agent launch" },
                output: "Answer",
            }),
        ).toMatchObject({
            presentation: { type: "search", target: "x", query: "Happy Agent launch" },
        });
    });
});
