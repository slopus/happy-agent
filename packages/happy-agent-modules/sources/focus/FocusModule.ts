import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { agentStatusLineSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, createContextNamespace, detach, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, isUserOriginMetadata } from "../impl/messageOrigin.js";
import { RichTasksModule, TASK_FOCUS_SETTING, TASK_SECTIONS_SETTING } from "../richTasks/index.js";
import { SubtasksModule, type CreateSubtaskInput } from "../subtasks/index.js";
import { TaskConflictError, TaskNotFoundError, TasksModule } from "../tasks/index.js";
import { UserSettingsModule } from "../userSettings/index.js";
import { FOCUS_INSTRUCTIONS } from "./impl/focusInstructions.js";
import * as store from "./persistence/focusStore.js";
import {
    organizeTasksTool,
    type FocusOp,
    type FocusSkipReason,
    type OrganizeTasksResult,
} from "./tools/organize_tasks.js";

const BRIEF_FUNCTION = "focus.brief";
/** Notices collect for this long after the first one, so a burst of turns becomes one brief. */
const BURST_MS = 2_000;
/** Marks the transaction of Focus's own writes, which never wake it. */
const focusWrite = createContextNamespace("focus.write", false);
const statusText = (line: unknown) => (Value.Check(agentStatusLineSchema, line) ? line.text : null);

/**
 * Focus arranges a person's task list while they have `tasks.focus` on: one long-running subtask
 * of Happy per person, briefed with the whole list when something on it changes, whose only tool
 * is `organize_tasks`. Rows the person moved or hid stay theirs until the task's status changes.
 */
export class FocusModule implements AgentModule {
    readonly name = "focus";
    readonly migrations = store.focusMigrations;
    readonly #config: ConfigModule;
    readonly #durable: DurableFunctionsModule;
    readonly #richTasks: RichTasksModule;
    readonly #tasks: TasksModule;
    readonly #bots: BotsModule;
    readonly #subtasks: SubtasksModule;
    /** Each person's Focus agent, by person. */
    readonly #focus = new Map<string, string>();
    /** Focus agents in the middle of a turn; their notices wait for it to end. */
    readonly #busy = new Set<string>();
    readonly #pending = new Map<string, { changes: string[]; timer: NodeJS.Timeout | undefined }>();
    #agents: AgentSystemRef | undefined;
    #ctx: Context | undefined;

    constructor(
        config: ConfigModule,
        durable: DurableFunctionsModule,
        richTasks: RichTasksModule,
        tasks: TasksModule,
        bots: BotsModule,
        subtasks: SubtasksModule,
        settings: UserSettingsModule,
    ) {
        this.#config = config;
        this.#durable = durable;
        this.#richTasks = richTasks;
        this.#tasks = tasks;
        this.#bots = bots;
        this.#subtasks = subtasks;
        durable.register({
            name: BRIEF_FUNCTION,
            argumentsSchema: Type.Object({
                memberId: Type.String(),
                changes: Type.Array(Type.String()),
            }),
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#brief(ctx, call.arguments.memberId, call.arguments.changes, call.kv);
                return null;
            },
        });
        settings.onEventTransactional(async (ctx, { owner, setting }) => {
            if (setting.key !== TASK_FOCUS_SETTING) return;
            if (setting.value === true)
                await this.#invokeBrief(ctx, owner, ["Focus was turned on."]);
            else afterCommit(ctx, async () => await this.#stop(owner));
        });
        tasks.onEventTransactional(async (ctx, event) => {
            if (event.type === "task_joined") {
                const { memberId, taskId } = event.membership;
                this.#notice(ctx, memberId, `${taskId} is new in the list`);
            } else if (event.type === "task_updated") {
                if (event.task.status === "archived" && event.previousTask.status !== "archived")
                    await this.noticeTask(ctx, event.task.id, `${event.task.name} was archived`);
            } else if (focusWrite.get(ctx)) {
                // Focus's own arrangement: nothing new for Focus to read.
            } else if (event.type === "task_sections_updated") {
                this.#notice(ctx, event.memberId, "the person changed their sections");
            } else if (
                event.type === "task_reordered" ||
                (event.type === "task_membership_updated" &&
                    event.membership.hidden !== event.previousMembership.hidden)
            ) {
                const { memberId, taskId, hidden } = event.membership;
                await store.holdTask(ctx, memberId, taskId);
                const what = event.type === "task_reordered" ? "moved" : hidden ? "hid" : "showed";
                this.#notice(ctx, memberId, `the person ${what} ${taskId}, which is now held`);
            }
        });
    }

    readonly beforeStart = async (
        ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Focus requires the agent database.");
        this.#agents = agents;
        this.#ctx = withAgentDatabase(detach(ctx).named("focus"), database);
        for (const { memberId, agentId } of await store.readFocusAgents(ctx))
            this.#focus.set(memberId, agentId);
        return {
            overrideInstructions: (_hookCtx, scope, input) =>
                this.#memberOf(scope.agent.id) === undefined
                    ? input.instructions
                    : FOCUS_INSTRUCTIONS,
            overrideTools: (_hookCtx, scope, input) => {
                const memberId = this.#memberOf(scope.agent.id);
                return memberId === undefined ? input.tools : [organizeTasksTool(this, memberId)];
            },
            beforeAgentLoop: (_hookCtx, scope) => {
                if (this.#memberOf(scope.agent.id) !== undefined) this.#busy.add(scope.agent.id);
            },
            afterAgentSettled: (_hookCtx, scope) => {
                const memberId = this.#memberOf(scope.agent.id);
                if (
                    this.#busy.delete(scope.agent.id) &&
                    this.#pending.get(memberId!)?.timer === undefined
                )
                    void this.#flush(memberId!);
            },
            metadataChangedTransact: async (
                hookCtx,
                _scope,
                { agentId, previousMetadata, metadata },
            ) => {
                const line = statusText(metadata["statusLine"]);
                const moved = line !== statusText(previousMetadata["statusLine"]);
                const question = metadata["pendingQuestionId"];
                const asks =
                    typeof question === "string" &&
                    question !== previousMetadata["pendingQuestionId"];
                const task =
                    moved || asks ? await this.#tasks.forAgent(hookCtx, agentId) : undefined;
                if (task === undefined) return;
                // Where the work stands changed, so Focus may place the task again.
                if (moved) await store.releaseTask(hookCtx, task.id);
                if (moved)
                    await this.noticeTask(
                        hookCtx,
                        task.id,
                        `${task.name} status: ${JSON.stringify(line)}`,
                    );
                if (asks)
                    await this.noticeTask(
                        hookCtx,
                        task.id,
                        `${task.name} asks the person a question`,
                    );
            },
            messageAcceptedTransact: async (hookCtx, scope, accepted) => {
                const first = (await scope.kv.read(hookCtx, "messaged")) === undefined;
                if (first) await scope.kv.write(hookCtx, "messaged", true);
                if (!first && !isUserOriginMetadata(accepted.metadata)) return;
                const task = await this.#tasks.forAgent(hookCtx, scope.agent.id);
                const what = first ? "got its first message" : "has a new message from a person";
                if (task !== undefined)
                    await this.noticeTask(hookCtx, task.id, `${task.name} ${what}`);
            },
        };
    };

    /**
     * Apply Focus's operations to its person's list in one transaction. An operation on a row the
     * person holds, on something missing, or on a bot is skipped.
     */
    async organize(
        ctx: Context,
        memberId: string,
        ops: readonly FocusOp[],
    ): Promise<OrganizeTasksResult> {
        if (!(await this.#richTasks.isOn(ctx, memberId, TASK_FOCUS_SETTING)))
            return { error: "off" };
        return await focusWrite.set(ctx, true).inTx(async (tx) => {
            const held = await store.readHeldTasks(tx, memberId);
            const skipped: { index: number; reason: FocusSkipReason }[] = [];
            for (const [index, op] of ops.entries()) {
                const reason = await this.#apply(tx, memberId, op, held);
                if (reason !== undefined) skipped.push({ index, reason });
            }
            return { applied: ops.length - skipped.length, skipped };
        });
    }

    /**
     * Tell every person with Focus whose list holds the task, or only `only`, once this
     * transaction commits. Other modules call it for news Focus should weigh, such as a story.
     */
    async noticeTask(ctx: Context, taskId: string, change: string, only?: string): Promise<void> {
        for (const memberId of this.#focus.keys()) {
            if (only !== undefined && memberId !== only) continue;
            if ((await this.#tasks.membership(ctx, taskId, memberId)) !== undefined)
                this.#notice(ctx, memberId, change);
        }
    }

    async #apply(
        ctx: Context,
        memberId: string,
        op: FocusOp,
        held: ReadonlySet<string>,
    ): Promise<FocusSkipReason | undefined> {
        // Bots stay in their own section: Focus only hides or shows one the person left to it.
        if ("botId" in op) {
            if ((await this.#bots.get(ctx, op.botId)) === undefined) return "not_found";
            if ((await this.#bots.membership(ctx, op.botId, memberId)).held)
                return "held_by_person";
            await this.#bots.updateMembership(ctx, op.botId, memberId, { hidden: op.hidden });
            return undefined;
        }
        if ((await this.#bots.get(ctx, op.taskId)) !== undefined) return "bots_not_allowed";
        if ((await this.#tasks.membership(ctx, op.taskId, memberId)) === undefined)
            return "not_found";
        if (held.has(op.taskId)) return "held_by_person";
        try {
            if (op.op === "hide") await this.#tasks.setHidden(ctx, op.taskId, memberId, op.hidden);
            else {
                const after =
                    op.after === null || "sectionId" in op.after ? op.after : op.after.taskId;
                await this.#tasks.reorder(ctx, op.taskId, memberId, after);
            }
        } catch (error: unknown) {
            if (error instanceof TaskConflictError || error instanceof TaskNotFoundError)
                return "not_found";
            throw error;
        }
        return undefined;
    }

    /** Collect a change for the person's next brief, once the transaction that made it commits. */
    #notice(ctx: Context, memberId: string, change: string): void {
        if (!this.#focus.has(memberId)) return;
        afterCommit(ctx, () => {
            const pending = this.#pending.get(memberId) ?? { changes: [], timer: undefined };
            this.#pending.set(memberId, pending);
            pending.changes.push(change);
            pending.timer ??= setTimeout(() => void this.#flush(memberId), BURST_MS);
        });
    }

    async #flush(memberId: string): Promise<void> {
        const pending = this.#pending.get(memberId);
        if (pending === undefined) return;
        pending.timer = undefined;
        // A Focus mid-turn is briefed when that turn ends.
        if (this.#busy.has(this.#focus.get(memberId)!)) return;
        this.#pending.delete(memberId);
        const ctx = this.#context();
        await this.#invokeBrief(ctx, memberId, [...new Set(pending.changes)]).catch(
            (error: unknown) => ctx.log.error("Focus could not be briefed.", { memberId }, error),
        );
    }

    async #invokeBrief(ctx: Context, memberId: string, changes: string[]): Promise<void> {
        const args = { memberId, changes };
        await this.#durable.invoke(ctx, {
            function: BRIEF_FUNCTION,
            arguments: args,
            lockKeys: [`focus:${memberId}`],
        });
    }

    /** Send the person's Focus its brief, first creating Focus when they have none. */
    async #brief(
        ctx: Context,
        memberId: string,
        changes: readonly string[],
        kv: AgentKV,
    ): Promise<void> {
        if (!(await this.#richTasks.isOn(ctx, memberId, TASK_FOCUS_SETTING))) return;
        const agents = this.#requireAgents();
        const text = await this.#formatBrief(ctx, memberId, changes);
        const current = this.#focus.get(memberId);
        const config = current === undefined ? undefined : await agents.config(ctx, current);
        if (
            current !== undefined &&
            config !== undefined &&
            typeof config.metadata?.["archivedAt"] !== "number"
        ) {
            const id = await kv.getOrCreate(ctx, "message", () => createId());
            const message = { role: "user" as const, content: [{ type: "text" as const, text }] };
            await agents.send(ctx, current, message, {
                id,
                metadata: { ...AGENT_MESSAGE_ORIGIN_METADATA },
            });
            return;
        }
        // A person without Focus, or whose Focus was archived, gets a new one on the default model.
        const happy = await this.#bots.chiefOfStaff(ctx);
        const model = this.#config.models[0];
        if (happy === undefined || model === undefined) return;
        const agentId = await kv.getOrCreate(ctx, "agent", () => createId());
        const effort = model.defaultEffort as CreateSubtaskInput["effort"];
        const input = { title: "Focus", text, provider: model.providerId, model: model.id, effort };
        await ctx.inTx(async (tx) => {
            await store.saveFocusAgent(tx, memberId, agentId);
            // Its opening turn may start before this transaction's other callbacks run.
            this.#focus.set(memberId, agentId);
            // Happy hears nothing from Focus; its work shows in the person's list.
            await this.#subtasks.create(tx, happy.agentId, input, agentId, undefined, undefined, {
                unreported: true,
            });
        });
    }

    /** The whole list, top first, with short facts per task, then what changed since the last brief. */
    async #formatBrief(
        ctx: Context,
        memberId: string,
        changes: readonly string[],
    ): Promise<string> {
        const held = await store.readHeldTasks(ctx, memberId);
        // Focus files tasks under the person's sections only while they have sections on.
        const sections = (await this.#richTasks.isOn(ctx, memberId, TASK_SECTIONS_SETTING))
            ? await this.#tasks.sections(ctx, memberId)
            : [];
        const rows = sections.map(({ id, name, orderKey }) => ({
            orderKey,
            line: `## ${name} (section ${id})`,
        }));
        for (const { task, membership } of await this.#tasks.listForMember(ctx, memberId)) {
            const metadata =
                (await this.#requireAgents().config(ctx, task.agentId))?.metadata ?? {};
            const facts = [
                `- ${task.name} (${task.id})`,
                statusText(metadata["statusLine"]),
                typeof metadata["pendingQuestionId"] === "string"
                    ? "asks the person a question"
                    : null,
                membership.unread === undefined ? null : "unread",
                membership.hidden === true ? "hidden" : null,
                held.has(task.id) ? "held by the person" : null,
                task.status === "archived" ? "archived" : null,
            ];
            const line = facts.filter((fact) => fact !== null).join(" · ");
            rows.push({ orderKey: membership.orderKey, line });
        }
        rows.sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
        const bots: string[] = [];
        for (const bot of await this.#bots.list(ctx)) {
            if (bot.status !== "active") continue;
            const { hidden, held, unread } = await this.#bots.membership(ctx, bot.id, memberId);
            const facts = [
                `- ${bot.name} (bot ${bot.id})`,
                unread === undefined ? null : "unread",
                hidden ? "hidden" : null,
                held ? "held by the person" : null,
            ];
            bots.push(facts.filter((fact) => fact !== null).join(" · "));
        }
        return [
            "The person's bots, in their own section at the top:",
            ...(bots.length === 0 ? ["(none)"] : bots),
            "",
            "The person's list, top first:",
            ...(rows.length === 0 ? ["(empty)"] : rows.map(({ line }) => line)),
            "",
            "Changed since your last brief:",
            ...changes.map((change) => `- ${change}`),
        ].join("\n");
    }

    /** Turning Focus off stops it; the arrangement it made stays, and it resumes when turned on. */
    async #stop(memberId: string): Promise<void> {
        clearTimeout(this.#pending.get(memberId)?.timer);
        this.#pending.delete(memberId);
        const agentId = this.#focus.get(memberId);
        if (agentId !== undefined && this.#busy.has(agentId))
            await this.#requireAgents().abort(this.#context(), agentId);
    }

    #memberOf(agentId: string): string | undefined {
        for (const [memberId, focusId] of this.#focus) if (focusId === agentId) return memberId;
        return undefined;
    }

    #context(): Context {
        if (this.#ctx === undefined) throw new Error("Focus has not started.");
        return this.#ctx;
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("Focus has not started.");
        return this.#agents;
    }
}
