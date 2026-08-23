import type { SessionEvent } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    AgentBase,
    agentKV,
    agentPermissionMode,
    defineAgentTool,
    withAgentPermissionMode,
    type AgentBaseAcceptedMessage,
    type AgentBaseOptions,
    type AgentBasePermissionModeChange,
    type AgentPermissionMode,
} from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("happy-agent-base-permissions-test");

/** A turn that calls `probe` once and stops for its result. */
function probeTurn(callId: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId, name: "probe" },
        { type: "toolcall_end", callId, arguments: "{}" },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

/** A tool that reports nothing except the permission mode its execution was given. */
function probeTool(seen: AgentPermissionMode[]) {
    return defineAgentTool({
        name: "probe",
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        execute: (toolCtx) => {
            seen.push(agentPermissionMode(toolCtx));
            return Promise.resolve({});
        },
        toLLM: () => [{ type: "text", text: "probed" }],
    });
}

function options(
    provider: ScriptedProvider,
    persistence: InMemoryPersistence,
    rest: Partial<AgentBaseOptions> = {},
): AgentBaseOptions {
    return {
        id: "permissions-agent",
        providers: providersOf(provider),
        provider: "scripted",
        persistence,
        ...rest,
    };
}

describe("AgentBase permission modes", () => {
    it("runs in Auto until a steering message changes the mode, and reports the change", async () => {
        const provider = new ScriptedProvider([
            probeTurn("call-1"),
            textTurn("first"),
            probeTurn("call-2"),
            textTurn("second"),
        ]);
        const seen: AgentPermissionMode[] = [];
        const reported: string[] = [];
        const changes: AgentBasePermissionModeChange[] = [];
        const agent = await AgentBase.create(
            ctx,
            options(provider, new InMemoryPersistence(), {
                initialState: { tools: [probeTool(seen)] },
                hooks: {
                    permissionModeChangedTransact: (hookCtx, change) => {
                        reported.push("transact");
                        changes.push(change);
                        // The store on the hook's context writes into the same transaction.
                        return agentKV(hookCtx)?.write(hookCtx, "mode", change.mode);
                    },
                    permissionModeChanged: (_hookCtx, change) => {
                        reported.push("committed");
                        changes.push(change);
                    },
                },
            }),
        );

        await agent.send(ctx, user("look around"));
        await agent.waitForIdle();
        await agent.steer(ctx, user("be careful now"), {
            permissionMode: "read_only",
        });
        await agent.waitForIdle();
        await agent.close();

        expect(seen).toEqual(["auto", "read_only"]);
        expect(reported).toEqual(["transact", "committed"]);
        expect(changes).toEqual([
            { previousMode: "auto", mode: "read_only" },
            { previousMode: "auto", mode: "read_only" },
        ]);
    });

    it("keeps the mode a message set when the agent is loaded again", async () => {
        const persistence = new InMemoryPersistence();
        const first = new ScriptedProvider([textTurn("acknowledged")]);
        const agent = await AgentBase.create(ctx, options(first, persistence));
        await agent.send(ctx, user("switch"), { permissionMode: "full_access" });
        await agent.waitForIdle();
        await agent.close();

        const seen: AgentPermissionMode[] = [];
        const second = new ScriptedProvider([probeTurn("call-1"), textTurn("done")]);
        const resumed = await AgentBase.load(
            ctx,
            options(second, persistence, { initialState: { tools: [probeTool(seen)] } }),
        );
        await resumed.send(ctx, user("carry on"));
        await resumed.waitForIdle();
        await resumed.close();

        expect(seen).toEqual(["full_access"]);
    });

    it("ignores a persisted mode that is not one of the four", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set("settings", { provider: "scripted", permissionMode: "yolo" });
        const seen: AgentPermissionMode[] = [];
        const provider = new ScriptedProvider([probeTurn("call-1"), textTurn("done")]);
        const agent = await AgentBase.load(
            ctx,
            options(provider, persistence, {
                permissionMode: "workspace_write",
                initialState: { tools: [probeTool(seen)] },
            }),
        );

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();
        await agent.close();

        expect(seen).toEqual(["workspace_write"]);
    });

    it("reports every consumed message to the accepted hooks, with the queue it waited in", async () => {
        const provider = new ScriptedProvider([textTurn("one"), textTurn("two")]);
        const persistence = new InMemoryPersistence();
        const order: string[] = [];
        const note = (stage: string, accepted: AgentBaseAcceptedMessage): void => {
            const text =
                accepted.message.role === "agent"
                    ? ""
                    : accepted.message.content
                          .map((block) => (block.type === "text" ? block.text : ""))
                          .join("");
            order.push(`${stage}:${accepted.kind}:${text}`);
        };
        const agent = await AgentBase.create(
            ctx,
            options(provider, persistence, {
                hooks: {
                    messageAcceptedTransact: (hookCtx, accepted) => {
                        note("transact", accepted);
                        return agentKV(hookCtx)?.write(hookCtx, "last", accepted.kind);
                    },
                    messageAccepted: (_hookCtx, accepted) => {
                        note("committed", accepted);
                    },
                },
            }),
        );

        await agent.send(ctx, user("sent"));
        await agent.waitForIdle();
        await agent.steer(ctx, user("steered"));
        await agent.waitForIdle();
        await agent.close();

        expect(order).toEqual([
            "transact:send:sent",
            "committed:send:sent",
            "transact:steering:steered",
            "committed:steering:steered",
        ]);
        expect(persistence.values.get("kv.permissions-agent.last")).toBe("steering");
    });

    it("leaves a message queued when a transactional accepted hook fails", async () => {
        const provider = new ScriptedProvider([textTurn("never asked")]);
        const persistence = new InMemoryPersistence();
        const events: SessionEvent[] = [];
        const agent = await AgentBase.create(
            ctx,
            options(provider, persistence, {
                hooks: {
                    onEvent: (_hookCtx, event) => events.push(event),
                    messageAcceptedTransact: () => {
                        throw new Error("the record could not be written");
                    },
                },
            }),
        );

        await agent.send(ctx, user("unrecordable"), { permissionMode: "read_only" });
        await agent.waitForIdle();
        await agent.close();

        expect(
            [...persistence.values.keys()].filter((key) => key.startsWith("send.")),
        ).toHaveLength(1);
        expect(persistence.records.filter((record) => record.type === "user")).toHaveLength(0);
        expect(persistence.values.get("settings")).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "done", state: "error" });
        expect(provider.sessions[0]?.requests ?? []).toHaveLength(0);
    });

    it("runs one call under the mode its before-call decision named", async () => {
        const provider = new ScriptedProvider([
            probeTurn("call-1"),
            probeTurn("call-2"),
            textTurn("done"),
        ]);
        const seen: AgentPermissionMode[] = [];
        const decided: AgentPermissionMode[] = [];
        let calls = 0;
        const agent = await AgentBase.create(
            ctx,
            options(provider, new InMemoryPersistence(), {
                initialState: { tools: [probeTool(seen)] },
                hooks: {
                    beforeToolCall: (hookCtx) => {
                        // The hook itself runs on the agent's mode; what it decides applies to
                        // the execution alone.
                        decided.push(agentPermissionMode(hookCtx));
                        calls += 1;
                        if (calls !== 1) return undefined;
                        return { type: "run", permissionMode: "full_access" };
                    },
                },
            }),
        );

        await agent.send(ctx, user("go"));
        await agent.waitForIdle();
        await agent.close();

        expect(decided).toEqual(["auto", "auto"]);
        // The elevation belonged to one call; the next is decided again from the agent's mode.
        expect(seen).toEqual(["full_access", "auto"]);
    });
});
