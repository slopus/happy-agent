import { createHash } from "node:crypto";

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
    MAX_WORKFLOW_CURSOR,
    MAX_WORKFLOW_ID_LENGTH,
    workflowAgentIdSchema,
    MAX_WORKFLOW_LOG_LINES,
    MAX_WORKFLOW_LOG_LINE_LENGTH,
    MAX_WORKFLOW_NAME_LENGTH,
    MAX_WORKFLOW_OUTPUT_CHARACTERS,
    MAX_WORKFLOW_OPERATION_CANONICAL_BYTES,
    MAX_WORKFLOW_PAGE_SIZE,
    workflowIdSchema,
    workflowCallOperationSchema,
    workflowLaunchInputSchema,
    workflowLaunchToolInputSchema,
    workflowLogQuerySchema,
    workflowMutationInputSchema,
    workflowMutationToolInputSchema,
    workflowPageQuerySchema,
    workflowOperationFingerprintSchema,
    workflowMutationResultSchema,
    workflowTimestampSchema,
    type WorkflowAgentId,
    type WorkflowCallOperation,
    type WorkflowLaunchInput,
    type WorkflowLaunchRequest,
    type WorkflowLaunchToolInput,
    type WorkflowLogPage,
    type WorkflowLogQuery,
    type WorkflowMutationInput,
    type WorkflowMutationProof,
    type WorkflowMutationRequest,
    type WorkflowMutationResult,
    type WorkflowMutationToolInput,
    type WorkflowOperationReceipt,
    type WorkflowPage,
    type WorkflowPageQuery,
    type WorkflowRun,
} from "./Workflow.js";
import {
    MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH,
    workflowEventIdSchema,
    workflowEventSchema,
    workflowFeatureListenerSchema,
    workflowPostCommitErrorSchema,
    type WorkflowEvent,
} from "./WorkflowEvent.js";
import {
    assertWorkflowLogPage,
    assertWorkflowMutationResult,
    assertWorkflowMutationProof,
    assertWorkflowOperationReceipt,
    assertWorkflowPage,
    assertWorkflowRun,
    assertWorkflowTransactionChange,
    workflowStoreSchema,
    type WorkflowStore,
    type WorkflowTransactionChange,
} from "./WorkflowStore.js";
import { listWorkflowsTool } from "./tools/list_workflows.js";
import { cancelWorkflowTool } from "./tools/cancel_workflow.js";
import { runWorkflowTool } from "./tools/run_workflow.js";
import { resumeWorkflowTool } from "./tools/resume_workflow.js";
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
                    workflowPostCommitErrorSchema,
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
const MAX_WORKFLOW_STATUS_TEXT_LENGTH = "unavailable".length;
const PAGE_CURSOR_SUFFIX = `\nprev:${MAX_WORKFLOW_CURSOR}\nnext:${MAX_WORKFLOW_CURSOR}`;
const LOG_CURSOR_SUFFIX = `\nprev:${MAX_WORKFLOW_CURSOR}\nnext:${MAX_WORKFLOW_CURSOR}`;

export class WorkflowsFeature implements AgentFeature {
    readonly name = "workflows";
    readonly #store: WorkflowStore;
    readonly #idFactory: NonNullable<WorkflowFeatureOptions["idFactory"]>;
    readonly #eventIdFactory: NonNullable<WorkflowFeatureOptions["eventIdFactory"]>;
    readonly #clock: NonNullable<WorkflowFeatureOptions["clock"]>;
    readonly #optionsOwner: WorkflowFeatureOptions;
    readonly #listener: WorkflowFeatureOptions["listener"];
    readonly #maxPageSize: number;
    readonly #maxLogLines: number;
    readonly #maxOutputCharacters: number;
    readonly #maxModelRows: number;
    readonly #maxModelLogLines: number;
    readonly #onPostCommitError: WorkflowFeatureOptions["onPostCommitError"];
    readonly #onPostCommitErrorOwner: WorkflowFeatureOptions;

    constructor(options: WorkflowFeatureOptions) {
        if (!Value.Check(workflowFeatureOptionsSchema, options)) {
            throw new Error("Workflow feature options are invalid.");
        }
        this.#store = options.store;
        this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
        this.#eventIdFactory = options.eventIdFactory ?? (() => globalThis.crypto.randomUUID());
        this.#clock = options.clock ?? Date.now;
        this.#optionsOwner = options;
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
        this.#onPostCommitErrorOwner = options;
        this.#now();
    }

    readonly tools = (_ctx: Context, scope: AgentFeatureScope): readonly AnyAgentTool[] => [
        runWorkflowTool(this, scope.agent.id),
        listWorkflowsTool(this, scope.agent.id),
        workflowStatusTool(this, scope.agent.id),
        cancelWorkflowTool(this, scope.agent.id),
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
        const request = deepFreeze<WorkflowLaunchRequest>(
            structuredClone({ ...normalizedInput, operationId: id }),
        );
        let expectedRun: WorkflowRun | undefined;
        let expectedChanged: boolean | undefined;
        let expectedEvent: WorkflowEvent | undefined;
        const change = await this.#transaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, id);
            const existingProof = await this.#readMutationProof(txCtx, agentId, id);
            if (receipt !== undefined || existingProof !== undefined) {
                if (receipt === undefined || existingProof === undefined) {
                    throw new Error("Workflow operation evidence is incomplete.");
                }
                const replay = this.#replayLaunch(
                    receipt,
                    existingProof,
                    agentId,
                    fingerprint,
                    request,
                );
                expectedRun = structuredClone(replay);
                expectedChanged = false;
                return { agentId, operationId: id, run: replay, changed: false };
            }
            const existing = await this.#getStoreRun(txCtx, agentId, id);
            if (existing !== undefined) {
                assertWorkflowRun(existing);
                assertRunId(existing, id, "Workflow store returned the wrong existing run.");
                assertRunOwner(
                    existing,
                    agentId,
                    "Workflow store returned an existing run for another agent.",
                );
                throw new Error(
                    `Workflow operation "${id}" has a run without complete replay evidence.`,
                );
            }
            const run = await this.#launchStoreRun(txCtx, agentId, structuredClone(request));
            assertRunOwner(run, agentId, "Workflow runner returned a run for another agent.");
            assertLaunchResult(run, request);
            const after = await this.#getStoreRun(txCtx, agentId, id);
            if (after === undefined) {
                throw new Error("Workflow runner did not persist the launched run.");
            }
            assertWorkflowRun(after);
            assertRunOwner(after, agentId, "Workflow runner persisted a run for another agent.");
            assertLaunchResult(after, request);
            if (!sameWorkflowRunObject(run, after)) {
                throw new Error("Workflow runner returned a launch result different from storage.");
            }
            const proof: WorkflowMutationProof = {
                agentId,
                operation: "launch",
                operationId: id,
                fingerprint,
                beforeExists: false,
                after: structuredClone(after),
                changed: true,
                result: structuredClone(after),
            };
            const launchReceipt: WorkflowOperationReceipt = {
                agentId,
                operation: "launch",
                operationId: id,
                fingerprint,
                result: structuredClone(after),
            };
            await this.#writeMutationProof(txCtx, agentId, proof);
            await this.#writeReceipt(txCtx, agentId, launchReceipt);
            const eventId = await this.#newEventId(txCtx, agentId);
            const at = this.#now();
            expectedRun = structuredClone(after);
            expectedChanged = true;
            const event = this.#event(
                { type: "workflow_started", agentId, run: after },
                eventId,
                at,
            );
            expectedEvent = event;
            await this.#notifyTransactional(txCtx, event);
            this.#registerPostCommit(txCtx, event);
            return { agentId, operationId: id, run: after, changed: true, event };
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

    async status(ctx: Context, agentId: string, id: string): Promise<WorkflowRun | undefined> {
        this.#assertAgentId(agentId);
        this.#assertId(id);
        const run = await this.#getStoreRun(ctx, agentId, id);
        if (run === undefined) return undefined;
        assertWorkflowRun(run);
        if (run.id !== id) throw new Error("Workflow store returned the wrong run.");
        assertRunOwner(run, agentId, "Workflow store returned a run for another agent.");
        return structuredClone(run);
    }

    async list(
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
        const page = await this.#listStorePage(ctx, agentId, { ...query, limit });
        assertWorkflowPageOwner(page, agentId);
        if (page.runs.length > limit) throw new Error("Workflow store returned too many runs.");
        assertWorkflowPageRecords(page, query);
        assertExactOffsetPage(page, query, limit);
        this.formatPageForModel(page);
        return structuredClone(page);
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
        return await this.#mutate(ctx, agentId, { ...input, operationId }, "cancel", fingerprint);
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
        return await this.#mutate(ctx, agentId, { ...input, operationId }, "resume", fingerprint);
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
        const run = await this.#waitStoreRun(ctx, agentId, id);
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
        const page = await this.#logsStorePage(ctx, agentId, { ...query, limit });
        if (page.id !== query.id || page.lines.length > limit || page.agentId !== agentId) {
            throw new Error("Workflow store returned logs outside the requested bound.");
        }
        assertExactLogPage(page, query, limit);
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
        const suffix = formatCursorSuffix(page.previousCursor, page.nextCursor);
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
            ["output", "output" in run ? run.output : undefined],
            ["error", "error" in run ? run.error : undefined],
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
        const suffix = formatCursorSuffix(page.previousCursor, page.nextCursor);
        const header = page.id;
        const fixedCharacters = header.length + (page.lines.length > 0 ? 1 : 0) + suffix.length;
        const available = this.#maxOutputCharacters - fixedCharacters;
        const lineBudget = Math.floor(
            (available - Math.max(0, page.lines.length - 1)) / Math.max(1, page.lines.length),
        );
        if (page.lines.length > 0 && lineBudget < 1) {
            throw new Error("Workflow logs exceeded the model output bound.");
        }
        const lines = page.lines.map(({ text }) => {
            if (text.length <= lineBudget) return text;
            if (lineBudget === 1) return text.slice(0, 1);
            return `${text.slice(0, lineBudget - 1)}…`;
        });
        const output = [header, ...lines].join("\n") + suffix;
        if (output.length > this.#maxOutputCharacters) {
            throw new Error("Workflow logs exceeded the model output bound.");
        }
        return output;
    }

    async #transaction(
        ctx: Context,
        agentId: string,
        work: (txCtx: Context) => Promise<WorkflowTransactionChange>,
    ): Promise<WorkflowTransactionChange> {
        const raw: unknown = Reflect.apply(this.#store.transaction, this.#store, [
            ctx,
            agentId,
            work,
        ]);
        const resolved = await workflowStorePromise(raw, "transaction");
        assertWorkflowTransactionChange(resolved);
        return resolved;
    }

    async #launchStoreRun(
        ctx: Context,
        agentId: string,
        request: WorkflowLaunchRequest,
    ): Promise<WorkflowRun> {
        const raw: unknown = Reflect.apply(this.#store.launch, this.#store, [
            ctx,
            agentId,
            request,
        ]);
        const resolved = await workflowStorePromise(raw, "launch");
        assertWorkflowRun(resolved);
        return resolved;
    }

    async #getStoreRun(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<WorkflowRun | undefined> {
        const raw: unknown = Reflect.apply(this.#store.get, this.#store, [ctx, agentId, id]);
        const resolved = await workflowStorePromise(raw, "get");
        if (resolved === undefined) return undefined;
        assertWorkflowRun(resolved);
        return resolved;
    }

    async #listStorePage(
        ctx: Context,
        agentId: string,
        query: WorkflowPageQuery,
    ): Promise<WorkflowPage> {
        const raw: unknown = Reflect.apply(this.#store.list, this.#store, [ctx, agentId, query]);
        const resolved = await workflowStorePromise(raw, "list");
        assertWorkflowPage(resolved);
        return resolved;
    }

    async #mutateStoreRun(
        ctx: Context,
        agentId: string,
        request: WorkflowMutationRequest,
        operation: "cancel" | "resume",
    ): Promise<WorkflowMutationResult> {
        const method = operation === "cancel" ? this.#store.cancel : this.#store.resume;
        const raw: unknown = Reflect.apply(method, this.#store, [ctx, agentId, request]);
        const resolved = await workflowStorePromise(raw, operation);
        assertWorkflowMutationResult(resolved);
        return resolved;
    }

    async #waitStoreRun(ctx: Context, agentId: string, id: string): Promise<WorkflowRun> {
        const raw: unknown = Reflect.apply(this.#store.wait, this.#store, [ctx, agentId, id]);
        const resolved = await workflowStorePromise(raw, "wait");
        assertWorkflowRun(resolved);
        return resolved;
    }

    async #logsStorePage(
        ctx: Context,
        agentId: string,
        query: WorkflowLogQuery,
    ): Promise<WorkflowLogPage> {
        const raw: unknown = Reflect.apply(this.#store.logs, this.#store, [ctx, agentId, query]);
        const resolved = await workflowStorePromise(raw, "logs");
        assertWorkflowLogPage(resolved);
        return resolved;
    }

    async #readStoreReceipt(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<WorkflowOperationReceipt | undefined> {
        const raw: unknown = Reflect.apply(this.#store.readReceipt, this.#store, [
            ctx,
            agentId,
            operationId,
        ]);
        const resolved = await workflowStorePromise(raw, "readReceipt");
        if (resolved === undefined) return undefined;
        assertWorkflowOperationReceipt(resolved);
        return resolved;
    }

    async #writeStoreReceipt(
        ctx: Context,
        agentId: string,
        receipt: WorkflowOperationReceipt,
    ): Promise<void> {
        const raw: unknown = Reflect.apply(this.#store.writeReceipt, this.#store, [
            ctx,
            agentId,
            receipt,
        ]);
        const resolved = await workflowStorePromise(raw, "writeReceipt");
        if (resolved !== undefined) {
            throw new Error("Workflow store writeReceipt must resolve to undefined.");
        }
    }

    async #readStoreMutationProof(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<WorkflowMutationProof | undefined> {
        const raw: unknown = Reflect.apply(this.#store.readMutationProof, this.#store, [
            ctx,
            agentId,
            operationId,
        ]);
        const resolved = await workflowStorePromise(raw, "readMutationProof");
        if (resolved === undefined) return undefined;
        assertWorkflowMutationProof(resolved);
        return resolved;
    }

    async #writeStoreMutationProof(
        ctx: Context,
        agentId: string,
        proof: WorkflowMutationProof,
    ): Promise<void> {
        const raw: unknown = Reflect.apply(this.#store.writeMutationProof, this.#store, [
            ctx,
            agentId,
            proof,
        ]);
        const resolved = await workflowStorePromise(raw, "writeMutationProof");
        if (resolved !== undefined) {
            throw new Error("Workflow store writeMutationProof must resolve to undefined.");
        }
    }

    async #mutate(
        ctx: Context,
        agentId: string,
        input: WorkflowMutationRequest,
        operation: "cancel" | "resume",
        fingerprint: string,
    ): Promise<WorkflowMutationResult> {
        this.#assertInput(workflowMutationInputSchema, input, `workflow ${operation}`);
        const request = deepFreeze<WorkflowMutationRequest>(structuredClone(input));
        const id = request.id;
        const operationId = request.operationId;
        let expectedRun: WorkflowRun | undefined;
        let expectedChanged: boolean | undefined;
        let expectedEvent: WorkflowEvent | undefined;
        let historicalResult: WorkflowMutationResult | undefined;
        const change = await this.#transaction(ctx, agentId, async (txCtx) => {
            const receipt = await this.#readReceipt(txCtx, agentId, operationId);
            const existingProof = await this.#readMutationProof(txCtx, agentId, operationId);
            if (receipt !== undefined || existingProof !== undefined) {
                if (receipt === undefined || existingProof === undefined) {
                    throw new Error("Workflow operation evidence is incomplete.");
                }
                const replay = this.#replayMutation(
                    receipt,
                    existingProof,
                    agentId,
                    operation,
                    fingerprint,
                    request,
                );
                historicalResult = structuredClone(replay);
                expectedRun = structuredClone(replay.run);
                expectedChanged = false;
                return {
                    agentId,
                    operationId,
                    run: structuredClone(replay.run),
                    changed: false,
                };
            }
            const current = await this.#getStoreRun(txCtx, agentId, id);
            if (current === undefined) {
                throw new Error("Workflow mutation target was not found.");
            }
            assertWorkflowRun(current);
            assertRunId(current, id, "Workflow store returned the wrong current run.");
            assertRunOwner(
                current,
                agentId,
                "Workflow store returned a current run for another agent.",
            );
            const invokesHost = workflowMutationInvokesHost(current, operation);
            let after: WorkflowRun;
            let mutation: WorkflowMutationResult;
            if (invokesHost) {
                mutation = await this.#mutateStoreRun(
                    txCtx,
                    agentId,
                    structuredClone(request),
                    operation,
                );
                assertMutationOwner(mutation, agentId, id);
                if (mutation.operationId !== operationId) {
                    throw new Error("Workflow operation returned the wrong operation ID.");
                }
                const persisted = await this.#getStoreRun(txCtx, agentId, id);
                if (persisted === undefined) {
                    throw new Error("Workflow operation removed its target run.");
                }
                assertWorkflowRun(persisted);
                assertRunOwner(
                    persisted,
                    agentId,
                    "Workflow operation persisted another agent's run.",
                );
                assertRunId(persisted, id, "Workflow operation persisted the wrong run.");
                after = persisted;
            } else {
                after = structuredClone(current);
                mutation = {
                    agentId,
                    operationId,
                    run: structuredClone(current),
                    changed: false,
                };
            }
            const changed = assertMutationTransition(current, after, id, operation);
            if (
                mutation.agentId !== agentId ||
                mutation.operationId !== operationId ||
                mutation.changed !== changed ||
                !sameWorkflowRunObject(mutation.run, after)
            ) {
                throw new Error(
                    "Workflow operation result did not match the authoritative transition.",
                );
            }
            const result: WorkflowMutationResult = {
                agentId,
                operationId,
                run: structuredClone(after),
                changed,
            };
            const proof: WorkflowMutationProof = {
                agentId,
                operation,
                operationId,
                fingerprint,
                targetId: id,
                before: structuredClone(current),
                after: structuredClone(after),
                changed,
                result: structuredClone(result),
            };
            const mutationReceipt: WorkflowOperationReceipt = {
                agentId,
                operation,
                operationId,
                fingerprint,
                targetId: id,
                result: structuredClone(result),
            };
            await this.#writeMutationProof(txCtx, agentId, proof);
            await this.#writeReceipt(txCtx, agentId, mutationReceipt);
            historicalResult = structuredClone(result);
            expectedRun = structuredClone(after);
            expectedChanged = changed;
            if (!changed) {
                return { agentId, operationId, run: after, changed: false };
            }
            const eventId = await this.#newEventId(txCtx, agentId);
            const at = this.#now();
            const event = this.#event(
                {
                    type: operation === "cancel" ? "workflow_cancelled" : "workflow_updated",
                    agentId,
                    run: after,
                },
                eventId,
                at,
            );
            expectedEvent = event;
            await this.#notifyTransactional(txCtx, event);
            this.#registerPostCommit(txCtx, event);
            return { agentId, operationId, run: after, changed: true, event };
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
        if (historicalResult === undefined) {
            throw new Error(`Workflow ${operation} transaction did not retain its result.`);
        }
        const result = structuredClone(historicalResult);
        if (!Value.Check(workflowMutationResultSchema, result)) {
            throw new Error("Workflow mutation returned an invalid result.");
        }
        return structuredClone(result);
    }

    async #readReceipt(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<WorkflowOperationReceipt | undefined> {
        const raw = await this.#readStoreReceipt(ctx, agentId, operationId);
        if (raw === undefined) return undefined;
        assertWorkflowReceiptIdentity(raw, agentId, operationId);
        return structuredClone(raw);
    }

    async #readMutationProof(
        ctx: Context,
        agentId: string,
        operationId: string,
    ): Promise<WorkflowMutationProof | undefined> {
        const raw = await this.#readStoreMutationProof(ctx, agentId, operationId);
        if (raw === undefined) return undefined;
        assertWorkflowProofIdentity(raw, agentId, operationId);
        return structuredClone(raw);
    }

    async #writeReceipt(
        ctx: Context,
        agentId: string,
        receipt: WorkflowOperationReceipt,
    ): Promise<void> {
        assertWorkflowOperationReceipt(receipt);
        if (receipt.agentId !== agentId) {
            throw new Error("Workflow receipt belongs to another agent.");
        }
        assertWorkflowReceiptIdentity(receipt, agentId, receipt.operationId);
        const expected = deepFreeze(structuredClone(receipt));
        await this.#writeStoreReceipt(ctx, agentId, structuredClone(expected));
        const retained = await this.#readReceipt(ctx, agentId, expected.operationId);
        if (retained === undefined || !sameWorkflowReceipt(retained, expected)) {
            throw new Error("Workflow store did not durably retain the exact receipt.");
        }
    }

    async #writeMutationProof(
        ctx: Context,
        agentId: string,
        proof: WorkflowMutationProof,
    ): Promise<void> {
        assertWorkflowMutationProof(proof);
        if (proof.agentId !== agentId) {
            throw new Error("Workflow mutation proof belongs to another agent.");
        }
        assertWorkflowProofIdentity(proof, agentId, proof.operationId);
        const expected = deepFreeze(structuredClone(proof));
        await this.#writeStoreMutationProof(ctx, agentId, structuredClone(expected));
        const retained = await this.#readMutationProof(ctx, agentId, expected.operationId);
        if (retained === undefined || !sameWorkflowProof(retained, expected)) {
            throw new Error("Workflow store did not durably retain the exact mutation proof.");
        }
    }

    #replayLaunch(
        receipt: WorkflowOperationReceipt,
        proof: WorkflowMutationProof,
        agentId: string,
        fingerprint: string,
        request: WorkflowLaunchRequest,
    ): WorkflowRun {
        if (receipt.operation !== "launch" || proof.operation !== "launch") {
            throw new Error("Workflow operation ID was reused for another operation.");
        }
        if (
            receipt.agentId !== agentId ||
            proof.agentId !== agentId ||
            receipt.operationId !== request.operationId ||
            proof.operationId !== request.operationId ||
            receipt.fingerprint !== fingerprint ||
            proof.fingerprint !== fingerprint
        ) {
            throw new Error("Workflow launch replay evidence does not match the request.");
        }
        assertLaunchResult(proof.after, request);
        assertLaunchResult(proof.result, request);
        if (
            proof.beforeExists !== false ||
            proof.changed !== true ||
            !sameWorkflowRunObject(proof.after, proof.result) ||
            !sameWorkflowRunObject(receipt.result, proof.result)
        ) {
            throw new Error("Workflow launch replay evidence is inconsistent.");
        }
        return structuredClone(proof.result);
    }

    #replayMutation(
        receipt: WorkflowOperationReceipt,
        proof: WorkflowMutationProof,
        agentId: string,
        operation: "cancel" | "resume",
        fingerprint: string,
        request: WorkflowMutationRequest,
    ): WorkflowMutationResult {
        if (receipt.operation !== operation || proof.operation !== operation) {
            throw new Error("Workflow operation ID was reused for another operation.");
        }
        if (
            receipt.agentId !== agentId ||
            proof.agentId !== agentId ||
            receipt.operationId !== request.operationId ||
            proof.operationId !== request.operationId ||
            receipt.fingerprint !== fingerprint ||
            proof.fingerprint !== fingerprint ||
            receipt.targetId !== request.id ||
            proof.targetId !== request.id
        ) {
            throw new Error("Workflow mutation replay evidence does not match the request.");
        }
        const changed = assertMutationTransition(proof.before, proof.after, request.id, operation);
        if (
            proof.changed !== changed ||
            proof.result.agentId !== agentId ||
            proof.result.operationId !== request.operationId ||
            proof.result.changed !== changed ||
            !sameWorkflowRunObject(proof.result.run, proof.after) ||
            !sameWorkflowMutationResult(receipt.result, proof.result)
        ) {
            throw new Error("Workflow mutation replay evidence is inconsistent.");
        }
        return structuredClone(proof.result);
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
        if (kv === undefined) {
            throw new Error(
                "Workflow host mutations require an operation ID outside a durable tool call.",
            );
        }
        const scopedKey = `${key}:${agentId}`;
        return await kv.transaction(ctx, async (scope, txCtx) => {
            const existing = await scope.read(txCtx, scopedKey);
            if (existing !== undefined) {
                if (!Value.Check(workflowCallOperationSchema, existing)) {
                    throw new Error("Stored workflow call operation is invalid.");
                }
                const receipt = existing as WorkflowCallOperation;
                if (receipt.fingerprint !== fingerprint) {
                    throw new Error(
                        `Workflow operation "${receipt.operationId}" was reused with different input or target.`,
                    );
                }
                return receipt.operationId;
            }
            const id = await workflowFactoryResult(
                Reflect.apply(this.#idFactory, this.#optionsOwner, [txCtx, agentId]),
                "ID factory",
            );
            this.#assertId(id);
            const expected = deepFreeze({
                operationId: id,
                fingerprint,
            } satisfies WorkflowCallOperation);
            await scope.write(txCtx, scopedKey, structuredClone(expected));
            const retained = await scope.read(txCtx, scopedKey);
            if (
                !Value.Check(workflowCallOperationSchema, retained) ||
                retained.operationId !== expected.operationId ||
                retained.fingerprint !== expected.fingerprint
            ) {
                throw new Error("Workflow call operation was not durably retained.");
            }
            return id;
        });
    }

    async #newEventId(ctx: Context, agentId: string): Promise<string> {
        this.#assertAgentId(agentId);
        const id = await workflowFactoryResult(
            Reflect.apply(this.#eventIdFactory, this.#optionsOwner, [ctx, agentId]),
            "event ID factory",
        );
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
        const callback = this.#listener?.onEventTransactional;
        if (callback !== undefined) {
            await workflowVoidResult(
                callback.call(this.#listener, ctx, event),
                "transactional listener",
            );
        }
    }

    #registerPostCommit(ctx: Context, event: WorkflowEvent): void {
        const returned: unknown = Reflect.apply(this.#store.afterCommit, this.#store, [
            ctx,
            (postCommitCtx: Context) => this.#notifyPostCommit(postCommitCtx, event),
        ]);
        if (returned !== undefined) {
            if (returned instanceof Promise) {
                void returned.catch(() => undefined);
            }
            throw new Error("Workflow store afterCommit must register synchronously.");
        }
    }

    async #notifyPostCommit(ctx: Context, event: WorkflowEvent): Promise<void> {
        try {
            const callback = this.#listener?.onEvent;
            if (callback !== undefined) {
                await workflowVoidResult(
                    callback.call(this.#listener, ctx, event),
                    "post-commit listener",
                );
            }
        } catch (error: unknown) {
            try {
                const reporter = this.#onPostCommitError;
                if (reporter !== undefined) {
                    const returned: unknown = reporter.call(
                        this.#onPostCommitErrorOwner,
                        ctx,
                        event,
                        normalizePostCommitError(error),
                    );
                    await workflowVoidResult(returned, "post-commit error reporter");
                }
            } catch {
                // Post-commit observers cannot turn a committed operation into a failure.
            }
        }
    }

    #now(): number {
        const at: unknown = Reflect.apply(this.#clock, this.#optionsOwner, []);
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
}

async function workflowStorePromise(value: unknown, label: string): Promise<unknown> {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        throw new Error(`Workflow ${label} must return a Promise.`);
    }
    let then: unknown;
    try {
        then = Reflect.get(value, "then");
    } catch {
        throw new Error(`Workflow ${label} must return a Promise.`);
    }
    if (typeof then !== "function") {
        throw new Error(`Workflow ${label} must return a Promise.`);
    }
    return await (value as PromiseLike<unknown>);
}

async function workflowFactoryResult(value: unknown, label: string): Promise<unknown> {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return value;
    }
    let then: unknown;
    try {
        then = Reflect.get(value, "then");
    } catch {
        throw new Error(`Workflow ${label} returned an invalid Promise.`);
    }
    return typeof then === "function" ? await (value as PromiseLike<unknown>) : value;
}

async function workflowVoidResult(value: unknown, label: string): Promise<void> {
    if (value === undefined) return;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        throw new Error(
            `Workflow ${label} must return undefined or a Promise resolving to undefined.`,
        );
    }
    let then: unknown;
    try {
        then = Reflect.get(value, "then");
    } catch {
        throw new Error(
            `Workflow ${label} must return undefined or a Promise resolving to undefined.`,
        );
    }
    if (typeof then !== "function") {
        throw new Error(
            `Workflow ${label} must return undefined or a Promise resolving to undefined.`,
        );
    }
    const resolved = await (value as PromiseLike<unknown>);
    if (resolved !== undefined) {
        throw new Error(`Workflow ${label} must resolve to undefined.`);
    }
}

function assertWorkflowReceiptIdentity(
    receipt: WorkflowOperationReceipt,
    agentId: string,
    operationId: string,
): void {
    if (receipt.agentId !== agentId || receipt.operationId !== operationId) {
        throw new Error("Workflow store returned a receipt with the wrong identity.");
    }
    if (receipt.operation === "launch") {
        assertRunOwner(
            receipt.result,
            agentId,
            "Workflow receipt contains a run for another agent.",
        );
        assertRunId(receipt.result, operationId, "Workflow receipt contains the wrong launch run.");
        return;
    }
    if (
        receipt.result.agentId !== agentId ||
        receipt.result.operationId !== operationId ||
        receipt.result.run.id !== receipt.targetId
    ) {
        throw new Error("Workflow receipt contains a mutation with the wrong identity.");
    }
    assertRunOwner(
        receipt.result.run,
        agentId,
        "Workflow receipt contains a mutation run for another agent.",
    );
}

function assertWorkflowProofIdentity(
    proof: WorkflowMutationProof,
    agentId: string,
    operationId: string,
): void {
    if (proof.agentId !== agentId || proof.operationId !== operationId) {
        throw new Error("Workflow store returned a mutation proof with the wrong identity.");
    }
    if (proof.operation === "launch") {
        for (const run of [proof.after, proof.result]) {
            assertRunOwner(
                run,
                agentId,
                "Workflow mutation proof contains a run for another agent.",
            );
            assertRunId(run, operationId, "Workflow mutation proof contains the wrong launch run.");
        }
        return;
    }
    if (
        proof.result.agentId !== agentId ||
        proof.result.operationId !== operationId ||
        proof.before.id !== proof.targetId ||
        proof.after.id !== proof.targetId ||
        proof.result.run.id !== proof.targetId
    ) {
        throw new Error("Workflow mutation proof contains a mutation with the wrong identity.");
    }
    for (const run of [proof.before, proof.after, proof.result.run]) {
        assertRunOwner(run, agentId, "Workflow mutation proof contains a run for another agent.");
    }
}

function normalizePostCommitError(error: unknown): string {
    let message: string | undefined;
    try {
        if (error !== null && (typeof error === "object" || typeof error === "function")) {
            try {
                const candidate = Reflect.get(error, "message");
                if (typeof candidate === "string" && candidate.length > 0) {
                    message = candidate;
                }
            } catch {
                // Fall through to the guarded primitive conversion.
            }
        }
        if (message === undefined) {
            try {
                const converted = String(error);
                if (converted.length > 0) message = converted;
            } catch {
                // Fall through to the bounded fallback.
            }
        }
    } catch {
        // Hostile values may throw during reflection as well as conversion.
    }
    const normalized = (message ?? "Unknown Workflow observer error.")
        .replace(/\r\n?/g, "\n")
        .replaceAll("\0", "�");
    const bounded =
        normalized.length <= MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH
            ? normalized
            : `${normalized.slice(0, MAX_WORKFLOW_POST_COMMIT_ERROR_LENGTH - 1)}…`;
    if (!Value.Check(workflowPostCommitErrorSchema, bounded)) {
        return "Unknown Workflow observer error.";
    }
    return bounded;
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
    if (new TextEncoder().encode(encoded).byteLength > MAX_WORKFLOW_OPERATION_CANONICAL_BYTES) {
        throw new Error("Workflow operation input exceeds the durable receipt bound.");
    }
    const digest = createHash("sha256").update(encoded, "utf8").digest("hex");
    if (!Value.Check(workflowOperationFingerprintSchema, digest)) {
        throw new Error("Workflow operation fingerprint is invalid.");
    }
    return digest;
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

function assertMutationTransition(
    before: WorkflowRun,
    after: WorkflowRun,
    id: string,
    operation: "cancel" | "resume",
): boolean {
    if (after.id !== id) {
        throw new Error("Workflow operation returned the wrong identity.");
    }
    if (operation === "cancel") {
        if (isWorkflowTerminalStatus(before.status)) {
            if (!sameWorkflowRunObject(before, after)) {
                throw new Error("Workflow terminal cancellation must be an exact no-op.");
            }
            return false;
        }
        if (after.status !== "cancelled") {
            throw new Error("Workflow cancellation did not produce a cancelled run.");
        }
        assertWorkflowMutationFieldsPreserved(before, after);
        if (after.updatedAt <= before.updatedAt) {
            throw new Error("Workflow cancellation timestamp must advance.");
        }
        return true;
    }
    if (before.status === "running") {
        if (!sameWorkflowRunObject(before, after)) {
            throw new Error("Workflow running resume must be an exact no-op.");
        }
        return false;
    }
    if (before.status !== "paused") {
        throw new Error("Only a paused workflow run can be resumed.");
    }
    if (after.status !== "running") {
        throw new Error("Workflow resume did not produce a running run.");
    }
    assertWorkflowMutationFieldsPreserved(before, after);
    if (after.updatedAt <= before.updatedAt) {
        throw new Error("Workflow resume timestamp must advance.");
    }
    return true;
}

function workflowMutationInvokesHost(before: WorkflowRun, operation: "cancel" | "resume"): boolean {
    if (operation === "cancel") return !isWorkflowTerminalStatus(before.status);
    if (before.status === "paused") return true;
    if (before.status === "running") return false;
    throw new Error("Only a paused workflow run can be resumed.");
}

function assertWorkflowMutationFieldsPreserved(before: WorkflowRun, after: WorkflowRun): void {
    for (const key of [
        "agentId",
        "workflow",
        "input",
        "createdAt",
        "startedAt",
        "output",
    ] as const) {
        if (!sameWorkflowRunField(before, after, key)) {
            throw new Error("Workflow operation changed fields outside its lifecycle transition.");
        }
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
        "startedAt",
        "pausedAt",
        "finishedAt",
    ] as const;
    return keys.every((key) => sameWorkflowRunField(left, right, key));
}

function sameWorkflowRunField(
    left: WorkflowRun,
    right: WorkflowRun,
    key:
        | "id"
        | "agentId"
        | "workflow"
        | "status"
        | "input"
        | "output"
        | "error"
        | "createdAt"
        | "updatedAt"
        | "startedAt"
        | "pausedAt"
        | "finishedAt",
): boolean {
    const leftHasKey = Object.prototype.hasOwnProperty.call(left, key);
    const rightHasKey = Object.prototype.hasOwnProperty.call(right, key);
    return (
        leftHasKey === rightHasKey &&
        (!leftHasKey || Reflect.get(left, key) === Reflect.get(right, key))
    );
}

function sameWorkflowMutationResult(
    left: WorkflowMutationResult,
    right: WorkflowMutationResult,
): boolean {
    return (
        left.agentId === right.agentId &&
        left.operationId === right.operationId &&
        left.changed === right.changed &&
        sameWorkflowRunObject(left.run, right.run)
    );
}

function sameWorkflowReceipt(
    left: WorkflowOperationReceipt,
    right: WorkflowOperationReceipt,
): boolean {
    if (
        left.agentId !== right.agentId ||
        left.operation !== right.operation ||
        left.operationId !== right.operationId ||
        left.fingerprint !== right.fingerprint
    ) {
        return false;
    }
    if (left.operation === "launch" || right.operation === "launch") {
        return (
            left.operation === "launch" &&
            right.operation === "launch" &&
            sameWorkflowRunObject(left.result, right.result)
        );
    }
    return (
        left.targetId === right.targetId && sameWorkflowMutationResult(left.result, right.result)
    );
}

function sameWorkflowProof(left: WorkflowMutationProof, right: WorkflowMutationProof): boolean {
    if (
        left.agentId !== right.agentId ||
        left.operation !== right.operation ||
        left.operationId !== right.operationId ||
        left.fingerprint !== right.fingerprint ||
        left.changed !== right.changed
    ) {
        return false;
    }
    if (left.operation === "launch" || right.operation === "launch") {
        return (
            left.operation === "launch" &&
            right.operation === "launch" &&
            left.beforeExists === right.beforeExists &&
            sameWorkflowRunObject(left.after, right.after) &&
            sameWorkflowRunObject(left.result, right.result)
        );
    }
    return (
        left.targetId === right.targetId &&
        sameWorkflowRunObject(left.before, right.before) &&
        sameWorkflowRunObject(left.after, right.after) &&
        sameWorkflowMutationResult(left.result, right.result)
    );
}

function isWorkflowTerminalStatus(status: WorkflowRun["status"]): boolean {
    return (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "unavailable"
    );
}

function assertExactOffsetPage(page: WorkflowPage, query: WorkflowPageQuery, limit: number): void {
    assertExactOffsetCursors(
        page.cursor,
        page.totalRuns,
        page.runs.length,
        page.previousCursor,
        page.nextCursor,
        queryCursor(query),
        query.from,
        limit,
        "workflow",
    );
}

function assertWorkflowPageRecords(page: WorkflowPage, query: WorkflowPageQuery): void {
    let previousId: string | undefined;
    for (const run of page.runs) {
        if (query.includeTerminal === false && isWorkflowTerminalStatus(run.status)) {
            throw new Error("Workflow store returned a terminal run outside the requested filter.");
        }
        if (previousId !== undefined && compareCodeUnits(previousId, run.id) >= 0) {
            throw new Error("Workflow store returned duplicate or unordered run identities.");
        }
        previousId = run.id;
    }
}

function assertExactLogPage(page: WorkflowLogPage, query: WorkflowLogQuery, limit: number): void {
    assertExactOffsetCursors(
        page.cursor,
        page.totalLines,
        page.lines.length,
        page.previousCursor,
        page.nextCursor,
        queryCursor(query),
        query.from,
        limit,
        "workflow log",
    );
    for (const [index, line] of page.lines.entries()) {
        if (line.position !== page.cursor + index) {
            throw new Error(
                "Workflow store returned duplicate, skipped, or unordered log positions.",
            );
        }
    }
}

function assertExactOffsetCursors(
    cursor: number,
    total: number,
    visibleCount: number,
    previousCursor: number | undefined,
    nextCursor: number | undefined,
    requestedCursor: number | undefined,
    from: "start" | "end" | undefined,
    limit: number,
    label: string,
): void {
    const expectedCursor = from === "end" ? Math.max(0, total - limit) : (requestedCursor ?? 0);
    const expectedCount = Math.min(limit, Math.max(0, total - expectedCursor));
    const expectedNext =
        expectedCursor + expectedCount < total ? expectedCursor + expectedCount : undefined;
    const backwardAnchor = Math.min(expectedCursor, total);
    const expectedPrevious = backwardAnchor === 0 ? undefined : Math.max(0, backwardAnchor - limit);
    if (cursor !== expectedCursor || visibleCount !== expectedCount) {
        throw new Error(`${label} page did not return the exact requested offset window.`);
    }
    if (nextCursor !== expectedNext) {
        throw new Error(`${label} page returned an invalid next cursor.`);
    }
    if (previousCursor !== expectedPrevious) {
        throw new Error(`${label} page returned an invalid previous cursor.`);
    }
}

function queryCursor(query: WorkflowPageQuery | WorkflowLogQuery): number | undefined {
    return "cursor" in query ? query.cursor : undefined;
}

function formatCursorSuffix(
    previousCursor: number | undefined,
    nextCursor: number | undefined,
): string {
    return [
        ...(previousCursor === undefined ? [] : [`prev:${previousCursor}`]),
        ...(nextCursor === undefined ? [] : [`next:${nextCursor}`]),
    ]
        .map((line) => `\n${line}`)
        .join("");
}

function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function formatRunRow(run: WorkflowRun): string {
    return `${run.id}: ${run.workflow} [${run.status}]`;
}
