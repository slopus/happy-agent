import type {
    AgentBaseAcceptedMessage,
    AgentBasePersistedEvent,
    AgentModuleAgent,
    AgentModuleScope,
    AgentModuleSystemScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { AutoModule } from "../../sources/auto/AutoModule.js";
import { AutoReviewEvidenceStore } from "../../sources/auto/impl/AutoReviewEvidenceStore.js";
import type { AutoTranscriptMessage } from "../../sources/auto/impl/createAutoPermissionTranscript.js";
import { autoWorld, type AutoWorld } from "../support/autoWorld.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const AGENT_ID = "auto-hooks-agent";

interface HookWorld {
    readonly auto: AutoModule;
    readonly installation: AutoWorld;
    readonly context: Context;
    readonly database: ModuleDatabase & {
        readonly database: Parameters<AutoReviewEvidenceStore["readState"]>[0];
    };
    readonly hooks: NonNullable<Awaited<ReturnType<AutoModule["beforeStart"]>>>;
    readonly scope: AgentModuleScope;
    close(): Promise<void>;
}

async function hookWorld(): Promise<HookWorld> {
    const context = createRootContext().named("auto-hooks-test");
    const installation = await autoWorld();
    const auto = new AutoModule(
        installation.config,
        installation.compute,
        installation.systemPrompt,
        installation.storage,
    );
    const database = moduleDatabase(auto.migrations, "auto-hooks-main");
    await database.ready;
    const hooks = await auto.beforeStart(context, {} as unknown as AgentSystemRef);
    if (hooks === undefined) throw new Error("AutoModule did not return hooks.");

    const scope: AgentModuleScope = {
        agent: {
            id: AGENT_ID,
            metadata: undefined,
            model: "scripted/model",
            provider: "scripted",
            providerKind: "gym",
            effort: "low",
            permissionMode: "auto",
            tier: undefined,
        } as AgentModuleAgent,
    } as AgentModuleScope;

    return {
        auto,
        installation,
        context,
        database: database as HookWorld["database"],
        hooks,
        scope,
        close: async () => {
            await auto.close(context);
            await installation.compute.dispose(context);
            database.close();
        },
    };
}

const worlds: HookWorld[] = [];

afterEach(async () => {
    while (worlds.length > 0) await worlds.pop()?.close();
});

function userAccepted(text: string, metadata?: Record<string, unknown>): AgentBaseAcceptedMessage {
    return {
        id: `message-${text}`,
        kind: "send",
        message: { role: "user", content: [{ type: "text", text }] },
        profile: null,
        ...(metadata === undefined ? {} : { metadata }),
    } as AgentBaseAcceptedMessage;
}

function persisted(event: unknown): AgentBasePersistedEvent {
    return event as AgentBasePersistedEvent;
}

async function entries(world: HookWorld, generation = 0): Promise<AutoTranscriptMessage[]> {
    return new AutoReviewEvidenceStore().readEntries(world.database.database, AGENT_ID, generation);
}

describe("AutoModule evidence hooks", () => {
    it("records only positively stamped accepted user messages", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.messageAcceptedTransact?.(
            world.database.context,
            world.scope,
            userAccepted("human authorization", { messageOrigin: "user" }),
        );
        await world.hooks.messageAcceptedTransact?.(
            world.database.context,
            world.scope,
            userAccepted("agent handoff"),
        );

        expect(await entries(world)).toEqual([
            {
                role: "user",
                blocks: [{ type: "text", text: "human authorization" }],
            },
            {
                role: "user",
                provenance: "agent",
                blocks: [{ type: "text", text: "agent handoff" }],
            },
        ]);
        expect(
            (await new AutoReviewEvidenceStore().readState(world.database.database, AGENT_ID))
                .nextPosition,
        ).toBe(2);
    });

    it("does not archive messages hidden from the user", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.messageAcceptedTransact?.(
            world.database.context,
            world.scope,
            userAccepted("internal", { hideFromUser: true, messageOrigin: "user" }),
        );

        expect(await entries(world)).toEqual([]);
    });

    it("records assistant blocks and labels a tool result with the matching call", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.onEventTransact?.(
            world.database.context,
            world.scope,
            persisted({ type: "text_end", block: { type: "text", text: "thinking aloud" } }),
        );
        await world.hooks.onEventTransact?.(
            world.database.context,
            world.scope,
            persisted({
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: "call-1",
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                },
            }),
        );
        await world.hooks.afterToolCallTransact?.(world.database.context, world.scope, {
            role: "tool",
            callId: "call-1",
            content: [{ type: "text", text: "file body" }],
            isError: true,
        });

        expect(await entries(world)).toEqual([
            { role: "agent", blocks: [{ type: "text", text: "thinking aloud" }] },
            {
                role: "agent",
                blocks: [
                    {
                        type: "tool_call",
                        name: "read_file",
                        arguments: { path: "README.md" },
                    },
                ],
            },
            {
                role: "agent",
                blocks: [
                    {
                        type: "tool_result",
                        toolName: "read_file",
                        rendered: [{ type: "text", text: "file body" }],
                        isError: true,
                    },
                ],
            },
        ]);
    });

    it("preserves a namespaced tool identity on the archived result", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.onEventTransact?.(
            world.database.context,
            world.scope,
            persisted({
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: "mcp-call",
                    namespace: "mcp",
                    name: "search",
                    arguments: "{}",
                },
            }),
        );
        await world.hooks.afterToolCallTransact?.(world.database.context, world.scope, {
            role: "tool",
            callId: "mcp-call",
            content: [{ type: "text", text: "result" }],
            isError: false,
        });

        expect((await entries(world))[1]?.blocks[0]).toMatchObject({
            type: "tool_result",
            toolName: "mcp/search",
        });
    });

    it("consumes a recorded interactive answer exactly once as trusted evidence", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.auto.recordUserInputEventTransactional(world.database.context, {
            type: "user_input_answered",
            agentId: AGENT_ID,
            requestId: "question-call",
            answer: "yes, proceed",
        });
        await world.hooks.afterToolCallTransact?.(world.database.context, world.scope, {
            role: "tool",
            callId: "question-call",
            content: [{ type: "text", text: "Answered." }],
            isError: false,
        });
        await world.hooks.afterToolCallTransact?.(world.database.context, world.scope, {
            role: "tool",
            callId: "question-call",
            content: [{ type: "text", text: "replayed result" }],
            isError: false,
        });

        const recorded = await entries(world);
        expect(recorded[0]?.blocks[0]).toMatchObject({
            type: "tool_result",
            trustedUserEvidence: [{ type: "text", text: "yes, proceed" }],
        });
        expect(recorded[1]?.blocks[0]).toMatchObject({
            type: "tool_result",
            rendered: [{ type: "text", text: "replayed result" }],
        });
        expect(recorded[1]?.blocks[0]).not.toHaveProperty("trustedUserEvidence");
    });

    it("records retry and terminal errors as untrusted context", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.onEvent?.(world.database.context, world.scope, {
            type: "retrying",
            attempt: 1,
            reason: "temporary provider outage",
        });
        await world.hooks.onEvent?.(world.database.context, world.scope, {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "terminal provider outage",
        } as never);

        expect(await entries(world)).toEqual([
            {
                role: "error",
                outcome: "retried",
                blocks: [{ type: "text", text: "temporary provider outage" }],
            },
            {
                role: "error",
                blocks: [{ type: "text", text: "terminal provider outage" }],
            },
        ]);
    });

    it("bumps and clears evidence on compaction and recreated identities", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.messageAcceptedTransact?.(
            world.database.context,
            world.scope,
            userAccepted("before reset", { messageOrigin: "user" }),
        );
        await world.hooks.historyErasedTransact?.(world.database.context, world.scope, {} as never);
        expect(await entries(world, 1)).toEqual([]);

        await world.hooks.messageAcceptedTransact?.(
            world.database.context,
            world.scope,
            userAccepted("after compaction", { messageOrigin: "user" }),
        );
        await world.hooks.agentCreatedTransact?.(
            world.database.context,
            {} as AgentModuleSystemScope,
            { id: AGENT_ID, metadata: undefined },
        );

        expect(await entries(world, 2)).toEqual([]);
        expect(
            await new AutoReviewEvidenceStore().readState(world.database.database, AGENT_ID),
        ).toEqual({
            generation: 2,
            nextPosition: 0,
            archiveHealthy: true,
        });
    });

    it("does not reuse a tool-call label from an older recreated identity", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await world.hooks.onEventTransact?.(
            world.database.context,
            world.scope,
            persisted({
                type: "toolcall_end",
                block: {
                    type: "tool_call",
                    callId: "reused-call",
                    name: "old_tool",
                    arguments: "{}",
                },
            }),
        );
        await world.hooks.agentCreatedTransact?.(
            world.database.context,
            {} as AgentModuleSystemScope,
            { id: AGENT_ID, metadata: undefined },
        );
        await world.hooks.afterToolCallTransact?.(world.database.context, world.scope, {
            role: "tool",
            callId: "reused-call",
            content: [{ type: "text", text: "new result" }],
            isError: false,
        });

        expect((await entries(world, 1))[0]?.blocks[0]).toMatchObject({
            type: "tool_result",
            toolName: "tool",
        });
    });

    it("rejects malformed interactive-answer events before writing evidence", async () => {
        const world = await hookWorld();
        worlds.push(world);

        await expect(
            world.auto.recordUserInputEventTransactional(world.database.context, {
                type: "user_input_answered",
                agentId: AGENT_ID,
                requestId: "missing-answer",
            }),
        ).rejects.toThrow("Only a validated user_input_answered event may be recorded.");
        expect(await entries(world)).toEqual([]);
    });

    it("allows close to be called repeatedly", async () => {
        const world = await hookWorld();

        await expect(
            Promise.all([world.auto.close(world.context), world.auto.close(world.context)]),
        ).resolves.toEqual([undefined, undefined]);
        world.database.close();
    });
});
