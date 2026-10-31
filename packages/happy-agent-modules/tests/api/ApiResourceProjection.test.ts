import { Value } from "@sinclair/typebox/value";
import { toolPresentationSchema } from "@slopus/happy-agent-client";
import type { AgentSystemRef } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { eventIdSchema, type EventsModule } from "../../sources/events/index.js";
import {
    agentResource,
    apiResourceVersion,
    questionResource,
} from "../../sources/api/ApiResourceProjection.js";
import {
    messageHiddenFromUser,
    messageResource,
    providerMessageContent,
    reviewedToolCalls,
    toolResultPresentations,
} from "../../sources/api/ApiMessageProjection.js";
import { toolCallResource } from "../../sources/api/ApiToolPresentation.js";
import { historyMessageSchema, type HistoryMessage } from "../../sources/history/index.js";

describe("apiResourceVersion", () => {
    it("renders a PowerShell command through the existing terminal presentation", () => {
        const call = {
            id: "ps-call",
            status: "completed" as const,
            arguments: { command: "Get-Location" },
            output: "C:\\Projects",
        };
        const windows = toolCallResource({ ...call, name: "PowerShell" });
        const unix = toolCallResource({ ...call, name: "Bash" });
        expect(windows.presentation).toEqual(unix.presentation);
        expect(windows.presentation).toMatchObject({
            type: "exec_command",
            command: "Get-Location",
        });
        expect(windows.name).toBe("PowerShell");
    });
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

describe("agentResource", () => {
    const agents = {
        parentOf: async () => "parent",
        childOf: async () => [],
    } as unknown as AgentSystemRef;
    const config = { provenance: { createdAt: 1 }, metadata: { subtask: true } };

    it("labels state with the version read before it instead of a later one", async () => {
        const latestAgentEvent = vi.fn(async () => ({ cursor: "later", occurredAt: 9 }));
        const events = { latestAgentEvent } as unknown as EventsModule;
        const ctx = createRootContext();
        const resource = await agentResource(ctx, agents, events, "child", "space", {
            config,
            subtask: true,
            subtaskOrderKey: "2",
            latestEvent: { cursor: "earlier", occurredAt: 5 } as never,
        });
        expect(latestAgentEvent).not.toHaveBeenCalled();
        expect(resource).toMatchObject({
            version: "earlier",
            lastCursor: "earlier",
            subtaskOrderKey: "2",
        });
        const unread = await agentResource(ctx, agents, events, "child", "space", { config });
        expect(unread).toMatchObject({ version: "later", subtaskOrderKey: null });
    });
});

describe("questionResource", () => {
    it("sends the shared context the agent wrote for its prompts", () => {
        const question = questionResource(
            {
                id: "question-1",
                askingAgentId: "agent-1",
                question: "Which database?",
                context: "The billing service needs **persistent** storage.",
                status: "pending",
                createdAt: 1,
                updatedAt: 1,
            },
            "run-1",
        );

        expect(question["context"]).toBe("The billing service needs **persistent** storage.");
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
    it.each(["running", "completed", "failed"] as const)(
        "shares durable spawn identity between live and compact history (%s)",
        (status) => {
            const presentation = {
                type: "agent_spawn" as const,
                model: { modelId: "xai/grok-4.6", providerId: "grok", name: "Grok 4.6" },
                ...(status === "completed" ? { agentId: "callspawn" } : {}),
            };
            const args = { title: "Task title has no model identity", model: "xai/grok-4.6" };
            const history: HistoryMessage = {
                recordId: "inference-spawn",
                role: "assistant",
                blocks: [
                    {
                        type: "tool_call",
                        callId: "callspawn",
                        name: "create_agent",
                        arguments: args,
                        spawnPresentation: presentation,
                    },
                    ...(status === "running"
                        ? []
                        : [
                              {
                                  type: "tool_result" as const,
                                  callId: "callspawn",
                                  toolName: "create_agent",
                                  output: "Result",
                                  isError: status === "failed",
                              },
                          ]),
                ],
            };
            const live = providerMessageContent(
                [
                    { type: "toolCall", id: "callspawn", name: "create_agent", arguments: args },
                    ...(status === "running"
                        ? []
                        : [
                              {
                                  type: "tool_result",
                                  toolCallId: "callspawn",
                                  rendered: [{ type: "text", text: "Result" }],
                                  isError: status === "failed",
                              },
                          ]),
                ],
                reviewedToolCalls(history),
                toolResultPresentations(history),
            );
            expect(live).toEqual(messageResource(history, { omitToolData: true }).content);
            expect(live?.[0]).toMatchObject({ status, presentation, arguments: args });
            expect(Value.Check(toolPresentationSchema, live?.[0]?.presentation)).toBe(true);
            if (status !== "running") expect(live?.[0]?.result).toEqual({ output: "Result" });
        },
    );

    it("renders unresolved creation generically without inferring identity from arguments or output", () => {
        expect(
            toolCallResource(
                {
                    id: "callspawn",
                    name: "create_agent",
                    status: "failed",
                    arguments: { title: "Grok 4.6", model: "unavailable" },
                    output: '{"model":"grok"}',
                },
                { omitToolData: true },
            ),
        ).toEqual({
            type: "tool_call",
            id: "callspawn",
            name: "create_agent",
            status: "failed",
            arguments: { title: "Grok 4.6", model: "unavailable" },
            result: { output: '{"model":"grok"}' },
            presentation: { type: "agent_spawn" },
        });
    });

    it("exposes user authorship separately from client data without changing content", () => {
        const message = {
            at: 100,
            blocks: [{ type: "text" as const, text: "Unchanged message." }],
            recordId: "author-message",
            role: "user" as const,
            userId: "alice123",
            clientMetadata: { userId: "bob456" },
        };
        expect(messageResource(message)).toMatchObject({
            metadata: { userId: "alice123" },
            clientMetadata: { userId: "bob456" },
            content: [{ type: "text", text: "Unchanged message." }],
        });
        expect(messageResource({ ...message, role: "assistant" }).metadata).toEqual({});
    });

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
            profile: null,
            runId: null,
        });
    });

    it("projects an unsupported or removed request profile as null", () => {
        expect(
            messageResource({
                at: 100,
                blocks: [{ type: "text", text: "Use the coding profile." }],
                profile: "coding-agent-v3",
                recordId: "message-profile",
                role: "user",
            }),
        ).toMatchObject({ profile: null });
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

    it("serves media and artifact presentations without snapshot digests and keeps raw data", () => {
        const sha256 = "a".repeat(64);
        const historyMessage = {
            at: 100,
            blocks: [
                {
                    type: "tool_call" as const,
                    callId: "callmedia",
                    name: "present_files",
                    arguments: { filepaths: ["chart.png", "report.pdf"] },
                },
                {
                    type: "tool_result" as const,
                    callId: "callmedia",
                    toolName: "present_files",
                    output: "Presented 2 files to the user in this chat.",
                    presentation: {
                        type: "media" as const,
                        items: [
                            {
                                kind: "image" as const,
                                name: "chart.png",
                                mimeType: "image/png",
                                size: 120,
                                sha256,
                                width: 4,
                                height: 3,
                                thumbhash: "AAAA",
                            },
                            {
                                kind: "document" as const,
                                name: "report.pdf",
                                mimeType: "application/pdf",
                                size: 99,
                                sha256,
                            },
                        ],
                    },
                },
                {
                    type: "tool_call" as const,
                    callId: "callcard",
                    name: "create_artifact",
                    arguments: { type: "markdown", title: "Notes", files: [{ content: "# N" }] },
                },
                {
                    type: "tool_result" as const,
                    callId: "callcard",
                    toolName: "create_artifact",
                    output: "Artifact created.",
                    presentation: {
                        type: "artifact" as const,
                        artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5",
                        version: 1,
                        artifactType: "markdown" as const,
                        title: "Notes",
                    },
                },
            ],
            recordId: "message-media",
            role: "assistant" as const,
        };
        const media = {
            type: "media",
            items: [
                {
                    kind: "image",
                    name: "chart.png",
                    mimeType: "image/png",
                    size: 120,
                    width: 4,
                    height: 3,
                    thumbhash: "AAAA",
                },
                { kind: "document", name: "report.pdf", mimeType: "application/pdf", size: 99 },
            ],
        };
        const card = historyMessage.blocks[3]!.presentation;
        const historical = messageResource(historyMessage);
        const live = providerMessageContent(
            [
                {
                    type: "toolCall",
                    id: "callmedia",
                    name: "present_files",
                    arguments: { filepaths: ["chart.png", "report.pdf"] },
                },
                {
                    type: "tool_result",
                    toolCallId: "callmedia",
                    rendered: [
                        { type: "text", text: "Presented 2 files to the user in this chat." },
                    ],
                },
                {
                    type: "toolCall",
                    id: "callcard",
                    name: "create_artifact",
                    arguments: { type: "markdown", title: "Notes", files: [{ content: "# N" }] },
                },
                {
                    type: "tool_result",
                    toolCallId: "callcard",
                    rendered: [{ type: "text", text: "Artifact created." }],
                },
            ],
            reviewedToolCalls(historyMessage),
            toolResultPresentations(historyMessage),
        );

        expect(live).toEqual(historical.content);
        expect(JSON.stringify(historical.content)).not.toContain(sha256);
        // The published client's schemas accept exactly what the daemon serves.
        expect(Value.Check(toolPresentationSchema, media)).toBe(true);
        expect(Value.Check(toolPresentationSchema, card)).toBe(true);
        expect(messageResource(historyMessage, { omitToolData: true }).content).toEqual([
            {
                type: "tool_call",
                id: "callmedia",
                name: "present_files",
                status: "completed",
                arguments: { filepaths: ["chart.png", "report.pdf"] },
                result: { output: "Presented 2 files to the user in this chat." },
                presentation: media,
            },
            {
                type: "tool_call",
                id: "callcard",
                name: "create_artifact",
                status: "completed",
                arguments: { type: "markdown", title: "Notes", files: [{ content: "# N" }] },
                result: { output: "Artifact created." },
                presentation: card,
            },
        ]);
    });

    it("shows a call that presented a withdrawn artifact type as a plain tool", () => {
        const historyMessage: HistoryMessage = {
            at: 100,
            blocks: [
                {
                    type: "tool_call",
                    callId: "callstory",
                    name: "draft_story",
                    arguments: { text: "Shipped" },
                },
                {
                    type: "tool_result",
                    callId: "callstory",
                    toolName: "draft_story",
                    output: "Story drafted.",
                    presentation: {
                        type: "artifact",
                        artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5",
                        version: 1,
                        artifactType: "story",
                        title: "Shipped",
                    },
                },
            ],
            recordId: "message-story",
            role: "assistant",
        };
        // Older records keep parsing after the type is withdrawn.
        expect(Value.Check(historyMessageSchema, historyMessage)).toBe(true);

        expect(toolResultPresentations(historyMessage).size).toBe(0);
        expect(messageResource(historyMessage, { omitToolData: true }).content).toEqual([
            {
                type: "tool_call",
                id: "callstory",
                name: "draft_story",
                status: "completed",
                arguments: { text: "Shipped" },
                result: { output: "Story drafted." },
            },
        ]);
    });

    it("passes a media layout through and shows a completed image read as media", () => {
        const sha256 = "b".repeat(64);
        const image = {
            kind: "image" as const,
            name: "shot.png",
            mimeType: "image/png",
            size: 120,
            width: 4,
            height: 3,
            thumbhash: "AAAA",
            scale: 2,
        };
        const tree = {
            type: "tree" as const,
            root: [
                {
                    type: "element" as const,
                    tag: "figure" as const,
                    style: { tone: "muted", gridTemplateColumns: "1fr 2fr" },
                    children: [
                        { type: "item" as const, index: 0, alt: "Shot" },
                        { type: "text" as const, text: "Caption" },
                        { type: "break" as const },
                    ],
                },
            ],
        };
        const historyMessage = {
            at: 100,
            blocks: [
                {
                    type: "tool_call" as const,
                    callId: "callread",
                    name: "Read",
                    arguments: { file_path: "/workspace/shot.png" },
                },
                {
                    type: "tool_result" as const,
                    callId: "callread",
                    toolName: "Read",
                    output: "Image: /workspace/shot.png",
                    presentation: {
                        type: "media" as const,
                        items: [{ ...image, sha256 }],
                        layout: { type: "columns" as const, columns: 2 as const },
                    },
                },
                {
                    type: "tool_call" as const,
                    callId: "calllayout",
                    name: "present_files",
                    arguments: { filepaths: ["shot.png"], layout: "<figure>…</figure>" },
                },
                {
                    type: "tool_result" as const,
                    callId: "calllayout",
                    toolName: "present_files",
                    output: "Presented 1 file to the user in this chat.",
                    presentation: {
                        type: "media" as const,
                        items: [{ ...image, sha256 }],
                        layout: tree,
                    },
                },
                {
                    type: "tool_call" as const,
                    callId: "callplain",
                    name: "Read",
                    arguments: { file_path: "/workspace/notes.md" },
                },
                {
                    type: "tool_result" as const,
                    callId: "callplain",
                    toolName: "Read",
                    output: "1\t# Notes",
                },
            ],
            recordId: "message-layout",
            role: "assistant" as const,
        };
        expect(Value.Check(historyMessageSchema, historyMessage)).toBe(true);

        const content = messageResource(historyMessage, { omitToolData: true }).content as {
            presentation?: unknown;
        }[];
        const presentations = content.map((block) => block.presentation);

        expect(presentations).toEqual([
            { type: "media", items: [image], layout: { type: "columns", columns: 2 } },
            { type: "media", items: [image], layout: tree },
            { type: "exploration", operations: [{ kind: "read", name: "/workspace/notes.md" }] },
        ]);
        expect(JSON.stringify(presentations)).not.toContain(sha256);
        for (const presentation of presentations) {
            expect(Value.Check(toolPresentationSchema, presentation)).toBe(true);
        }
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
