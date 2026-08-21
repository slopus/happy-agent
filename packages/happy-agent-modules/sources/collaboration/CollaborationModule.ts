import {
    agentConfig,
    type AgentBasePersistedEvent,
    type AgentBaseSettlement,
    type AgentConfig,
    type AgentMetadata,
    type AgentModel,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { AbortModule } from "../abort/index.js";
import { senderAgentIdMetadata } from "../impl/messageOrigin.js";
import {
    collaborationAgentIdSchema,
    collaborationCreateInputSchema,
    collaborationCreateOptionsSchema,
    collaborationSendInputSchema,
    type CollaborationAgentSelection,
    type CollaborationCreateInput,
    type CollaborationCreateOptions,
    type CollaborationCreateResult,
    type CollaborationSendInput,
} from "./CollaborationAgent.js";
import { collaborationMigrations } from "./CollaborationMigrations.js";
import { createAgentTool } from "./tools/create_agent.js";
import { interruptAgentTool } from "./tools/interrupt_agent.js";
import { sendMessageTool } from "./tools/send_message.js";

/**
 * Collaboration lets one agent put another to work.
 *
 * Agents are actors: each one already has a durable inbox, an identity, and a parent, all owned by
 * Agent Base. So this module stores nothing. It has no tables of its own — every question it
 * answers is asked of the agent collection through `AgentSystemRef`, and every message it sends
 * goes into the recipient's real durable inbox. Agent Base makes those queue writes idempotent on
 * the supplied message ID. Its only migrations retire the schema it used to keep.
 *
 * Messages are asynchronous, in both directions and without exception. Nothing here waits for an
 * answer, and nothing records that one is owed: a reply is simply a message sent back, and it
 * arrives in the sender's inbox to be read as ordinary conversation on its next turn. An agent
 * that wants to keep working while a collaborator thinks just keeps working.
 *
 * What a collaborator runs on is settled once, on the message that starts it, and no later message
 * carries a model, an effort, or a permission mode.
 */
export class CollaborationModule implements AgentModule {
    readonly name = "collaboration";

    /** Only the retirement of the schema this module used to keep. See the file for why it stays. */
    readonly migrations = collaborationMigrations;

    readonly #abort: AbortModule;
    #agents: AgentSystemRef | undefined;

    constructor(abort: AbortModule) {
        this.#abort = abort;
    }

    /**
     * Create a collaborator and hand it its opening task. The call returns as soon as the work is
     * in the collaborator's inbox; whatever it has to say comes back later as a message.
     */
    async createAgent(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationCreateInput,
        agentId: string,
        options: CollaborationCreateOptions = {},
    ): Promise<CollaborationCreateResult> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationAgentIdSchema, agentId, "collaborator ID");
        this.#assert(collaborationCreateInputSchema, input, "create agent");
        this.#assert(collaborationCreateOptionsSchema, options, "create agent options");
        const agents = this.#requireAgents();
        const selection = this.#validateSelection(agents.models, input);

        // A durable tool call may be retried after the collaborator was created but before the
        // result was recorded. An identity this agent already created is that retry, so only the
        // half that did not finish is redone; `send` settles the rest by message ID. An identity
        // belonging to anyone else is a different agent that happens to hold the ID, and treating
        // it as a retry would hand this creator's task to a stranger.
        if ((await agents.config(ctx, agentId)) === undefined) {
            // The creating call does not always run on the creator's own turn — a workflow starts
            // collaborators from its own background context, which carries no agent configuration —
            // so fall back to what the creator was stored with.
            const parent = agentConfig(ctx) ?? (await agents.config(ctx, actingAgentId));
            const created = await agents.create(ctx, childConfig(parent, input.title, options), {
                id: agentId,
                parent: actingAgentId,
            });
            if (created.id !== agentId) {
                throw new Error("Agent Base did not preserve the requested collaborator ID.");
            }
        } else if ((await agents.parentOf(ctx, agentId)) !== actingAgentId) {
            throw new Error(`Agent "${agentId}" already exists.`);
        }
        await this.#deliver(ctx, actingAgentId, agentId, input.text, agentId, selection);
        return { agentId };
    }

    /**
     * Send text to a collaborator this agent can already reach. Replying is this same operation:
     * an answer is a message addressed back to whoever asked.
     */
    async sendMessage(
        ctx: Context,
        actingAgentId: string,
        input: CollaborationSendInput,
        messageId: string,
    ): Promise<void> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationSendInputSchema, input, "send message");
        await this.#authorize(ctx, actingAgentId, input.toAgentId, "send to");
        await this.#deliver(ctx, actingAgentId, input.toAgentId, input.text, messageId, undefined);
    }

    /** Immediately abort a collaborator and every descendant without waiting for settlement. */
    async interruptAgent(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
    ): Promise<void> {
        this.#assert(collaborationAgentIdSchema, actingAgentId, "acting agent ID");
        this.#assert(collaborationAgentIdSchema, targetAgentId, "target agent ID");
        await this.#authorize(ctx, actingAgentId, targetAgentId, "interrupt");
        await this.#abort.abort(ctx, targetAgentId);
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * Who this agent can reach, by ID.
         *
         * An agent that cannot name its creator cannot send it anything. The sender's name is in each
         * delivered message, but that line ages out of history on compaction — while the relationship
         * does not. Reading it from the agent collection every turn means the address is always
         * available and never stored twice.
         */
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const agents = this.#requireAgents();
            const [parent, children] = await Promise.all([
                agents.parentOf(ctx, scope.agent.id),
                agents.childOf(ctx, scope.agent.id),
            ]);
            const lines: string[] = [];
            if (parent !== null) {
                lines.push(
                    `You were created by agent ${parent}. When you stop working, whatever you said last is reported to it automatically, so finish by stating your answer. Use send_agent_message only to tell it something before then.`,
                );
            }
            if (children.length > 0) {
                lines.push(
                    `Collaborators you created: ${children.join(", ")}. Each reports back on its own when it finishes; nothing waits for them.`,
                );
            }
            return lines.join("\n");
        },

        /**
         * Keep the last thing the model said, for as long as the run that said it. The run store is
         * the right place: it exists only while the agent is working, a crash mid-run leaves a note
         * the resumed run can still read, and a finished run leaves nothing behind.
         */
        onEventTransact: async (
            ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): Promise<void> => {
            if (event.type !== "text_end") return;
            const text = event.block.text.trim();
            if (text === "") return;
            await scope.runKV.write(ctx, LAST_TEXT_KEY, text);
        },

        afterAgentSettledTransact: (
            ctx: Context,
            scope: AgentModuleScope,
            settlement: AgentBaseSettlement,
        ): Promise<void> => this.#afterAgentSettledTransact(ctx, scope, settlement),

        /**
         * The tool surface is fixed for one collection's models, so a model sees the same capabilities
         * on every turn and provider prompt caching still applies.
         */
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            createAgentTool(
                this,
                scope.agent.id,
                scope.agent.provider,
                this.#requireAgents().models,
            ),
            sendMessageTool(this, scope.agent.id),
            interruptAgentTool(this, scope.agent.id),
        ],
    };

    /** The collection every collaborator is created in and every message is delivered through. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /**
     * Pass a collaborator's answer to its creator, verbatim, when the collaborator stops working.
     *
     * This is the runtime reporting, not the model choosing to, which is what makes an answer
     * arrive at all now that nothing waits for one. A run that said nothing reports nothing: a
     * collaborator interrupted mid-sentence, or told that no action is needed, has no answer to
     * pass on, and announcing its silence would put a line in the creator's conversation that
     * tells it something it already knows.
     *
     * It all happens in the settling transaction, which is the point: this transaction erases the
     * run store, so it is the last moment the run's own words can be read, and the delivery
     * commits with the settlement rather than after it. The collaborator has stopped and its
     * creator has been told, or neither is true. A failure here rolls the settlement back with it,
     * leaving the run recorded as unfinished, so the report is made again the next time it settles
     * rather than being lost.
     */
    async #afterAgentSettledTransact(
        ctx: Context,
        scope: AgentModuleScope,
        settlement: AgentBaseSettlement,
    ): Promise<void> {
        if (!reportsToCreator(scope.agent.metadata)) return;
        const agents = this.#requireAgents();
        const parent = await agents.parentOf(ctx, scope.agent.id);
        if (parent === null) return;
        const said = await scope.runKV.read(ctx, LAST_TEXT_KEY);
        // Whitespace is not an answer. The note is written trimmed, so a blank one can only come
        // from a store this run does not control, and reporting it would put an empty quotation in
        // the creator's conversation.
        const answer = typeof said === "string" ? said.trim() : "";
        // An answer is what the creator asked for; a failure is why it is not coming. A run that
        // recovered from an error and went on to speak reports what it said, not what it survived.
        const report =
            answer === ""
                ? failureReport(scope.agent.id, settlement.error)
                : answerReport(scope.agent.id, answer);
        if (report === undefined) return;
        await agents.steer(
            ctx,
            parent,
            {
                role: "agent",
                author: {
                    id: scope.agent.id,
                    description: `Collaborator ${scope.agent.id}`,
                },
                content: [{ type: "text", text: report }],
            },
            {
                // The settlement has one identity, so a retried report is the same message rather
                // than a second one.
                id: settlement.settlementId,
                metadata: {
                    collaboration: {
                        kind: "subagent_report",
                        fromAgentId: scope.agent.id,
                        toAgentId: parent,
                    },
                    ...senderAgentIdMetadata(scope.agent.id),
                },
            },
        );
    }

    /**
     * Put one message in an agent's inbox.
     *
     * The recipient's model only ever sees text, so the sender is named in the text rather than
     * only in metadata — that name is the address an answer is sent back to. The metadata carries
     * the same facts for anything on the receiving side that reads structure instead of prose.
     */
    async #deliver(
        ctx: Context,
        fromAgentId: string,
        toAgentId: string,
        text: string,
        messageId: string,
        selection: CollaborationAgentSelection | undefined,
    ): Promise<void> {
        const accepted = await this.#requireAgents().send(
            ctx,
            toAgentId,
            {
                role: "agent",
                author: { id: fromAgentId, description: `Agent ${fromAgentId}` },
                content: [{ type: "text", text: `Message from agent ${fromAgentId}:\n\n${text}` }],
            },
            {
                id: messageId,
                metadata: {
                    collaboration: { fromAgentId, toAgentId },
                    ...senderAgentIdMetadata(fromAgentId),
                },
                ...(selection === undefined
                    ? {}
                    : {
                          model: selection.model,
                          effort: selection.effort,
                          ...(selection.provider === undefined
                              ? {}
                              : { provider: selection.provider }),
                          ...(selection.serviceTier === undefined
                              ? {}
                              : { serviceTier: selection.serviceTier }),
                      }),
            },
        );
        if (accepted.id !== messageId) {
            throw new Error("Agent Base did not preserve the requested message ID.");
        }
    }

    /**
     * Who may reach whom. Ancestry is the whole policy, and it is read from the agent collection
     * rather than from a roster of this module's own: an agent reaches the collaborators it
     * created, and the agent that created it.
     */
    async #authorize(
        ctx: Context,
        actingAgentId: string,
        targetAgentId: string,
        action: string,
    ): Promise<void> {
        const agents = this.#requireAgents();
        if ((await agents.parentOf(ctx, targetAgentId)) === actingAgentId) return;
        if ((await agents.parentOf(ctx, actingAgentId)) === targetAgentId) return;
        throw new Error(
            `Agent "${actingAgentId}" is not authorized to ${action} agent "${targetAgentId}".`,
        );
    }

    /** Reject a model, effort, provider, or tier the collection does not actually offer. */
    #validateSelection(
        models: readonly AgentModel[],
        input: CollaborationCreateInput,
    ): CollaborationAgentSelection {
        if (input.provider === undefined) {
            const providers = new Set(
                models.filter((model) => model.id === input.model).map((m) => m.providerId),
            );
            if (providers.size > 1) {
                throw new Error(
                    `Provider is required because model "${input.model}" is available from more than one provider.`,
                );
            }
        }
        const candidates = models.filter(
            (model) =>
                model.id === input.model &&
                (input.provider === undefined || model.providerId === input.provider),
        );
        if (candidates.length === 0) {
            throw new Error(
                input.provider === undefined
                    ? `Model "${input.model}" is not available for collaborators.`
                    : `Model "${input.model}" is not available from provider "${input.provider}".`,
            );
        }
        const byEffort = candidates.filter((model) => model.effortLevels.includes(input.effort));
        if (byEffort.length === 0) {
            throw new Error(
                `Effort "${input.effort}" is not available for collaborator model "${input.model}".`,
            );
        }
        const tier = input.serviceTier;
        if (
            tier !== undefined &&
            !byEffort.some((model) => model.serviceTiers?.includes(tier) === true)
        ) {
            throw new Error(
                `Service tier "${tier}" is not available for collaborator model "${input.model}".`,
            );
        }
        return {
            model: input.model,
            effort: input.effort,
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(tier === undefined ? {} : { serviceTier: tier }),
        };
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) {
            throw new Error("The collaboration module has not been started yet.");
        }
        return this.#agents;
    }

    #assert(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`Invalid collaboration ${label}.`);
    }
}

/** Where a run keeps the last thing its model said, until the run ends. */
const LAST_TEXT_KEY = "lastText";

/** How a collaborator's answer reaches its creator. */
function answerReport(agentId: string, answer: string): string {
    return `Collaborator ${agentId} finished working. Its answer follows, verbatim.\n\n${answer}`;
}

/**
 * Why this run has no answer, phrased for the creator, or nothing when it simply had none.
 *
 * Silence and failure are not the same thing. A collaborator that was interrupted, or that was
 * told no action was needed, has nothing to add and announcing that would only tell its creator
 * what it already knows. A collaborator that hit a usage limit, lost its credentials, or died
 * with an error thrown out of its loop has stopped for a reason its creator cannot otherwise
 * discover, and which decides whether the work should be retried, sent elsewhere, or abandoned.
 *
 * The settlement is where that reason comes from. Every run settles, failed ones included, and it
 * carries the failure that ended the run in the same words the conversation was told — including
 * a failure the conversation itself could never record. A run that recovered and went on to speak
 * settles without one.
 */
function failureReport(agentId: string, error: string | undefined): string | undefined {
    if (error === undefined) return undefined;
    const reason = error.trim();
    return `Collaborator ${agentId} stopped without answering. It failed with, verbatim.\n\n${
        reason === "" ? "The model did not answer." : reason
    }`;
}

/**
 * A collaborator works on the same machine and with the same modules as whoever created it, and
 * carries the title that call gave it in the agent's real metadata rather than in a record of
 * collaboration's own. Metadata the creating code adds travels the same way, and a creator that
 * collects the answer itself records that here so the settlement knows not to report it twice.
 */
function childConfig(
    parent: AgentConfig | undefined,
    title: string,
    options: CollaborationCreateOptions,
): AgentConfig {
    return {
        ...(parent?.environment === undefined ? {} : { environment: parent.environment }),
        ...(parent?.modules === undefined ? {} : { modules: parent.modules }),
        metadata: {
            ...options.metadata,
            title,
            ...(options.reportToCreator === false
                ? { collaboration: { reportToCreator: false } }
                : {}),
        },
    };
}

/**
 * Whether this agent's answer is still owed to whoever created it. Only a creator that collects
 * the answer another way turns this off, and it says so in the agent's own metadata, so the
 * decision survives a restart that forgets everything the creating call held in memory.
 */
function reportsToCreator(metadata: AgentMetadata | undefined): boolean {
    const collaboration = metadata?.["collaboration"];
    if (
        collaboration === null ||
        typeof collaboration !== "object" ||
        Array.isArray(collaboration)
    ) {
        return true;
    }
    return collaboration["reportToCreator"] !== false;
}
