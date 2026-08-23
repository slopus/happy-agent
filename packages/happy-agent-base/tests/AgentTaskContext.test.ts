import type { SessionCompaction, SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    agentTaskContext,
    defineAgentTool,
    taskContextBeforeToolCall,
    withAgentTaskContext,
} from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const messages: SessionMessage[] = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                callId: "basecallone",
                name: "first_tool",
                arguments: "{}",
                vendor: { replay: "PRIVATE_REPLAY_CALL_ONE" },
            },
            {
                type: "tool_result",
                callId: "baseservercall",
                content: [{ type: "text", text: "server result" }],
                vendor: { replay: "PRIVATE_REPLAY_SERVER_RESULT" },
            },
        ],
    },
    {
        role: "tool",
        callId: "basecallone",
        content: [{ type: "text", text: "first result" }],
        vendor: { replay: "PRIVATE_REPLAY_TOOL_RESULT" },
    },
    {
        role: "compaction",
        content: "summary",
        encryptedContent: "opaque",
        vendor: { response_id: "provider-response" },
    },
    {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                callId: "basecalltwo",
                name: "second_tool",
                arguments: "{}",
                vendor: { replay: "PRIVATE_REPLAY_CALL_TWO" },
            },
        ],
    },
];

function expectPortableContext(context: readonly SessionMessage[]): void {
    expect(JSON.stringify(context)).not.toContain("PRIVATE_REPLAY");
    expect(context).not.toBe(messages);
}

describe("agent task context", () => {
    it("removes opaque provider replay state from inherited tool context", () => {
        const inherited = taskContextBeforeToolCall(messages, "basecalltwo");
        expectPortableContext(inherited);
        expect(inherited).toHaveLength(4);

        const ctx = withAgentTaskContext(createRootContext(), messages);
        const carried = agentTaskContext(ctx);
        expectPortableContext(carried);
        expect(carried).toHaveLength(messages.length);
    });

    it("keeps provider IDs in context storage while tools inherit only Base IDs", async () => {
        const providerIds = ["provider-first", "provider-second"];
        const events: SessionEvent[][] = providerIds.map((callId) => [
            {
                type: "toolcall_start",
                callId,
                name: "inspect_context",
                vendor: { replay: "opaque-call" },
            },
            { type: "toolcall_end", callId, arguments: "{}" },
            { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
        ]);
        const persistence = new InMemoryPersistence();
        const publicIds: string[] = [];
        const executionIds: string[] = [];
        let inherited: readonly SessionMessage[] = [];
        const tool = defineAgentTool({
            name: "inspect_context",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: async (toolCtx, _arguments, call) => {
                executionIds.push(call.id);
                if (executionIds.length === 2) inherited = agentTaskContext(toolCtx);
                return {};
            },
            toLLM: () => [{ type: "text" as const, text: "inspected" }],
        });
        const provider = new ScriptedProvider([...events, textTurn("done")]);
        const agent = await AgentBase.create(createRootContext(), {
            id: "task-context-identity",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_ctx, event) => {
                    if (event.type === "toolcall_start") publicIds.push(event.callId);
                },
            },
            initialState: { tools: [tool] },
        });

        await agent.send(createRootContext(), user("inspect twice"));
        await agent.waitForIdle();

        expect(executionIds).toEqual(publicIds);
        expect(publicIds).toHaveLength(2);
        expect(publicIds[0]).not.toBe(publicIds[1]);
        expect(JSON.stringify(inherited)).not.toContain("provider-");
        expect(inherited.slice(-2)).toEqual([
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: publicIds[0],
                        name: tool.name,
                        arguments: "{}",
                    },
                ],
            },
            {
                role: "tool",
                callId: publicIds[0],
                content: [{ type: "text", text: "inspected" }],
            },
        ]);
        expect(
            persistence.records.flatMap((record) =>
                record.type === "block" && record.block.type === "tool_call"
                    ? [
                          {
                              id: "id" in record ? record.id : undefined,
                              callId: record.block.callId,
                          },
                      ]
                    : [],
            ),
        ).toEqual([
            { id: publicIds[0], callId: providerIds[0] },
            { id: publicIds[1], callId: providerIds[1] },
        ]);
        expect(provider.sessions[0]?.requests[1]?.context.messages.slice(-2)).toEqual([
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: providerIds[0],
                        name: tool.name,
                        arguments: "{}",
                        vendor: { replay: "opaque-call" },
                    },
                ],
            },
            {
                role: "tool",
                callId: providerIds[0],
                content: [{ type: "text", text: "inspected" }],
            },
        ]);
        await agent.close();
    });

    it("preserves private provider IDs and public Base IDs through compaction and reload", async () => {
        const providerCallId = "provider-persisted";
        const persistence = new InMemoryPersistence();
        let baseCallId = "";
        let publicReplacement: readonly SessionMessage[] = [];
        const tool = defineAgentTool({
            name: "persist_identity",
            returnType: Type.Object({}),
            shouldReviewInAutoMode: () => false,
            execute: async () => ({}),
            toLLM: () => [{ type: "text" as const, text: "persisted" }],
        });
        const provider = new ScriptedProvider([
            [
                {
                    type: "toolcall_start",
                    callId: providerCallId,
                    name: tool.name,
                    vendor: { replay: "opaque-compaction-call" },
                },
                { type: "toolcall_end", callId: providerCallId, arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
            textTurn("before compaction"),
        ]);
        const agent = await AgentBase.create(createRootContext(), {
            id: "compacted-tool-identity",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: (_ctx, event) => {
                    if (event.type === "toolcall_start") baseCallId = event.callId;
                },
                afterCompaction: (_ctx, compaction) => {
                    if (compaction.result.status === "completed") {
                        publicReplacement = compaction.result.context.messages;
                    }
                },
            },
            initialState: { tools: [tool] },
        });

        await agent.send(createRootContext(), user("persist this"));
        await agent.waitForIdle();

        const rawReplacement: SessionMessage[] = [
            user("persist this"),
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_call",
                        callId: providerCallId,
                        name: tool.name,
                        arguments: "{}",
                        vendor: { replay: "opaque-compaction-call" },
                    },
                ],
            },
            {
                role: "tool",
                callId: providerCallId,
                content: [{ type: "text", text: "persisted" }],
            },
            {
                role: "assistant",
                content: [{ type: "text", text: "before compaction" }],
            },
        ];
        const compacted: SessionCompaction = {
            status: "completed",
            summary: "kept everything",
            preservedMessages: rawReplacement,
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
            },
            context: { instructions: "", messages: rawReplacement },
        };
        const session = provider.sessions[0];
        if (session === undefined) expect.fail("The provider session was not created.");
        session.compactionResults = [compacted];

        await agent.compact(createRootContext());
        await agent.waitForIdle();

        expect(baseCallId).toMatch(/^[a-z][a-z0-9]{1,31}$/);
        expect(JSON.stringify(publicReplacement)).not.toContain(providerCallId);
        expect(publicReplacement[1]).toMatchObject({
            role: "assistant",
            content: [{ type: "tool_call", callId: baseCallId }],
        });
        expect(publicReplacement[2]).toMatchObject({ role: "tool", callId: baseCallId });
        expect(persistence.records).toEqual([
            {
                type: "compaction",
                contextToolIds: [[baseCallId, providerCallId]],
                messages: publicReplacement,
            },
        ]);
        await agent.close();

        const reloadedProvider = new ScriptedProvider([textTurn("after reload")]);
        const reloaded = await AgentBase.create(createRootContext(), {
            id: "compacted-tool-identity",
            providers: providersOf(reloadedProvider),
            provider: "scripted",
            persistence,
        });
        await reloaded.send(createRootContext(), user("continue"));
        await reloaded.waitForIdle();

        expect(reloadedProvider.sessions[0]?.requests[0]?.context.messages.slice(0, 4)).toEqual(
            rawReplacement,
        );
        await reloaded.close();
    });
});
