import type { AgentModule, AgentModuleHooks, AgentSystemRef } from "@slopus/happy-agent-base";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../compute/index.js";

/** The largest descendant tree one abort operation will hold in memory. */
export const MAX_ABORT_CHAIN_AGENTS = 10_000;

/**
 * Cancels one agent and every agent below it as one transactionally released operation.
 *
 * The module reads one stable ancestry snapshot and registers every abort on the same transaction.
 * A traversal or resolution failure therefore releases no aborts, while commit immediately
 * signals the whole chain from its leaves to its root. It never waits for any run, provider,
 * tool, or descendant to settle. Several aborts sharing one transaction — the way archiving a
 * project cancels its root agents and each of its workspaces' agents — cancel each identity once
 * between them.
 */
export class AbortModule implements AgentModule {
    readonly name = "abort";
    readonly #compute: ComputeModule;
    /** Who each open transaction has already cancelled, so one transaction signals nobody twice. */
    readonly #signalled = new WeakMap<object, Set<string>>();

    #agents: AgentSystemRef | undefined;

    constructor(compute: ComputeModule) {
        this.#compute = compute;
    }

    /** Immediately abort the target and every descendant without waiting for them to settle. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        const agents = this.#requireAgents();
        await ctx.inTx(async (txCtx) => {
            const chain = await descendantChain(txCtx, agents, agentId);
            // A descendant can report its settlement to its parent. Release leaf cancellations
            // first so those reports arrive before the ancestor's cancellation and cannot reopen
            // an ancestor that was already signalled.
            const alreadySignalled = this.#signalledIn(txCtx);
            // One transaction can reach the same identity twice — a subagent standing in a
            // workspace being archived that also hangs below the root agent of the project the
            // workspace was cut from. Cancelling it once is the whole decision; repeating it would
            // overwrite the notice it has already been left with a poorer one.
            const leafFirst = [...chain]
                .reverse()
                .filter((targetAgentId) => !alreadySignalled.has(targetAgentId));
            for (const targetAgentId of leafFirst) alreadySignalled.add(targetAgentId);
            for (const targetAgentId of leafFirst) {
                await this.#compute.recordAbortNotice(txCtx, targetAgentId);
                await agents.abort(txCtx, targetAgentId);
            }
            // Register every run cancellation before the process cleanup. At commit the complete
            // subtree is signalled first, then every compute advances its abort generation and
            // hard-kills its process groups concurrently. An empty process snapshot is irrelevant:
            // a command still crossing spawn observes the generation change and dies too.
            afterCommit(txCtx, async (postCommitCtx) => {
                await Promise.all(
                    leafFirst.map(async (targetAgentId) => {
                        try {
                            await this.#compute.hardKillAgentProcesses(
                                postCommitCtx,
                                targetAgentId,
                            );
                        } catch (error: unknown) {
                            postCommitCtx.log.error(
                                "Abort could not hard-kill an agent's background processes.",
                                { agentId: targetAgentId },
                                error,
                            );
                        }
                    }),
                );
            });
        });
    }

    /** Capture the collection whose ancestry and abort operation this module composes. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {};
    };

    /**
     * The identities this context's transaction has already cancelled. The transaction's own
     * database facade is the key, so the set lives exactly as long as the transaction does and a
     * later transaction — including a retry of one that rolled back — starts from nothing.
     */
    #signalledIn(txCtx: Context): Set<string> {
        const transaction: object = txCtx.db;
        const existing = this.#signalled.get(transaction);
        if (existing !== undefined) return existing;
        const created = new Set<string>();
        this.#signalled.set(transaction, created);
        return created;
    }

    #requireAgents(): AgentSystemRef {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The abort module has not been started yet.");
        return agents;
    }
}

/** Read one bounded breadth-first snapshot and reject anything that is not a tree. */
async function descendantChain(
    ctx: Context,
    agents: AgentSystemRef,
    rootAgentId: string,
): Promise<readonly string[]> {
    const pending = [rootAgentId];
    const visited = new Set<string>();
    for (let index = 0; index < pending.length; index += 1) {
        const agentId = pending[index];
        if (agentId === undefined) continue;
        if (visited.has(agentId)) {
            throw new Error("The agent descendant chain contains a cycle or duplicate identity.");
        }
        if (visited.size >= MAX_ABORT_CHAIN_AGENTS) {
            throw new Error(
                `An abort is limited to ${String(MAX_ABORT_CHAIN_AGENTS)} agents in one chain.`,
            );
        }
        visited.add(agentId);
        pending.push(...(await agents.childOf(ctx, agentId)));
    }
    return [...visited];
}
