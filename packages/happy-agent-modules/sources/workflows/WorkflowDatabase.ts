import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_PAGE_SIZE,
    isWorkflowTerminalStatus,
    workflowLaunchRequestSchema,
    type WorkflowLaunchRequest,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
} from "./Workflow.js";
import { assertWorkflowLogPage, assertWorkflowPage, assertWorkflowRun } from "./WorkflowStore.js";

export const WORKFLOW_RUNS_TABLE = "happy_agent_module_workflow_runs";
export const WORKFLOW_LOGS_TABLE = "happy_agent_module_workflow_logs";
export const WORKFLOW_RECEIPTS_TABLE = "happy_agent_module_workflow_receipts";
export const WORKFLOW_PROOFS_TABLE = "happy_agent_module_workflow_proofs";
export const WORKFLOW_CHECKPOINTS_TABLE = "happy_agent_module_workflow_checkpoints";
export const WORKFLOW_AGENT_CALLS_TABLE = "happy_agent_module_workflow_agent_calls";
export const WORKFLOW_LAUNCHES_TABLE = "happy_agent_module_workflow_launches";
export const WORKFLOWS_MIGRATION_KEY = "001-workflows-runs";

type JsonRow = { readonly value_json: string };
type CountRow = { readonly count: number | string };
type LogRow = { readonly position: number | string; readonly text: string };
type CheckpointRow = {
    readonly snapshot: Uint8Array | Buffer;
    readonly next_call_index: number | string;
    readonly phase: string;
};
type AgentCallRow = {
    readonly run_id: string;
    readonly call_index: number | string;
    readonly collaborator_id: string;
    readonly signature: string;
    readonly output_json: string | null;
    readonly error: string | null;
};

/** Where a script's own execution was suspended, so a later run continues instead of restarting. */
export interface WorkflowCheckpoint {
    readonly snapshot: Uint8Array;
    readonly nextAgentCallIndex: number;
    readonly phase: string;
}

/** What one `agent()` call in a script produced, kept so a resumed run does not pay for it twice. */
export interface WorkflowAgentCall {
    readonly runId: string;
    readonly callIndex: number;
    /** The durable agent identity that owns this call, including while it is still working. */
    readonly collaboratorId: string;
    /** What was asked, so a changed prompt or model is re-run rather than silently reused. */
    readonly signature: string;
    readonly output?: unknown;
    readonly error?: string;
}

/** The one run with this identity, or nothing when this agent never started it. */
export async function readWorkflowRun(
    ctx: Context,
    agentId: string,
    id: string,
): Promise<WorkflowRun | undefined> {
    const row = (
        await agentDatabaseRows<JsonRow>(
            ctx.db,
            sql`SELECT run_json AS value_json
                FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
                WHERE agent_id = ${agentId} AND id = ${id}
                LIMIT 1`,
        )
    )[0];
    return row === undefined ? undefined : decodeRun(row);
}

/** Write a run, whether or not it is already there. */
export async function writeWorkflowRun(ctx: Context, run: WorkflowRun): Promise<void> {
    assertWorkflowRun(run);
    const encoded = JSON.stringify(run);
    if ((await readWorkflowRun(ctx, run.agentId, run.id)) !== undefined) {
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(WORKFLOW_RUNS_TABLE)}
                SET workflow = ${run.workflow}, status = ${run.status},
                    created_at = ${run.createdAt}, updated_at = ${run.updatedAt},
                    run_json = ${encoded}
                WHERE agent_id = ${run.agentId} AND id = ${run.id}`,
        );
        return;
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(WORKFLOW_RUNS_TABLE)}
            (agent_id, id, workflow, status, created_at, updated_at, run_json)
            VALUES (
                ${run.agentId}, ${run.id}, ${run.workflow}, ${run.status},
                ${run.createdAt}, ${run.updatedAt}, ${encoded}
            )`,
    );
}

/** One page of an agent's runs, counted and offset in SQL rather than in memory. */
export async function readWorkflowPage(
    ctx: Context,
    agentId: string,
    query: WorkflowPageQuery,
): Promise<WorkflowPage> {
    const limit = Math.min(query.limit ?? MAX_WORKFLOW_PAGE_SIZE, MAX_WORKFLOW_PAGE_SIZE);
    const terminalPredicate =
        query.includeTerminal === false
            ? sql`AND status NOT IN ('completed', 'failed', 'cancelled')`
            : sql``;
    const countRows = await agentDatabaseRows<CountRow>(
        ctx.db,
        sql`SELECT COUNT(*) AS count
            FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
            WHERE agent_id = ${agentId} ${terminalPredicate}`,
    );
    const total = Number(countRows[0]?.count ?? 0);
    const cursor = offsetFor(
        query.from,
        "cursor" in query ? query.cursor : undefined,
        total,
        limit,
    );
    const rows = await agentDatabaseRows<JsonRow>(
        ctx.db,
        sql`SELECT run_json AS value_json
            FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
            WHERE agent_id = ${agentId} ${terminalPredicate}
            ORDER BY id
            LIMIT ${limit} OFFSET ${cursor}`,
    );
    const runs = rows.map(decodeRun);
    const page: WorkflowPage = {
        agentId,
        cursor,
        runs,
        totalRuns: total,
        ...(cursor > 0 ? { previousCursor: Math.max(0, cursor - limit) } : {}),
        ...(cursor + runs.length < total ? { nextCursor: cursor + runs.length } : {}),
    };
    assertWorkflowPage(page);
    return page;
}

/** Add progress notes to a run's log, in the order the script produced them. */
export async function appendWorkflowLogs(
    ctx: Context,
    agentId: string,
    runId: string,
    lines: readonly string[],
): Promise<void> {
    if (lines.length === 0) return;
    const countRows = await agentDatabaseRows<CountRow>(
        ctx.db,
        sql`SELECT COUNT(*) AS count
            FROM ${sql.raw(WORKFLOW_LOGS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${runId}`,
    );
    let position = Number(countRows[0]?.count ?? 0);
    for (const line of lines) {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(WORKFLOW_LOGS_TABLE)} (agent_id, run_id, position, text)
                VALUES (${agentId}, ${runId}, ${position}, ${line})`,
        );
        position += 1;
    }
}

/** One page of a run's progress notes. */
export async function readWorkflowLogPage(
    ctx: Context,
    agentId: string,
    query: WorkflowLogQuery,
): Promise<WorkflowLogPage> {
    const countRows = await agentDatabaseRows<CountRow>(
        ctx.db,
        sql`SELECT COUNT(*) AS count
            FROM ${sql.raw(WORKFLOW_LOGS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${query.id}`,
    );
    const totalLines = Number(countRows[0]?.count ?? 0);
    const limit = Math.min(query.limit ?? MAX_WORKFLOW_LOG_LINES, MAX_WORKFLOW_LOG_LINES);
    const cursor = offsetFor(
        query.from,
        "cursor" in query ? query.cursor : undefined,
        totalLines,
        limit,
    );
    const rawLines = await agentDatabaseRows<LogRow>(
        ctx.db,
        sql`SELECT position, text
            FROM ${sql.raw(WORKFLOW_LOGS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${query.id}
            ORDER BY position
            LIMIT ${limit} OFFSET ${cursor}`,
    );
    const lines = rawLines.map((line) => ({ position: Number(line.position), text: line.text }));
    const page: WorkflowLogPage = {
        agentId,
        id: query.id,
        cursor,
        lines,
        totalLines,
        ...(cursor > 0 ? { previousCursor: Math.max(0, cursor - limit) } : {}),
        ...(cursor + lines.length < totalLines ? { nextCursor: cursor + lines.length } : {}),
    };
    assertWorkflowLogPage(page);
    return page;
}

/** Keep where a script suspended itself. Only the latest one matters, so it replaces the last. */
export async function writeWorkflowCheckpoint(
    ctx: Context,
    agentId: string,
    runId: string,
    checkpoint: WorkflowCheckpoint,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(WORKFLOW_CHECKPOINTS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${runId}`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(WORKFLOW_CHECKPOINTS_TABLE)}
            (agent_id, run_id, snapshot, next_call_index, phase)
            VALUES (
                ${agentId}, ${runId}, ${Buffer.from(checkpoint.snapshot)},
                ${checkpoint.nextAgentCallIndex}, ${checkpoint.phase}
            )`,
    );
}

/** Where a run suspended, or nothing when it never reached its first agent call. */
export async function readWorkflowCheckpoint(
    ctx: Context,
    agentId: string,
    runId: string,
): Promise<WorkflowCheckpoint | undefined> {
    const row = (
        await agentDatabaseRows<CheckpointRow>(
            ctx.db,
            sql`SELECT snapshot, next_call_index, phase
                FROM ${sql.raw(WORKFLOW_CHECKPOINTS_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${runId}
                LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    return {
        snapshot: new Uint8Array(row.snapshot),
        nextAgentCallIndex: Number(row.next_call_index),
        phase: row.phase,
    };
}

/** Keep what a run was launched with, so continuing it needs nothing said again. */
export async function writeWorkflowLaunch(
    ctx: Context,
    agentId: string,
    request: WorkflowLaunchRequest,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(WORKFLOW_LAUNCHES_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${request.id}`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(WORKFLOW_LAUNCHES_TABLE)} (agent_id, run_id, launch_json)
            VALUES (${agentId}, ${request.id}, ${JSON.stringify(request)})`,
    );
}

/** What a run was launched with, or nothing when its script is no longer stored. */
export async function readWorkflowLaunch(
    ctx: Context,
    agentId: string,
    runId: string,
): Promise<WorkflowLaunchRequest | undefined> {
    const row = (
        await agentDatabaseRows<JsonRow>(
            ctx.db,
            sql`SELECT launch_json AS value_json
                FROM ${sql.raw(WORKFLOW_LAUNCHES_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${runId}
                LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.value_json);
    } catch {
        throw new Error("A stored workflow launch is not valid JSON.");
    }
    if (!Value.Check(workflowLaunchRequestSchema, parsed)) {
        throw new Error("A stored workflow launch is not a valid launch.");
    }
    return structuredClone(parsed);
}

/**
 * Record one agent call and the collaborator that is answering it. The collaborator's identity is
 * how a settlement finds its way back to the call that is waiting for it.
 */
export async function writeWorkflowAgentCall(
    ctx: Context,
    agentId: string,
    call: {
        readonly runId: string;
        readonly callIndex: number;
        readonly collaboratorId: string;
        readonly signature: string;
    },
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${call.runId} AND call_index = ${call.callIndex}`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            (agent_id, run_id, call_index, collaborator_id, signature, output_json, error)
            VALUES (
                ${agentId}, ${call.runId}, ${call.callIndex}, ${call.collaboratorId},
                ${call.signature}, NULL, NULL
            )`,
    );
}

/**
 * Keep what the call finally produced, which is not always what the agent said: a call asking for
 * JSON stores the parsed value, and that is what a resumed run reuses.
 */
export async function writeWorkflowAgentCallOutput(
    ctx: Context,
    agentId: string,
    runId: string,
    callIndex: number,
    result: { readonly signature: string; readonly output: unknown },
): Promise<void> {
    const encoded = JSON.stringify(result.output) ?? null;
    const existing = await agentDatabaseRows<{ readonly call_index: number }>(
        ctx.db,
        sql`SELECT call_index
            FROM ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${runId} AND call_index = ${callIndex}
            LIMIT 1`,
    );
    if (existing.length > 0) {
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
                SET signature = ${result.signature}, output_json = ${encoded}, error = NULL
                WHERE agent_id = ${agentId} AND run_id = ${runId} AND call_index = ${callIndex}`,
        );
        return;
    }
    // A call whose answer came from an earlier run was never started here, so there is no row to
    // update — but the result is still what this run would reuse if it had to continue.
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            (agent_id, run_id, call_index, collaborator_id, signature, output_json, error)
            VALUES (
                ${agentId}, ${runId}, ${callIndex}, ${`${runId}:${String(callIndex)}`},
                ${result.signature}, ${encoded}, NULL
            )`,
    );
}

/** Note what a collaborator answered, against the call it was started for. */
export async function completeWorkflowAgentCall(
    ctx: Context,
    collaboratorId: string,
    result: { readonly output?: unknown; readonly error?: string },
): Promise<WorkflowAgentCall | undefined> {
    const row = (
        await agentDatabaseRows<AgentCallRow & { readonly agent_id: string }>(
            ctx.db,
            sql`SELECT agent_id, run_id, call_index, collaborator_id, signature, output_json, error
                FROM ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
                WHERE collaborator_id = ${collaboratorId}
                LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    await agentDatabaseRun(
        ctx.db,
        sql`UPDATE ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            SET output_json = ${result.output === undefined ? null : JSON.stringify(result.output)},
                error = ${result.error ?? null}
            WHERE collaborator_id = ${collaboratorId}`,
    );
    return {
        runId: row.run_id,
        callIndex: Number(row.call_index),
        collaboratorId,
        signature: row.signature,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error === undefined ? {} : { error: result.error }),
    };
}

/**
 * One exact call, including an unanswered one whose restored collaborator is still working.
 *
 * Reading this after registering an in-memory waiter closes the startup race where the agent
 * settles between the recovery pass finding the run and its script reaching the external call.
 */
export async function readWorkflowAgentCall(
    ctx: Context,
    agentId: string,
    runId: string,
    callIndex: number,
): Promise<WorkflowAgentCall | undefined> {
    const row = (
        await agentDatabaseRows<AgentCallRow>(
            ctx.db,
            sql`SELECT run_id, call_index, collaborator_id, signature, output_json, error
                FROM ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
                WHERE agent_id = ${agentId} AND run_id = ${runId} AND call_index = ${callIndex}
                LIMIT 1`,
        )
    )[0];
    return row === undefined ? undefined : decodeAgentCall(row);
}

/** Everything a resumed run may reuse, in the order the script asked for it. */
export async function readWorkflowAgentCalls(
    ctx: Context,
    agentId: string,
    runId: string,
): Promise<readonly (WorkflowAgentCall | undefined)[]> {
    const rows = await agentDatabaseRows<AgentCallRow>(
        ctx.db,
        sql`SELECT run_id, call_index, collaborator_id, signature, output_json, error
            FROM ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${runId}
            ORDER BY call_index`,
    );
    const calls: (WorkflowAgentCall | undefined)[] = [];
    for (const row of rows) {
        // A call that never got an answer is not a reusable result, so the slot stays empty and
        // the resumed script asks again.
        if (row.output_json === null) continue;
        let output: unknown;
        try {
            output = JSON.parse(row.output_json);
        } catch {
            continue;
        }
        calls[Number(row.call_index)] = {
            runId: row.run_id,
            callIndex: Number(row.call_index),
            collaboratorId: row.collaborator_id,
            signature: row.signature,
            output,
        };
    }
    return calls;
}

/**
 * The collaborators this run started that have not answered yet, which are the ones still
 * spending. A cancelled run has no use for their answers, so they are what a cancel has to stop.
 */
export async function readUnansweredWorkflowCollaborators(
    ctx: Context,
    agentId: string,
    runId: string,
): Promise<readonly string[]> {
    const rows = await agentDatabaseRows<{ readonly collaborator_id: string }>(
        ctx.db,
        sql`SELECT collaborator_id
            FROM ${sql.raw(WORKFLOW_AGENT_CALLS_TABLE)}
            WHERE agent_id = ${agentId} AND run_id = ${runId}
                AND output_json IS NULL AND error IS NULL
            ORDER BY call_index`,
    );
    return rows.map((row) => row.collaborator_id);
}

/** Durable running scripts this process must recover during module startup. */
export async function readUnfinishedWorkflowRuns(ctx: Context): Promise<readonly WorkflowRun[]> {
    const rows = await agentDatabaseRows<JsonRow>(
        ctx.db,
        sql`SELECT run_json AS value_json
            FROM ${sql.raw(WORKFLOW_RUNS_TABLE)}
            WHERE status = 'running'
            ORDER BY agent_id, id`,
    );
    return rows.map(decodeRun).filter((run) => !isWorkflowTerminalStatus(run.status));
}

function decodeAgentCall(row: AgentCallRow): WorkflowAgentCall {
    let output: unknown;
    if (row.output_json !== null) {
        try {
            output = JSON.parse(row.output_json);
        } catch {
            throw new Error("A stored workflow agent result is not valid JSON.");
        }
    }
    return {
        runId: row.run_id,
        callIndex: Number(row.call_index),
        collaboratorId: row.collaborator_id,
        signature: row.signature,
        ...(row.output_json === null ? {} : { output }),
        ...(row.error === null ? {} : { error: row.error }),
    };
}

function decodeRun(row: JsonRow): WorkflowRun {
    let parsed: unknown;
    try {
        parsed = JSON.parse(row.value_json);
    } catch {
        throw new Error("A stored workflow run is not valid JSON.");
    }
    assertWorkflowRun(parsed);
    return structuredClone(parsed);
}

/** Where a page starts: from the end, from an explicit cursor, or from the beginning. */
function offsetFor(
    from: "start" | "end" | undefined,
    cursor: number | undefined,
    total: number,
    limit: number,
): number {
    const requested = from === "end" ? Math.max(0, total - limit) : (cursor ?? 0);
    return Math.max(0, Math.min(requested, total));
}
