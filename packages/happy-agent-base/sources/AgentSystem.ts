import type { SessionMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { Agent } from "./Agent.js";
import type { AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentConfig } from "./AgentConfig.js";
import type { AgentDatabase } from "./AgentDatabase.js";
import type { AgentMetadata } from "./AgentMetadata.js";
import type { AgentMessageAcceptance } from "./AgentMessageAcceptance.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";
import type { AnyAgentTool } from "./AgentTool.js";
import type { AgentBasePendingStage } from "./AgentBasePending.js";

/** One agent that has not reached its requested draining edge yet. */
export interface AgentSystemDrainAgent {
    /** Stable agent identity. */
    readonly id: string;
    /** The durable Base stage the agent is currently finishing. */
    readonly stage: AgentBasePendingStage;
}

/** Bounded live progress for an agent system moving toward its draining edge. */
export interface AgentSystemDrainProgress {
    /** Exact number of agents still running toward an edge. */
    readonly count: number;
    /** ID-sorted detail, bounded by the requested limit. */
    readonly agents: readonly AgentSystemDrainAgent[];
    /** Present only when more agents are waiting than fit in `agents`. */
    readonly truncated?: true;
}

/** Conversation state installed atomically before a newly created agent starts. */
export interface AgentInitialContext {
    /** The conversation installed as the agent's history before its first turn runs. */
    readonly messages: readonly SessionMessage[];
}

/** Optional identity, ancestry, and conversation supplied while creating one agent. */
export interface AgentCreateOptions {
    /** Client-chosen cuid2 identity; generated when omitted. */
    readonly id?: string;
    /** The conversation installed before the agent's first turn. */
    readonly initialContext?: AgentInitialContext;
    /**
     * The parent agent. Omission inherits the creating reference or calling agent, `null` creates
     * a root, and an explicit ID must already exist.
     */
    readonly parent?: string | null;
}

/**
 * A collection of agents addressed by ID: what an owner can ask of the agents it runs. An agent
 * exists only once it has been created with its persisted configuration; resolving one that was
 * never created is an error. Environment and module settings stay fixed, while metadata changes
 * through a transactional shallow merge.
 *
 * This is the full surface, including the operations that wait for an agent's run loop to reach a
 * particular point — `delete`, and anything reached through the returned `Agent`. Those are for
 * the caller that owns the agents' lifetime. Code running *inside* an agent, such as a module
 * hook or a tool, is waited for by that loop and must not wait for it in turn: it should hold an
 * `AgentSystemRef`, whose every operation returns without waiting for a loop.
 */
export interface AgentSystem<Database extends AgentDatabase = AgentDatabase> {
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];

    /** Stop every agent and release this system's exclusive ownership of its durable store. */
    close(ctx: Context): Promise<void>;

    /** Stop every live loop at its next durable edge under each tool's declared stop behavior. */
    drain(): Promise<void>;

    /** Report the agents that have not reached their requested draining edge yet. */
    drainProgress(limit?: number): AgentSystemDrainProgress;

    /**
     * Create an agent with a generated or caller-supplied cuid2 identity. Configuration,
     * parentage, and optional initial context are persisted before it runs.
     */
    create(
        ctx: Context,
        config: AgentConfig,
        options?: AgentCreateOptions,
    ): Promise<Agent<AnyAgentTool, Database>>;

    /** Close an agent and release its identity, so the same ID can be created again. */
    delete(ctx: Context, agentId: string): Promise<void>;

    /** The current configuration of an agent, or undefined when there is no such agent. */
    config(ctx: Context, agentId: string): Promise<AgentConfig | undefined>;

    /** Shallow-merge fields into an agent's immutable metadata. */
    updateMetadata(ctx: Context, agentId: string, update: AgentMetadata): Promise<void>;

    /** The direct children of an agent, in durable key order. */
    childOf(ctx: Context, agentId: string): Promise<readonly string[]>;

    /** The parent of an agent, or `null` when it is a root. */
    parentOf(ctx: Context, agentId: string): Promise<string | null>;

    /** The live agent for an ID, loading it if this process has not seen it yet. */
    resolve(ctx: Context, agentId: string): Promise<Agent<AnyAgentTool, Database>>;

    /**
     * Queue a message for an agent, injected as soon as its current response and tool batch
     * finish.
     */
    steer(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance>;

    /** Queue a message for an agent that injects only when the agent would otherwise stop. */
    send(
        ctx: Context,
        agentId: string,
        message: AgentQueuedMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<AgentMessageAcceptance>;

    /** Cancel an agent's active turn, leaving its queued messages durable for the next one. */
    abort(ctx: Context, agentId: string): Promise<void>;

    /** Ask an agent for its conversation to be replaced by the provider's summary of it. */
    compact(ctx: Context, agentId: string): Promise<void>;
}
