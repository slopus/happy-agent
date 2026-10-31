import { AsyncResource } from "node:async_hooks";

import {
    cuid2Schema,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { agentStatusLineSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { TasksModule } from "../tasks/index.js";
import { setStatusTool } from "./tools/set_status.js";

/** Kept from when Stories owned status lines, so a write a restart interrupted still lands. */
const SET_STATUS_FUNCTION = "stories.set-status";
const setStatusArgumentsSchema = Type.Object({
    agentId: cuid2Schema,
    statusLine: Type.Union([agentStatusLineSchema, Type.Null()]),
});
const SET_STATUS_INSTRUCTIONS =
    "Keep this conversation's sidebar status current with set_status: one short phrase saying where the work stands for the person. Set it early, then change it only when that changes: a plan agreed, something ready to try or waiting on their decision, shipped, stuck, paused, or waiting for them to choose between options you laid out. Answering the person's follow-up question, a small extra request, or your next step keeps it.";

/**
 * Agent status: the short line under a task's or bot's title in the sidebar, which that task's or
 * bot's own agent keeps with `set_status`. Subtasks, helpers, and project or workspace sessions
 * have no row of their own, so they get neither the tool nor the instructions.
 *
 * The line is agent metadata (`statusLine`), which reaches clients on the agent resource.
 */
export class AgentStatusModule implements AgentModule {
    readonly name = "agentStatus";

    readonly #durableFunctions: DurableFunctionsModule;
    readonly #bots: BotsModule;
    readonly #tasks: TasksModule;
    /** Status lines are written from outside the agent loop that asked for them. */
    readonly #backgroundScope = new AsyncResource("happy-agent-status-line");
    #agents: AgentSystemRef | undefined;

    constructor(durableFunctions: DurableFunctionsModule, bots: BotsModule, tasks: TasksModule) {
        this.#durableFunctions = durableFunctions;
        this.#bots = bots;
        this.#tasks = tasks;
        // A status line is agent metadata, which an agent cannot change from inside its own turn;
        // the write follows the tool call's commit and survives a restart in between.
        durableFunctions.register({
            name: SET_STATUS_FUNCTION,
            argumentsSchema: setStatusArgumentsSchema,
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#backgroundScope.runInAsyncScope(async () => {
                    const agents = this.#agents;
                    if (agents === undefined) throw new Error("Agent status has not started.");
                    const config = await agents.config(ctx, call.arguments.agentId);
                    if (config === undefined) return null;
                    const version = config.metadata?.["version"];
                    await agents.updateMetadata(ctx, call.arguments.agentId, {
                        statusLine: call.arguments.statusLine,
                        updatedAt: Date.now(),
                        version: typeof version === "number" ? version + 1 : 1,
                    });
                    return null;
                }),
        });
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> =>
            (await this.#keepsStatus(ctx, scope)) ? [setStatusTool(this, scope)] : [],
        // Agents left their rows empty until told to keep them.
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> =>
            (await this.#keepsStatus(ctx, scope)) ? SET_STATUS_INSTRUCTIONS : "",
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /** Write a conversation's status line after the tool call that set it commits. */
    async setStatus(
        ctx: Context,
        call: {
            readonly agentId: string;
            readonly toolCallId: string;
            readonly text: string | null;
        },
    ): Promise<void> {
        await this.#durableFunctions.invoke(ctx, {
            function: SET_STATUS_FUNCTION,
            operationId: `stories.status:${call.toolCallId}`,
            arguments: {
                agentId: call.agentId,
                statusLine: call.text === null ? null : { text: call.text, updatedAt: Date.now() },
            },
        });
    }

    /** Only a task's or a bot's own agent keeps a sidebar status. */
    async #keepsStatus(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        return (
            (await this.#tasks.forAgent(ctx, scope.agent.id)) !== undefined ||
            (await this.#bots.forAgent(ctx, scope.agent.id)) !== undefined
        );
    }
}
