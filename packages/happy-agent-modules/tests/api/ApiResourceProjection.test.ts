import { Value } from "@sinclair/typebox/value";
import { sharingSchema, toolPresentationSchema } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import { eventIdSchema } from "../../sources/events/index.js";
import { apiResourceVersion, sharingResource } from "../../sources/api/ApiResourceProjection.js";
import {
    messageHiddenFromUser,
    messageResource,
    providerMessageContent,
    reviewedToolCalls,
    toolResultPresentations,
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

describe("sharingResource", () => {
    it("removes every Murmur and profile-storage field at the public boundary", () => {
        const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
        const localIdentity = "A".repeat(43);
        const contactIdentity = "B".repeat(43);
        const outgoingIdentity = "C".repeat(43);
        const outgoingId = "D".repeat(43);
        const internalSessionId = "E".repeat(43);
        const internalProfileId = "aremoteprofile0000000001";
        const internalInstanceId = "aremoteinstance000000001";
        const profile = {
            createdAt: 1,
            email: "remote@example.test",
            id: internalProfileId,
            name: "Remote",
            parentInstanceId: internalInstanceId,
            photo: {
                contentHash: "f".repeat(64),
                height: 32,
                thumbhash: "AQIDBA==",
                width: 32,
            },
            updatedAt: 2,
            version,
        };

        const sharing = sharingResource({
            connection: "connected",
            contacts: [{ identity: contactIdentity, profile, status: "active" }],
            identity: localIdentity,
            incomingRequests: [
                {
                    id: "incoming-request",
                    identity: contactIdentity,
                    profile,
                    sessionId: internalSessionId,
                },
            ],
            outgoingRequests: [
                {
                    id: outgoingId,
                    identity: outgoingIdentity,
                    sessionId: internalSessionId,
                },
            ],
            profileId: internalProfileId,
            status: "enrolled",
            updatedAt: 3,
            version,
        });

        expect(Value.Check(sharingSchema, sharing)).toBe(true);
        expect(sharing).toEqual({
            connection: "connected",
            contacts: [
                {
                    identity: contactIdentity,
                    profile: {
                        email: "remote@example.test",
                        name: "Remote",
                        photo: { thumbhash: "AQIDBA==" },
                        updatedAt: 2,
                        version,
                    },
                    status: "active",
                },
            ],
            identity: localIdentity,
            incomingRequests: [
                {
                    id: "incoming-request",
                    identity: contactIdentity,
                    profile: {
                        email: "remote@example.test",
                        name: "Remote",
                        photo: { thumbhash: "AQIDBA==" },
                        updatedAt: 2,
                        version,
                    },
                },
            ],
            outgoingRequests: [{ id: outgoingId, identity: outgoingIdentity }],
            status: "enrolled",
            updatedAt: 3,
            version,
        });
        const serialized = JSON.stringify(sharing);
        expect(serialized).not.toContain(internalSessionId);
        expect(serialized).not.toContain(internalProfileId);
        expect(serialized).not.toContain(internalInstanceId);
        expect(serialized).not.toContain("contentHash");
        expect(serialized).not.toContain("height");
        expect(serialized).not.toContain("width");
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
    it("projects client-owned metadata separately on a user message", () => {
        const clientMetadata = {
            composer: "mobile",
            localDraft: { revision: 4, tags: ["auth", null] },
        };

        expect(
            messageResource({
                at: 100,
                blocks: [{ type: "text", text: "Keep my metadata." }],
                clientMetadata,
                recordId: "message-client-metadata",
                role: "user",
            }),
        ).toEqual({
            id: "message-client-metadata",
            role: "user",
            createdAt: 100,
            content: [{ type: "text", text: "Keep my metadata." }],
            metadata: {},
            clientMetadata,
            status: "accepted",
            delivery: "queue",
            mode: null,
            runId: null,
        });
    });

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

    it("projects a compaction without model-context provenance", () => {
        expect(
            messageResource({
                at: 100,
                blocks: [
                    {
                        type: "compaction",
                        trigger: "automatic",
                        status: "completed",
                        tokensBefore: null,
                        tokensAfter: null,
                        failureReason: null,
                        startedAt: 90,
                        completedAt: 100,
                    },
                ],
                recordId: "compaction-a",
                role: "service",
            }),
        ).toMatchObject({
            content: [{ type: "compaction" }],
        });
    });

    it("projects a completed command with the same display-ready tool presentation", () => {
        expect(
            messageResource({
                at: 100,
                blocks: [
                    {
                        type: "tool_call",
                        callId: "calla",
                        name: "exec_command",
                        arguments: { cmd: "pnpm test" },
                    },
                    {
                        type: "tool_result",
                        callId: "calla",
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
                    id: "calla",
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
                    callId: "callreviewed",
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
                        id: "callreviewed",
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
                    callId: "calla",
                    name: "exec_command",
                    arguments: { cmd: "pnpm test" },
                },
                {
                    type: "tool_result",
                    callId: "calla",
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
                id: "calla",
                name: "exec_command",
                arguments: { cmd: "pnpm test" },
            },
            {
                type: "tool_result",
                toolCallId: "calla",
                toolName: "exec_command",
                display: "Tool exec_command returned 9 characters.",
                rendered: [{ type: "text", text: "42 passed" }],
            },
        ]);

        expect(live).toEqual(historical.content);
    });

    it("uses the durable file diff for identical live and historical completed calls", () => {
        const presentation = {
            type: "file_diff" as const,
            files: [
                {
                    path: "sources/auth.ts",
                    kind: "update" as const,
                    added: 1,
                    deleted: 1,
                    hunks: [
                        {
                            oldStart: 4,
                            newStart: 4,
                            lines: [
                                { kind: "delete" as const, text: "return oldAuth();" },
                                { kind: "add" as const, text: "return auth();" },
                            ],
                        },
                    ],
                },
            ],
        };
        const historyMessage = {
            at: 100,
            blocks: [
                {
                    type: "tool_call" as const,
                    callId: "calledit",
                    name: "apply_patch",
                    arguments: { patch: "*** Begin Patch\n..." },
                },
                {
                    type: "tool_result" as const,
                    callId: "calledit",
                    toolName: "apply_patch",
                    output: "Success. Updated the following files:\nM sources/auth.ts",
                    presentation,
                },
            ],
            recordId: "message-edit",
            role: "assistant" as const,
        };
        expect(Value.Check(toolPresentationSchema, presentation)).toBe(true);
        const historical = messageResource(historyMessage);
        const live = providerMessageContent(
            [
                {
                    type: "toolCall",
                    id: "calledit",
                    name: "apply_patch",
                    arguments: { patch: "*** Begin Patch\n..." },
                },
                {
                    type: "tool_result",
                    toolCallId: "calledit",
                    rendered: [
                        {
                            type: "text",
                            text: "Success. Updated the following files:\nM sources/auth.ts",
                        },
                    ],
                },
            ],
            reviewedToolCalls(historyMessage),
            toolResultPresentations(historyMessage),
        );

        expect(live).toEqual(historical.content);
        expect(historical.content).toMatchObject([{ status: "completed", presentation }]);
        expect(messageResource(historyMessage, { omitToolData: true }).content).toEqual([
            {
                type: "tool_call",
                id: "calledit",
                name: "apply_patch",
                status: "completed",
                presentation,
            },
        ]);
    });

    it("omits raw data only after projecting a presentation", () => {
        const message = messageResource(
            {
                at: 100,
                blocks: [
                    {
                        type: "tool_call",
                        callId: "calla",
                        name: "exec_command",
                        arguments: { cmd: "pnpm test" },
                    },
                    {
                        type: "tool_result",
                        callId: "calla",
                        toolName: "exec_command",
                        output: "42 passed",
                    },
                    {
                        type: "tool_call",
                        callId: "callb",
                        name: "custom_tool",
                        arguments: { secret: "still needed to render" },
                    },
                    {
                        type: "tool_result",
                        callId: "callb",
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
                id: "calla",
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
                id: "callb",
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
                id: "callread",
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
                id: "callsearch",
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
