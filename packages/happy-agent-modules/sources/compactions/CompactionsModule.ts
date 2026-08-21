import { createId } from "@paralleldrive/cuid2";
import type {
    AgentBaseCompactionStart,
    AgentBaseCompletedCompaction,
    AgentBaseInference,
    AgentBaseModelChange,
    AgentBaseSettlement,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import type { InvokeSlashCommandRequest } from "@slopus/happy-agent-client";

import { EventsModule } from "../events/index.js";
import { HistoryModule, type HistoryMessage } from "../history/index.js";
import type { SlashCommandDefinition } from "../slashCommands/index.js";
import { UsageModule } from "../usage/index.js";
import {
    CompactionAgentBusyError,
    CompactionAlreadyRunningError,
    compactionIdSchema,
    compactionPageQuerySchema,
    MAX_COMPACTION_FAILURE_REASON_LENGTH,
    MAX_COMPACTION_TOKEN_COUNT,
    type Compaction,
    type CompactionPage,
    type CompactionPageQuery,
    type RunningCompaction,
} from "./Compaction.js";
import { CompactionDatabase, compactionMigrations } from "./persistence/CompactionDatabase.js";

const RESTART_FAILURE = "Compaction was interrupted when the daemon restarted.";
const SETTLEMENT_FAILURE = "Compaction ended before the provider reported an outcome.";
const CANCELLATION_FAILURE = "Compaction was canceled.";

/** Durable manual and automatic context-compaction lifecycle for an agent collection. */
export class CompactionsModule implements AgentModule {
    readonly name = "compactions";
    readonly migrations = compactionMigrations;
    #agents: AgentSystemRef | undefined;

    constructor(
        private readonly events: EventsModule,
        private readonly usage: UsageModule,
        private readonly history: HistoryModule,
    ) {}

    async slashCommands(
        _ctx: Context,
        _agentId: string,
    ): Promise<readonly SlashCommandDefinition[]> {
        return [
            {
                description: "Summarize older messages to free context space.",
                hasArguments: false,
                kind: "compaction",
                name: "compact",
            },
        ];
    }

    async invokeSlashCommand(
        ctx: Context,
        agentId: string,
        name: string,
        _input: InvokeSlashCommandRequest,
    ): Promise<void> {
        if (name !== "compact") throw new Error(`The compactions module does not own /${name}.`);
        if (this.events.activeRunId(agentId) !== undefined) throw new CompactionAgentBusyError();
        await this.startManual(ctx, agentId);
    }

    async get(ctx: Context, compactionId: string): Promise<Compaction | undefined> {
        assertCompactionId(compactionId);
        return await new CompactionDatabase().get(ctx, compactionId);
    }

    async running(ctx: Context, agentId: string): Promise<RunningCompaction | undefined> {
        assertCompactionId(agentId);
        return await new CompactionDatabase().running(ctx, agentId);
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: CompactionPageQuery = {},
    ): Promise<CompactionPage> {
        assertCompactionId(agentId);
        if (!Value.Check(compactionPageQuerySchema, query)) {
            throw new Error("The compaction page query is invalid.");
        }
        return await new CompactionDatabase().listPage(ctx, agentId, query);
    }

    /** Project the internal lifecycle row into its canonical durable history message. */
    historyMessage(compaction: Compaction): HistoryMessage {
        const base = {
            replacedMessageIds: [...compaction.replacedMessageIds],
            startedAt: compaction.startedAt,
            tokensBefore: compaction.tokensBefore ?? null,
            trigger: compaction.trigger,
            type: "compaction" as const,
        };
        const block: HistoryMessage["blocks"][number] =
            compaction.status === "running"
                ? {
                      ...base,
                      completedAt: null,
                      failureReason: null,
                      status: "running",
                      tokensAfter: null,
                  }
                : compaction.status === "completed"
                  ? {
                        ...base,
                        completedAt: compaction.completedAt,
                        failureReason: null,
                        status: "completed",
                        tokensAfter: compaction.tokensAfter ?? null,
                    }
                  : {
                        ...base,
                        completedAt: compaction.completedAt,
                        failureReason: compaction.failureReason,
                        status: "failed",
                        tokensAfter: null,
                    };
        return {
            at: compaction.startedAt,
            blocks: [block],
            recordId: compaction.id,
            role: "service",
            runId: compaction.runId,
        };
    }

    /** Create the durable manual attempt before asking Agent Base to carry it out. */
    async startManual(ctx: Context, agentId: string): Promise<Compaction> {
        assertCompactionId(agentId);
        const agents = this.#agents;
        if (agents === undefined) {
            throw new Error("The compactions module has not started.");
        }
        const current = await this.usage.read(ctx, agentId);
        const startedAt = Date.now();
        const id = createId();
        const compaction = await ctx.inTx(async (txCtx): Promise<RunningCompaction> => {
            const running = await new CompactionDatabase().running(txCtx, agentId);
            if (running !== undefined) throw new CompactionAlreadyRunningError(running);
            const created: RunningCompaction = {
                agentId,
                id,
                runId: id,
                replacedMessageIds: await this.history.compactionMessageIds(txCtx, agentId),
                startedAt,
                status: "running",
                ...(current.currentContext === undefined
                    ? {}
                    : { tokensBefore: current.currentContext.contextTokens }),
                trigger: "manual",
                updatedAt: startedAt,
                version: 1,
            };
            await this.history.beginMaintenanceRun(txCtx, agentId, created.runId, startedAt);
            await this.history.record(txCtx, agentId, this.historyMessage(created));
            await new CompactionDatabase().insert(txCtx, created);
            await this.#recordCreated(txCtx, created);
            return created;
        });
        try {
            await agents.compact(ctx, agentId);
        } catch (error: unknown) {
            await ctx.inTx(
                async (txCtx) =>
                    await this.#failRunning(
                        txCtx,
                        agentId,
                        error instanceof Error ? error.message : SETTLEMENT_FAILURE,
                    ),
            );
            throw error;
        }
        return (await this.get(ctx, compaction.id)) ?? compaction;
    }

    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        await ctx.inTx(async (txCtx) => {
            for (const running of await new CompactionDatabase().runningAll(txCtx)) {
                await this.#fail(txCtx, running, RESTART_FAILURE);
            }
        });
        return this.#hooks;
    };

    readonly #hooks: AgentModuleHooks = {
        beforeCompaction: async (ctx, scope, compaction) => {
            await this.#startAttempt(ctx, scope, compaction);
        },
        historyErasedTransact: async (ctx, scope, compaction) => {
            await this.#complete(ctx, scope.agent.id, compaction);
        },
        afterCompaction: async (ctx, scope, compaction) => {
            if (compaction.result.status === "completed") return;
            await ctx.inTx(async (txCtx) => {
                await this.#failByBase(
                    txCtx,
                    scope.agent.id,
                    compaction.compactionId,
                    compaction.result.status === "failed"
                        ? compaction.result.message
                        : CANCELLATION_FAILURE,
                );
            });
        },
        afterInferenceTransact: async (ctx, scope, inference) => {
            await this.#measureReplacement(ctx, scope, inference);
        },
        modelChanged: async (ctx, scope, _change: AgentBaseModelChange) => {
            await new CompactionDatabase().clearAwaitingAfter(ctx, scope.agent.id);
            return undefined;
        },
        afterAgentSettledTransact: async (ctx, scope, settlement) => {
            await this.#settleOrphan(ctx, scope, settlement);
        },
    };

    async #startAttempt(
        ctx: Context,
        scope: AgentModuleScope,
        attempt: AgentBaseCompactionStart,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            const database = new CompactionDatabase();
            const running = await database.running(txCtx, scope.agent.id);
            if (running !== undefined) {
                const tokensBefore = boundedTokens(attempt.contextTokens);
                const changed = tokensBefore !== undefined && running.tokensBefore !== tokensBefore;
                const next: RunningCompaction = changed
                    ? {
                          ...running,
                          tokensBefore,
                          updatedAt: Math.max(running.updatedAt, Date.now()),
                          version: running.version + 1,
                      }
                    : running;
                await database.update(txCtx, next, {
                    baseCompactionId: attempt.compactionId,
                });
                if (changed) await this.#publishUpdate(txCtx, running, next);
                return;
            }
            const runId =
                (await this.events.activeRunIdInTransaction(txCtx, scope.agent.id)) ??
                this.events.activeRunId(scope.agent.id) ??
                attempt.loopId;
            const startedAt = Date.now();
            const tokensBefore = boundedTokens(attempt.contextTokens);
            const compaction: RunningCompaction = {
                agentId: scope.agent.id,
                id: attempt.compactionId,
                runId,
                replacedMessageIds: await this.history.compactionMessageIds(txCtx, scope.agent.id),
                startedAt,
                status: "running",
                ...(tokensBefore === undefined ? {} : { tokensBefore }),
                trigger: "automatic",
                updatedAt: startedAt,
                version: 1,
            };
            await database.insert(txCtx, compaction, {
                baseCompactionId: attempt.compactionId,
            });
            await this.history.record(txCtx, scope.agent.id, this.historyMessage(compaction));
            await this.#recordCreated(txCtx, compaction);
        });
    }

    async #complete(
        ctx: Context,
        agentId: string,
        attempt: AgentBaseCompletedCompaction,
    ): Promise<void> {
        const database = new CompactionDatabase();
        const running =
            (await database.byBase(ctx, attempt.compactionId)) ??
            (await database.running(ctx, agentId));
        if (running === undefined || running.status !== "running") return;
        const completedAt = Math.max(running.updatedAt, Date.now());
        const provisionalTokens = boundedTokens(attempt.contextTokens);
        const measuredTokens = boundedTokens(attempt.result.usage.input);
        const tokensBefore =
            measuredTokens === undefined || (measuredTokens === 0 && (provisionalTokens ?? 0) > 0)
                ? provisionalTokens
                : measuredTokens;
        const next: Compaction = {
            ...running,
            completedAt,
            status: "completed",
            ...(tokensBefore === undefined ? {} : { tokensBefore }),
            updatedAt: completedAt,
            version: running.version + 1,
        };
        await database.update(ctx, next, {
            baseCompactionId: attempt.compactionId,
            awaitingAfter: true,
        });
        await this.#publishUpdate(ctx, running, next);
        if (next.trigger === "manual") {
            await this.history.finishMaintenanceRun(
                ctx,
                next.agentId,
                next.runId,
                "completed",
                completedAt,
            );
        }
    }

    async #failByBase(
        ctx: Context,
        agentId: string,
        baseCompactionId: string,
        reason: string,
    ): Promise<void> {
        const database = new CompactionDatabase();
        const running =
            (await database.byBase(ctx, baseCompactionId)) ??
            (await database.running(ctx, agentId));
        if (running?.status !== "running") return;
        await this.#fail(ctx, running, reason);
    }

    async #failRunning(ctx: Context, agentId: string, reason: string): Promise<void> {
        const running = await new CompactionDatabase().running(ctx, agentId);
        if (running !== undefined) await this.#fail(ctx, running, reason);
    }

    async #fail(ctx: Context, running: RunningCompaction, reason: string): Promise<void> {
        const completedAt = Math.max(running.updatedAt, Date.now());
        const next: Compaction = {
            ...running,
            completedAt,
            failureReason: boundedFailure(reason),
            status: "failed",
            updatedAt: completedAt,
            version: running.version + 1,
        };
        await new CompactionDatabase().update(ctx, next);
        await this.#publishUpdate(ctx, running, next);
        if (next.trigger === "manual") {
            await this.history.finishMaintenanceRun(
                ctx,
                next.agentId,
                next.runId,
                "failed",
                completedAt,
            );
        }
    }

    async #measureReplacement(
        ctx: Context,
        scope: AgentModuleScope,
        inference: AgentBaseInference,
    ): Promise<void> {
        if (inference.tokens === undefined) return;
        const database = new CompactionDatabase();
        const previous = await database.awaitingAfter(ctx, scope.agent.id);
        if (previous === undefined || previous.status !== "completed") return;
        const tokensAfter = boundedTokens(inference.tokens.input + inference.tokens.output);
        if (tokensAfter === undefined) {
            await database.clearAwaitingAfter(ctx, scope.agent.id);
            return;
        }
        const updatedAt = Math.max(previous.updatedAt, Date.now());
        const next: Compaction = {
            ...previous,
            tokensAfter,
            updatedAt,
            version: previous.version + 1,
        };
        await database.update(ctx, next);
        await this.#publishUpdate(ctx, previous, next);
    }

    async #settleOrphan(
        ctx: Context,
        scope: AgentModuleScope,
        settlement: AgentBaseSettlement,
    ): Promise<void> {
        await this.#failRunning(ctx, scope.agent.id, settlement.error ?? SETTLEMENT_FAILURE);
    }

    async #publishUpdate(
        ctx: Context,
        previous: Compaction,
        compaction: Compaction,
    ): Promise<void> {
        await this.history.replace(ctx, compaction.agentId, this.historyMessage(compaction));
        await this.events.record(ctx, {
            agentId: compaction.agentId,
            payload: { compaction, previous },
            type: "compaction.message-updated",
        });
    }

    async #recordCreated(ctx: Context, compaction: RunningCompaction): Promise<void> {
        await this.events.record(ctx, {
            agentId: compaction.agentId,
            payload: { compaction },
            type: "compaction.message-created",
        });
    }
}

function assertCompactionId(value: string): void {
    if (!Value.Check(compactionIdSchema, value)) {
        throw new Error("The compaction identifier is invalid.");
    }
}

function boundedTokens(value: number | undefined): number | undefined {
    return value !== undefined &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_COMPACTION_TOKEN_COUNT
        ? value
        : undefined;
}

function boundedFailure(value: string): string {
    const normalized = value.trim();
    const reason = normalized.length === 0 ? SETTLEMENT_FAILURE : normalized;
    return reason.slice(0, MAX_COMPACTION_FAILURE_REASON_LENGTH);
}
