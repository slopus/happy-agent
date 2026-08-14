import {
    agentKV,
    type AgentFeature,
    type AgentFeatureScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    MAX_WORKFLOW_ID_LENGTH,
    workflowAgentIdSchema,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_PAGE_SIZE,
    workflowIdSchema,
    workflowLaunchInputSchema,
    workflowLaunchToolInputSchema,
    workflowLogQuerySchema,
    workflowMutationInputSchema,
    workflowMutationToolInputSchema,
    workflowPageQuerySchema,
    workflowOperationFingerprintSchema,
    workflowOperationReceiptSchema,
    workflowMutationResultSchema,
    workflowTimestampSchema,
    type WorkflowLaunchInput,
    type WorkflowAgentId,
    type WorkflowLaunchToolInput,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowMutationInput,
    type WorkflowMutationResult,
    type WorkflowMutationToolInput,
    type WorkflowOperationReceipt,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
} from "./Workflow.js";
import {
    workflowEventIdSchema,
    workflowEventSchema,
    workflowFeatureListenerSchema,
    type WorkflowEvent,
} from "./WorkflowEvent.js";
import {
    assertWorkflowLogPage,
    assertWorkflowMutationResult,
    assertWorkflowPage,
    assertWorkflowRun,
    assertWorkflowTransactionChange,
    workflowStoreSchema,
    type WorkflowStore,
} from "./WorkflowStore.js";
import { listWorkflowsTool } from "./tools/list_workflows.js";
import { runWorkflowTool } from "./tools/run_workflow.js";
import { resumeWorkflowTool } from "./tools/resume_workflow.js";
import { stopWorkflowTool } from "./tools/stop_workflow.js";
import { waitWorkflowTool } from "./tools/wait_workflow.js";
import { workflowLogsTool } from "./tools/workflow_logs.js";
import { workflowStatusTool } from "./tools/workflow_status.js";

const maxOutputSchema = Type.Integer({
    minimum: 256,
    maximum: MAX_WORKFLOW_OUTPUT_CHARACTERS,
});
const workflowFeatureOptionsSchema = Type.Object(
    {
        store: workflowStoreSchema,
        idFactory: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowAgentIdSchema,
                ],
                Type.Union([workflowIdSchema, Type.Promise(workflowIdSchema)]),
            ),
        ),
        eventIdFactory: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowAgentIdSchema,
                ],
                Type.Union([workflowEventIdSchema, Type.Promise(workflowEventIdSchema)]),
            ),
        ),
        clock: Type.Optional(Type.Function([], workflowTimestampSchema)),
        listener: Type.Optional(workflowFeatureListenerSchema),
        maxPageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_PAGE_SIZE })),
        maxLogLines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKFLOW_LOG_LINES })),
        maxOutputCharacters: Type.Optional(maxOutputSchema),
        onPostCommitError: Type.Optional(
            Type.Function(
                [
                    Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false })),
                    workflowEventSchema,
                    Type.Unknown(),
                ],
                Type.Union([Type.Void(), Type.Promise(Type.Void())]),
            ),
        ),
    },
    { additionalProperties: false },
);

export { workflowFeatureOptionsSchema };
export type WorkflowFeatureOptions = Static<typeof workflowFeatureOptionsSchema>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_LOG_LINES = 200;
const DEFAULT_MAX_OUTPUT = 12_000;
const LAUNCH_OPERATION_KEY = "workflow_launch_operation_id";
const CANCEL_OPERATION_KEY = "workflow_cancel_operation_id";
const RESUME_OPERATION_KEY = "workflow_resume_operation_id";
const MAX_WORKFLOW_CURSOR = 100_000;
const MAX_WORKFLOW_STATUS_TEXT_LENGTH = "unavailable".length;
const PAGE_CURSOR_SUFFIX = `\nMore runs start at cursor ${MAX_WORKFLOW_CURSOR}.`;
const LOG_CURSOR_SUFFIX = `\nMore logs start at cursor ${MAX_WORKFLOW_LOG_LINES}.`;

export class WorkflowsFeature implements AgentFeature {
    readonly name = "workflows";
    readonly #store: WorkflowStore;
    readonly #idFactory: NonNullable<WorkflowFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<WorkflowFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<WorkflowFeatureOptions["clock"]>;
    readonly #listener: WorkflowFeatureOptions["listener"];
    readonly #maxPageSize: number;
    readonly #maxLogLines: number;
    readonly #maxOutputCharacters: number;
    readonly #maxModelRows: number;
    readonly #maxModelLogLines: number;
    readonly #onPostCommitError: WorkflowFeatureOptions["onPostCommitError"];

    constructor(options: WorkflowFeatureOptions) {
        if (!Value.Check(workflowFeatureOptionsSchema, options)) {
            throw new Error("Workflow feature options are invalid.");
        }
        this.#store = options.store;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? Date.now;
        this.#listener = options.listener;
        this.#maxPageSize = options.maxPageSize ?? DEFAULT_PAGE_SIZE;
        this.#maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
        this.#maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT;
        const maxRunRowCharacters =
            MAX_WORKFLOW_ID_LENGTH +
            2 +
            MAX_WORKFLOW_NAME_LENGTH +
            2 +
            MAX_WORKFLOW_STATUS_TEXT_LENGTH +
            1;
        this.#maxModelRows = Math.max(
            1,
            Math.floor(
                (this.#maxOutputCharacters - PAGE_CURSOR_SUFFIX.length + 1) /
                    (maxRunRowCharacters + 1),
            ),
        );
        const maxLogHeaderCharacters = MAX_WORKFLOW_ID_LENGTH + 1;
        this.#maxModelLogLines = Math.max(
            1,
            Math.floor(
                (this.#maxOutputCharacters -
                    maxLogHeaderCharacters -
                    LOG_CURSOR_SUFFIX.length +
                    1) /
                    (MAX_WORKFLOW_LOG_LINE_LENGTH + 1),
            ),
        );
        this.#onPostCommitError = options.onPostCommitError;
        if (!Value.Check(workflowTimestampSchema, this.#clock())) {
            throw new Error("Workflow clock must return a non-negative integer.");
        }
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        runWorkflowTool(this, scope.agent.id),
        listWorkflowsTool(this, scope.agent.id),
        workflowStatusTool(this, scope.agent.id),
        stopWorkflowTool(this, scope.agent.id),
        resumeWorkflowTool(this, scope.agent.id),
        waitWorkflowTool(this, scope.agent.id),
        workflowLogsTool(this, scope.agent.id),
    ];

    async launch(ctx: Context, agentId: string, input: WorkflowLaunchInput): Promise<WorkflowRun> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLaunchInputSchema, input, "workflow launch");
        const normalizedInput = normalizeLaunchInput(input);
        const fingerprint = workflowOperationFingerprint(agentId, "launch", normalizedInput);
        const id = await this.#operationId(
            ctx,
            agentId,
            LAUNCH_OPERATION_KEY,
            fingerprint,
            normalizedInput.operationId,
        );
        const request = { ...normalizedInput, operationId: id };
        let expectedRun: WorkflowRun | undefined;
        let expectedChanged: boolean | undefined;
        let expectedEvent: WorkflowEvent | undefined;
        const change = await this.#store.transaction(ctx, agentId, async (txCtx) => {
            const existing = await this.#store.get(txCtx, agentId, id);
            if (existing !== undefined) {
                assertWorkflowRun(existing);
                assertRunId(existing, id, "Workflow store returned the wrong replay run.");
                assertRunOwner(
                    existing,
                    agentId,
                    "Workflow store returned a replay run for another agent.",
                );
                if (!sameLaunchRequest(existing, request)) {
                    throw new Error(`Workflow operation "${id}" was reused with different input.`);
                }
                expectedRun = structuredClone(existing);
                expectedChanged = false;
                return { agentId, operationId: id, run: existing, changed: false };
            }
            const eventId = await this.#newEventId(txCtx, agentId);
            const at = this.#now();
            const run = await this.#store.launch(txCtx, agentId, request);
            assertWorkflowRun(run);
            assertRunOwner(run, agentId, "Workflow runner returned a run for another agent.");
            assertLaunchResult(run, request);
            expectedRun = structuredClone(run);
            expectedChanged = true;
            const event = this.#event({ type: "workflow_started", agentId, run }, eventId, at);
            expectedEvent = event;
            await this.#notifyTransactional(txCtx, event);
            this.#registerPostCommit(txCtx, event);
            return { agentId, operationId: id, run, changed: true, event };
        });
        assertWorkflowTransactionChange(change);
        assertLaunchTransactionChangeIdentity(
            change,
            agentId,
            id,
            request,
            expectedRun,
            expectedChanged,
            expectedEvent,
        );
        return structuredClone(change.run);
    }

    async launchForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowLaunchToolInput,
    ): Promise<WorkflowRun> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLaunchToolInputSchema, input, "workflow launch tool");
        return await this.launch(ctx, agentId, input);
    }

    async get(ctx: Context, agentId: string, id: string): Promise<WorkflowRun | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const run = await this.#store.get(ctx, agentId, id);
        if (run === undefined) return undefined;
        assertWorkflowRun(run);
        if (run.id !== id) throw new Error("Workflow store returned the wrong run.");
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
        return structuredClone(run);
    }

    async status(ctx: Context, agentId: string, id: string): Promise<WorkflowRun | undefined> {
        return await this.get(ctx, agentId, id);
    }

    async listPage(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery = {},
    ): Promise<WorkflowPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowPageQuerySchema, query, "workflow page query");
        const requestedLimit = query.limit ?? this.#maxPageSize;
        if (requestedLimit > this.#maxPageSize) {
            throw new Error("Workflow page exceeds configured bound.");
        }
        const limit = Math.min(requestedLimit, this.#maxModelRows);
        const page = await this.#store.list(ctx, agentId, { ...query, limit });
        assertWorkflowPage(page);
        assertWorkflowPageOwner(page, agentId);
        if (page.runs.length > limit) throw new Error("Workflow store returned too many runs.");
        assertCursorProgress(page.nextCursor, query.cursor ?? 0, page.runs.length, "workflow");
        return structuredClone(this.#fitModelPage(page, query.cursor ?? 0));
    }

    async list(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery = {},
    ): Promise<readonly WorkflowRun[]> {
        return (await this.listPage(ctx, agentId, query)).runs;
    }

    async cancel(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationInputSchema, input, "workflow cancellation");
        const fingerprint = workflowOperationFingerprint(agentId, "cancel", input);
        const operationId = await this.#operationId(
            ctx,
            agentId,
            CANCEL_OPERATION_KEY,
            fingerprint,
            input.operationId,
        );
        return await this.#mutate(ctx, agentId, { ...input, operationId }, "cancel");
    }

    async stop(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> {
        return await this.cancel(ctx, agentId, input);
    }

    async cancelForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationToolInputSchema, input, "workflow cancellation tool");
        return await this.cancel(ctx, agentId, input);
    }

    async resume(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationInputSchema, input, "workflow resume");
        const fingerprint = workflowOperationFingerprint(agentId, "resume", input);
        const operationId = await this.#operationId(
            ctx,
            agentId,
            RESUME_OPERATION_KEY,
            fingerprint,
            input.operationId,
        );
        return await this.#mutate(ctx, agentId, { ...input, operationId }, "resume");
    }

    async resumeForTool(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationToolInput,
    ): Promise<WorkflowMutationResult> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowMutationToolInputSchema, input, "workflow resume tool");
        return await this.resume(ctx, agentId, input);
    }

    async wait(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const run = await this.#store.wait(ctx, agentId, id);
        assertWorkflowRun(run);
        if (run.id !== id) throw new Error("Workflow store returned the wrong run.");
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
        if (!isWorkflowTerminalStatus(run.status)) {
            throw new Error("Workflow wait returned before a terminal or unavailable status.");
        }
        return structuredClone(run);
    }

    async logs(ctx: Context, agentId: string, query: WorkflowLogQuery): Promise<WorkflowLogPage> {
        this.#assertAgentId(agentId);
        this.#assertInput(workflowLogQuerySchema, query, "workflow log query");
        const requestedLimit = Math.min(query.limit ?? this.#maxLogLines, this.#maxLogLines);
        const limit = Math.min(requestedLimit, this.#maxModelLogLines);
        const page = await this.#store.logs(ctx, agentId, { ...query, limit });
        assertWorkflowLogPage(page);
        if (page.id !== query.id || page.lines.length > limit || page.agentId !== agentId) {
            throw new Error("Workflow store returned logs outside the requested bound.");
        }
        assertCursorProgress(page.nextCursor, query.cursor ?? 0, page.lines.length, "workflow log");
        // Rendering is part of the feature boundary: a malformed adapter cannot hand a model
        // an unbounded page merely because its structured shape was valid.
        this.formatLogsForModel(page);
        return structuredClone(page);
    }

    formatPageForModel(page: WorkflowPage): string {
        assertWorkflowPage(page);
        if (page.nextCursor !== undefined && page.runs.length === 0) {
            throw new Error("Workflow page with a next cursor must expose a run.");
        }
        const lines = page.runs.map(formatRunRow);
        const text = lines.join("\n") || "No workflow runs.";
        const suffix =
            page.nextCursor === undefined ? "" : `\nMore runs start at cursor ${page.nextCursor}.`;
        const output = `${text}${suffix}`;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workflow page exceeded the model output bound.");
        }
        return output;
    }

    formatRunForModel(run: WorkflowRun): string {
        assertWorkflowRun(run);
        const identity = `${run.id}: ${run.workflow}`;
        const status = `status: ${run.status}`;
        if (identity.length > this.#maxOutputCharacters) {
            throw new Error("Workflow output budget is too small to expose the run identity.");
        }
        const pieces = [identity, status];
        for (const [label, value] of [
            ["output", run.output],
            ["error", run.error],
        ] as const) {
            if (value === undefined) continue;
            const prefix = `${label}: `;
            const used = pieces.join("\n").length;
            const available = this.#maxOutputCharacters - used - 1 - prefix.length;
            if (available <= 0) break;
            pieces.push(`${prefix}${value.slice(0, available)}`);
        }
        return pieces.join("\n");
    }

    formatLogsForModel(page: WorkflowLogPage): string {
        assertWorkflowLogPage(page);
        if (page.nextCursor !== undefined && page.lines.length === 0) {
            throw new Error("Workflow log page with a next cursor must expose a log line.");
        }
        const suffix =
            page.nextCursor === undefined ? "" : `\nMore logs start at cursor ${page.nextCursor}.`;
        const header = page.id;
        const fixedCharacters = header.length + (page.lines.length > 0 ? 1 : 0) + suffix.length;
        const available = this.#maxOutputCharacters - fixedCharacters;
        const lineBudget = Math.floor(
            (available - Math.max(0, page.lines.length - 1)) / Math.max(1, page.lines.length),
        );
        if (page.lines.length > 0 && lineBudget < 1) {
            throw new Error("Workflow logs exceeded the model output bound.");
        }
        const lines = page.lines.map((line) => {
            if (line.length <= lineBudget) return line;
            if (lineBudget === 1) return line.slice(0, 1);
            return `${line.slice(0, lineBudget - 1)}…`;
        });
        const output = [header, ...lines].join("\n") + suffix;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workflow logs exceeded the model output bound.");
        }
        return output;
    }

    async #mutate(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationInput,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        this.#assertInput(workflowMutationInputSchema, input, `workflow ${operation}`);
        const id = input.id;
        const operationId = input.operationId;
        if (operationId === undefined) {
            throw new Error("Workflow mutation operation ID is required.");
        }
        let expectedRun: WorkflowRun | undefined;
        let expectedChanged: boolean | undefined;
        let expectedEvent: WorkflowEvent | undefined;
        const change = await this.#store.transaction(ctx, agentId, async (txCtx) => {
            const current = await this.#store.get(txCtx, agentId, id);
            if (current !== undefined) {
                assertWorkflowRun(current);
                assertRunId(current, id, "Workflow store returned the wrong current run.");
                assertRunOwner(
                    current,
                    agentId,
                    "Workflow store returned a current run for another agent.",
                );
            }
            const mutation =
                operation === "cancel"
                    ? await this.#store.cancel(txCtx, agentId, input)
                    : await this.#store.resume(txCtx, agentId, input);
            assertWorkflowMutationResult(mutation);
            assertMutationOwner(mutation, agentId, id);
            if (mutation.operationId !== operationId) {
                throw new Error("Workflow operation returned the wrong operation ID.");
            }
            assertMutationResult(mutation.run, current, id, operation);
            expectedRun = structuredClone(mutation.run);
            expectedChanged = mutation.changed;
            if (!mutation.changed) {
                return { agentId, operationId, run: mutation.run, changed: false };
            }
            const eventId = await this.#newEventId(txCtx, agentId);
            const at = this.#now();
            const event = this.#event(
                {
                    type: operation === "cancel" ? "workflow_cancelled" : "workflow_updated",
                    agentId,
                    run: mutation.run,
                },
                eventId,
                at,
            );
            expectedEvent = event;
            await this.#notifyTransactional(txCtx, event);
            this.#registerPostCommit(txCtx, event);
            return { agentId, operationId, run: mutation.run, changed: true, event };
        });
        assertWorkflowTransactionChange(change);
        assertMutationTransactionChangeIdentity(
            change,
            agentId,
            operationId,
            expectedRun,
            expectedChanged,
            operation,
            expectedEvent,
        );
        const result = {
            agentId: change.agentId,
            operationId: change.operationId,
            run: change.run,
            changed: change.changed,
        };
        if (!Value.Check(workflowMutationResultSchema, result)) {
            throw new Error("Workflow mutation returned an invalid result.");
        }
        return structuredClone(result);
    }

    async #operationId(
        ctx: Context,
        agentId: string,
        key = LAUNCH_OPERATION_KEY,
        fingerprint = "",
        requested?: string,
    ): Promise<string> {
        this.#assertAgentId(agentId);
        if (requested !== undefined) {
            this.#assertId(requested);
            return requested;
        }
        const kv = agentKV(ctx);
        const scopedKey = `${key}:${agentId}`;
        if (kv !== undefined) {
            return await kv.transaction(ctx, async (scope, txCtx) => {
                const existing = await scope.read(txCtx, scopedKey);
                if (existing !== undefined) {
                    if (!Value.Check(workflowOperationReceiptSchema, existing)) {
                        throw new Error("Stored workflow operation receipt is invalid.");
                    }
                    const receipt = existing as WorkflowOperationReceipt;
                    if (receipt.fingerprint !== fingerprint) {
                        throw new Error(
                            `Workflow operation "${receipt.operationId}" was reused with different input or target.`,
                        );
                    }
                    return receipt.operationId;
                }
                const id = await this.#idFactory(txCtx, agentId);
                this.#assertId(id);
                await scope.write(txCtx, scopedKey, {
                    operationId: id,
                    fingerprint,
                } satisfies WorkflowOperationReceipt);
                return id;
            });
        }
        const id = await this.#idFactory(ctx, agentId);
        this.#assertId(id);
        return id;
    }

    async #newEventId(ctx: Context, agentId: string): Promise<string> {
        this.#assertAgentId(agentId);
        const id = await this.#eventIdFactory(ctx, agentId);
        if (!Value.Check(workflowEventIdSchema, id)) {
            throw new Error("Workflow event ID factory returned an invalid ID.");
        }
        return id;
    }

    #event(
        payload:
            | {
                  readonly type: "workflow_started";
                  readonly agentId: string;
                  readonly run: WorkflowRun;
              }
            | {
                  readonly type: "workflow_updated";
                  readonly agentId: string;
                  readonly run: WorkflowRun;
              }
            | {
                  readonly type: "workflow_cancelled";
                  readonly agentId: string;
                  readonly run: WorkflowRun;
              },
        eventId: string,
        at: number,
    ): WorkflowEvent {
        const event = { ...payload, eventId, at };
        if (!Value.Check(workflowEventSchema, event)) {
            throw new Error("Workflow feature created an invalid event.");
        }
        return deepFreeze(structuredClone(event));
    }

    async #notifyTransactional(ctx: Context, event: WorkflowEvent): Promise<void> {
        await this.#listener?.onEventTransactional?.(ctx, event);
    }

    #registerPostCommit(ctx: Context, event: WorkflowEvent): void {
        const returned: unknown = this.#store.afterCommit(ctx, (postCommitCtx) =>
            this.#notifyPostCommit(postCommitCtx, event),
        );
        if (returned !== undefined) {
            if (returned instanceof Promise) {
                void returned.catch(() => undefined);
            }
            throw new Error("Workflow store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: WorkflowEvent): Promise<void> {
        try {
            await this.#listener?.onEvent?.(ctx, event);
        } catch (error: unknown) {
            try {
                await this.#onPostCommitError?.(ctx, event, error);
            } catch {
                // Post-commit observers cannot turn a committed operation into a failure.
            }
        }
    }

    #now(): number {
        const at = this.#clock();
        if (!Value.Check(workflowTimestampSchema, at)) {
            throw new Error("Workflow clock must return a non-negative integer.");
        }
        return at;
    }

    #assertId(id: unknown): asserts id is string {
        if (!Value.Check(workflowIdSchema, id)) throw new Error("Workflow ID is invalid.");
    }

    #assertAgentId(agentId: unknown): asserts agentId is WorkflowAgentId {
        if (!Value.Check(workflowAgentIdSchema, agentId)) {
            throw new Error("Workflow agent ID is invalid.");
        }
    }

    #assertInput<T extends object>(
        schema: TSchema,
        input: unknown,
        label: string,
    ): asserts input is T {
        if (!Value.Check(schema, input)) throw new Error(`Workflow ${label} is invalid.`);
    }

    #fitModelPage(page: WorkflowPage, requestedCursor: number): WorkflowPage {
        if (this.#pageFitsModel(page)) return page;
        const visible: WorkflowRun[] = [];
        for (const run of page.runs) {
            const candidateRuns = [...visible, run];
            const candidate: WorkflowPage = {
                agentId: page.agentId,
                runs: candidateRuns,
                ...(page.nextCursor === undefined
                    ? {}
                    : { nextCursor: requestedCursor + candidateRuns.length }),
            };
            if (this.#pageFitsModel(candidate)) {
                return candidate;
            }
            visible.push(run);
        }
        throw new Error("Workflow output budget is too small to expose one run identity.");
    }

    #pageFitsModel(page: WorkflowPage): boolean {
        try {
            this.formatPageForModel(page);
            return true;
        } catch {
            return false;
        }
    }
}

function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
    }
    return value;
}

function normalizeWorkflowInput(input: string | undefined): string | undefined {
    return input === undefined ? undefined : input.replace(/\r\n?/g, "\n");
}

function normalizeLaunchInput(input: WorkflowLaunchInput): WorkflowLaunchInput {
    const normalizedInput = normalizeWorkflowInput(input.input);
    return {
        workflow: input.workflow,
        ...(normalizedInput === undefined ? {} : { input: normalizedInput }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    };
}

function workflowOperationFingerprint(
    agentId: string,
    operation: "launch" | "cancel" | "resume",
    input: WorkflowLaunchInput | WorkflowMutationInput,
): string {
    const { operationId: _operationId, ...request } = input;
    const payload =
        operation === "launch"
            ? { agentId, operation, input: request }
            : { agentId, operation, target: request };
    const encoded = JSON.stringify(canonicalizeFingerprint(payload));
    if (!Value.Check(workflowOperationFingerprintSchema, encoded)) {
        throw new Error("Workflow operation input exceeds the durable receipt bound.");
    }
    return encoded;
}

function canonicalizeFingerprint(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => canonicalizeFingerprint(item));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, item]) => [key, canonicalizeFingerprint(item)]),
        );
    }
    return value;
}

function sameLaunchRequest(run: WorkflowRun, request: WorkflowLaunchInput): boolean {
    return (
        run.id === request.operationId &&
        run.workflow === request.workflow &&
        run.input === request.input
    );
}

function assertRunOwner(run: WorkflowRun, agentId: string, message: string): void {
    if (run.agentId !== agentId) throw new Error(message);
}

function assertWorkflowPageOwner(page: WorkflowPage, agentId: string): void {
    if (page.agentId !== agentId) {
        throw new Error("Workflow store returned a page for another agent.");
    }
    for (const run of page.runs) {
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
    }
}

function assertMutationOwner(mutation: WorkflowMutationResult, agentId: string, id: string): void {
    if (mutation.agentId !== agentId) {
        throw new Error("Workflow store returned a mutation for another agent.");
    }
    assertRunOwner(
        mutation.run,
        agentId,
        "Workflow store returned a mutation run for another agent.",
    );
    if (mutation.run.id !== id) {
        throw new Error("Workflow store returned a mutation for the wrong run.");
    }
}

function assertRunId(run: WorkflowRun, id: string, message: string): void {
    if (run.id !== id) throw new Error(message);
}

function assertLaunchResult(run: WorkflowRun, request: WorkflowLaunchInput): void {
    if (!sameLaunchRequest(run, request)) {
        throw new Error("Workflow runner returned a run with the wrong identity or input.");
    }
}

function assertMutationResult(
    run: WorkflowRun,
    current: WorkflowRun | undefined,
    id: string,
    operation: "cancel" | "resume",
): void {
    const expectedStatus = operation === "cancel" ? "cancelled" : "running";
    if (run.id !== id || run.status !== expectedStatus) {
        throw new Error("Workflow operation returned the wrong identity or status.");
    }
    if (
        current !== undefined &&
        (run.agentId !== current.agentId ||
            run.workflow !== current.workflow ||
            run.input !== current.input ||
            run.output !== current.output ||
            run.error !== current.error ||
            run.createdAt !== current.createdAt)
    ) {
        throw new Error("Workflow operation returned a run with mismatched identity.");
    }
}

function assertLaunchTransactionChangeIdentity(
    change: {
        readonly agentId: string;
        readonly operationId: string;
        readonly run: WorkflowRun;
        readonly changed: boolean;
        readonly event?: WorkflowEvent;
    },
    agentId: string,
    operationId: string,
    request: WorkflowLaunchInput,
    expectedRun: WorkflowRun | undefined,
    expectedChanged: boolean | undefined,
    expectedEvent: WorkflowEvent | undefined,
): void {
    if (change.agentId !== agentId) {
        throw new Error("Workflow transaction returned a run for another agent.");
    }
    if (change.operationId !== operationId) {
        throw new Error("Workflow transaction returned the wrong operation ID.");
    }
    assertExpectedTransactionRun(change.run, expectedRun, "launch");
    assertLaunchResult(change.run, request);
    assertExpectedTransactionState(change, expectedChanged);
    assertExpectedTransactionEvent(change.event, expectedEvent, "launch");
}

function assertMutationTransactionChangeIdentity(
    change: {
        readonly agentId: string;
        readonly operationId: string;
        readonly run: WorkflowRun;
        readonly changed: boolean;
        readonly event?: WorkflowEvent;
    },
    agentId: string,
    operationId: string,
    expectedRun: WorkflowRun | undefined,
    expectedChanged: boolean | undefined,
    operation: "cancel" | "resume",
    expectedEvent: WorkflowEvent | undefined,
): void {
    if (change.agentId !== agentId) {
        throw new Error("Workflow transaction returned a run for another agent.");
    }
    if (change.operationId !== operationId) {
        throw new Error("Workflow transaction returned the wrong operation ID.");
    }
    const expectedStatus = operation === "cancel" ? "cancelled" : "running";
    if (change.run.status !== expectedStatus) {
        throw new Error("Workflow transaction returned the wrong target status.");
    }
    assertExpectedTransactionRun(change.run, expectedRun, operation);
    assertExpectedTransactionState(change, expectedChanged);
    assertExpectedTransactionEvent(change.event, expectedEvent, operation);
}

function assertExpectedTransactionRun(
    actual: WorkflowRun,
    expected: WorkflowRun | undefined,
    operation: "launch" | "cancel" | "resume",
): void {
    if (expected === undefined) {
        throw new Error(`Workflow ${operation} transaction did not return its callback result.`);
    }
    if (!sameWorkflowRunObject(actual, expected)) {
        throw new Error(`Workflow ${operation} transaction returned a substituted run.`);
    }
}

function assertExpectedTransactionState(
    change: {
        readonly changed: boolean;
        readonly event?: WorkflowEvent;
    },
    expectedChanged: boolean | undefined,
): void {
    if (expectedChanged === undefined || change.changed !== expectedChanged) {
        throw new Error("Workflow transaction returned a substituted change state.");
    }
    if (change.changed !== (change.event !== undefined)) {
        throw new Error("Workflow transaction changed/event state is inconsistent.");
    }
}

function assertExpectedTransactionEvent(
    actual: WorkflowEvent | undefined,
    expected: WorkflowEvent | undefined,
    operation: "launch" | "cancel" | "resume",
): void {
    if (!sameWorkflowEvent(actual, expected)) {
        throw new Error(`Workflow ${operation} transaction returned a substituted event.`);
    }
}

function sameWorkflowEvent(
    left: WorkflowEvent | undefined,
    right: WorkflowEvent | undefined,
): boolean {
    if (left === undefined || right === undefined) return left === right;
    return (
        left.type === right.type &&
        left.agentId === right.agentId &&
        left.eventId === right.eventId &&
        left.at === right.at &&
        sameWorkflowRunObject(left.run, right.run)
    );
}

function sameWorkflowRunObject(left: WorkflowRun, right: WorkflowRun): boolean {
    const keys = [
        "id",
        "agentId",
        "workflow",
        "status",
        "input",
        "output",
        "error",
        "createdAt",
        "updatedAt",
    ] as const;
    return keys.every((key) => {
        const leftHasKey = Object.prototype.hasOwnProperty.call(left, key);
        const rightHasKey = Object.prototype.hasOwnProperty.call(right, key);
        return leftHasKey === rightHasKey && (!leftHasKey || left[key] === right[key]);
    });
}

function isWorkflowTerminalStatus(status: WorkflowRun["status"]): boolean {
    return (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "unavailable"
    );
}

function assertCursorProgress(
    nextCursor: number | undefined,
    requestedCursor: number,
    visibleCount: number,
    label: string,
): void {
    if (nextCursor !== undefined && (nextCursor <= requestedCursor || visibleCount === 0)) {
        throw new Error(
            `${label} page cursor must advance beyond the request and expose a complete item.`,
        );
    }
}

function formatRunRow(run: WorkflowRun): string {
    return `${run.id}: ${run.workflow} [${run.status}]`;
}
