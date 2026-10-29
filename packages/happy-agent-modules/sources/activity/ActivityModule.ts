import { AsyncResource } from "node:async_hooks";

import {
    cuid2Schema,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { isGuestOriginMetadata, isUserOriginMetadata } from "../impl/messageOrigin.js";

/** The agent metadata key holding when a person's message last entered the conversation. */
export const LAST_PERSON_MESSAGE_AT_METADATA_KEY = "lastPersonMessageAt";

const RECORD_FUNCTION = "activity.person-message";
const recordArgumentsSchema = Type.Object({
    agentId: cuid2Schema,
    at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

/**
 * Activity: remembers when a person last wrote in each conversation, so a sidebar row can be
 * ordered and dated by what people did rather than by every run, tool call, or bookkeeping write.
 *
 * A user's or an exported bot's guest's message counts; a message from an agent never does. The
 * time is agent metadata, which survives restarts and reaches clients as `lastActivityAt`.
 */
export class ActivityModule implements AgentModule {
    readonly name = "activity";

    readonly #durableFunctions: DurableFunctionsModule;
    /** The write runs outside the agent loop that accepted the message. */
    readonly #backgroundScope = new AsyncResource("happy-agent-activity");
    #agents: AgentSystemRef | undefined;

    constructor(durableFunctions: DurableFunctionsModule) {
        this.#durableFunctions = durableFunctions;
        // An agent cannot change its own metadata while accepting a message; the write follows
        // the acceptance's commit and survives a restart in between.
        durableFunctions.register({
            name: RECORD_FUNCTION,
            argumentsSchema: recordArgumentsSchema,
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#backgroundScope.runInAsyncScope(async () => {
                    const agents = this.#agents;
                    if (agents === undefined) throw new Error("Activity has not started.");
                    const { agentId, at } = call.arguments;
                    const config = await agents.config(ctx, agentId);
                    if (config === undefined) return null;
                    const previous = config.metadata?.[LAST_PERSON_MESSAGE_AT_METADATA_KEY];
                    if (typeof previous === "number" && previous >= at) return null;
                    const version = config.metadata?.["version"];
                    await agents.updateMetadata(ctx, agentId, {
                        [LAST_PERSON_MESSAGE_AT_METADATA_KEY]: at,
                        updatedAt: Date.now(),
                        version: typeof version === "number" ? version + 1 : 1,
                    });
                    return null;
                }),
        });
    }

    readonly #hooks: AgentModuleHooks = {
        messageAcceptedTransact: async (ctx, scope, accepted) => {
            if (accepted.message.role !== "user") return;
            if (
                !isUserOriginMetadata(accepted.metadata) &&
                !isGuestOriginMetadata(accepted.metadata)
            )
                return;
            await this.#durableFunctions.invoke(ctx, {
                function: RECORD_FUNCTION,
                operationId: `${RECORD_FUNCTION}:${accepted.id}`,
                lockKeys: [`${RECORD_FUNCTION}:${scope.agent.id}`],
                arguments: { agentId: scope.agent.id, at: Date.now() },
            });
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };
}
