import type { Context } from "@steve.kite/stdlib";

import type { AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentConfig } from "./AgentConfig.js";
import type { AgentDatabase } from "./AgentDatabase.js";
import type { AgentMetadata } from "./AgentMetadata.js";
import type { AgentMessageAcceptance } from "./AgentMessageAcceptance.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";
import { AgentRef } from "./AgentRef.js";
import type { AgentCreateOptions, AgentSystem } from "./AgentSystem.js";

/**
 * A reference to a collection of agents that cannot deadlock, for code that runs inside an agent
 * — a module hook, or a tool the run loop is waiting on. Every operation returns without
 * waiting for any agent's loop to reach a particular point.
 *
 * What is missing is missing on purpose. `delete` closes an agent and `start` resumes whole
 * agents; both are the owning caller's business, and both would wait for a loop that may be
 * waiting for the very code asking. `erase` is the one deletion offered here, because it commits
 * in a transaction and leaves the close to run after it, so it never waits for a loop. Agents
 * come back as `AgentRef` for the same reason — handing out the real `Agent` would hand back
 * `close` and `waitForIdle`, both of which wait for the whole agent.
 *
 * A message is the one thing a caller here may be told about, because accepting one is a durable
 * queue write rather than a turn: `steer` and `send` resolve once the message is safely part of
 * the target agent's conversation, and reject when that write fails, so a caller routing work to
 * another agent knows whether it arrived. The exception is the caller's own agent, whose loop is
 * what would have to perform that write — asked for itself, the message is queued and not waited
 * for. That is decided from the context, which names the agent the caller is running inside; a
 * context that names none proves nothing, so nothing is waited for there either.
 */
export class AgentSystemRef<Database extends AgentDatabase = AgentDatabase> {
    /** The collection this reference forwards every operation to without waiting on its loops. */
    readonly #system: AgentSystem<Database>;
    /** Identity whose lifecycle lock is held while this scoped reference is in use. */
    readonly #blockedAgentId: string | undefined;
    /** The agent this reference belongs to, or `null` for collection lifecycle code. */
    readonly agentId: string | null;

    /** Wrap a collection as the deadlock-free reference given to code running inside it. */
    constructor(
        system: AgentSystem<Database>,
        agentId: string | null = null,
        blockedAgentId?: string,
    ) {
        this.#system = system;
        this.agentId = agentId;
        this.#blockedAgentId = blockedAgentId;
    }

    /** The models this collection offers its agents. */
    get models(): readonly AgentModel[] {
        return this.#system.models;
    }

    /** Create an agent, inheriting this reference's agent as parent unless options override it. */
    async create(
        ctx: Context,
        config: AgentConfig,
        options?: AgentCreateOptions,
    ): Promise<AgentRef<Database>> {
        const parent = options?.parent === undefined ? this.agentId : options.parent;
        const agent = await this.#system.create(ctx, config, { ...options, parent });
        return new AgentRef(agent, parent);
    }

    /** A reference to an existing agent; resolving one that was never created is an error. */
    async resolve(ctx: Context, agentId: string): Promise<AgentRef<Database>> {
        this.#assertNotLifecycleTarget(agentId);
        const agent = await this.#system.resolve(ctx, agentId);
        const parent = await this.#system.parentOf(ctx, agentId);
        return new AgentRef(agent, parent);
    }

    /** The current configuration of an agent, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return await this.#system.config(ctx, agentId);
    }

    /** Shallow-merge fields into an agent's immutable metadata. */
    async updateMetadata(ctx: Context, agentId: string, update: AgentMetadata): Promise<void> {
        this.#assertNotLifecycleTarget(agentId);
        await this.#system.updateMetadata(ctx, agentId, update);
    }

    /** The direct children of an agent, in durable key order. */
    async childOf(ctx: Context, agentId: string): Promise<readonly string[]> {
        return await this.#system.childOf(ctx, agentId);
    }

    /** The parent of an agent, or `null` when it is a root. */
    async parentOf(ctx: Context, agentId: string): Promise<string | null> {
        return await this.#system.parentOf(ctx, agentId);
    }

    /**
     * Queue a steered message. For another agent this resolves once the message is durably
     * accepted and rejects when that write fails; for the caller's own agent it resolves as soon
     * as the agent has taken the request on.
     */
    async steer(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        this.#assertNotLifecycleTarget(agentId);
        return await this.#system.steer(ctx, agentId, message, options);
    }

    /**
     * Queue a sent message. For another agent this resolves once the message is durably accepted
     * and rejects when that write fails; for the caller's own agent it resolves as soon as the
     * agent has taken the request on.
     */
    async send(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance> {
        this.#assertNotLifecycleTarget(agentId);
        return await this.#system.send(ctx, agentId, message, options);
    }

    /** Ask an agent to compact, and resolve once it has been asked. */
    async compact(ctx: Context, agentId: string): Promise<void> {
        await (await this.resolve(ctx, agentId)).compact(ctx);
    }

    /** Cancel an agent's active turn, and resolve once the cancellation has been signalled. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        await (await this.resolve(ctx, agentId)).abort(ctx);
    }

    /**
     * Delete another agent for good, erasing everything it wrote, and resolve once that deletion
     * is durable. It never waits for the agent's loop: the deletion commits in one transaction,
     * the caller's own when it carries one, and the live agent closes after the commit. An agent
     * that is still finishing an earlier deletion is refused rather than waited for. This
     * reference's own agent cannot be erased through it, and neither can one of its ancestors,
     * because the loop asking would be closing itself or the agent it reports to. Children of the
     * erased agent are left as roots, so a caller erasing a tree erases the deepest agents first.
     * The context must carry the agent database, as every module and tool context does.
     */
    async erase(ctx: Context, agentId: string): Promise<void> {
        this.#assertNotLifecycleTarget(agentId);
        for (
            let ancestor: string | null = this.agentId;
            ancestor !== null;
            ancestor = await this.#system.parentOf(ctx, ancestor)
        ) {
            if (ancestor === agentId) {
                throw new Error(
                    `Agent "${agentId}" cannot be erased by itself or by an agent below it.`,
                );
            }
        }
        await ctx.inTx(async (txCtx) => {
            await this.#system.delete(txCtx, agentId, { erase: true });
        });
    }

    /** Fail quickly instead of re-entering an identity lock held by its transactional lifecycle. */
    #assertNotLifecycleTarget(agentId: string): void {
        if (agentId === this.#blockedAgentId) {
            throw new Error(
                `Agent "${agentId}" cannot be resolved from inside its transactional lifecycle hook.`,
            );
        }
    }
}
