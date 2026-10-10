import * as original from "../../../../happy-agent-modules/sources/workflows/Workflow.ts";
import { workflowEventSchema } from "../../../../happy-agent-modules/sources/workflows/WorkflowEvent.ts";
import { WorkflowsModule } from "../../../../happy-agent-modules/sources/workflows/WorkflowsModule.ts";
import { serializeWorkflowValue } from "../../../../happy-agent-modules/sources/workflows/runner/serializeWorkflowValue.ts";
import { parseStructuredWorkflowResult } from "../../../../happy-agent-modules/sources/workflows/runner/parseStructuredWorkflowResult.ts";
import { runWorkflowTool } from "../../../../happy-agent-modules/sources/workflows/tools/run_workflow.ts";
import { listWorkflowsTool } from "../../../../happy-agent-modules/sources/workflows/tools/list_workflows.ts";
import { workflowStatusTool } from "../../../../happy-agent-modules/sources/workflows/tools/workflow_status.ts";
import { cancelWorkflowTool } from "../../../../happy-agent-modules/sources/workflows/tools/cancel_workflow.ts";
import { resumeWorkflowTool } from "../../../../happy-agent-modules/sources/workflows/tools/resume_workflow.ts";
import { waitWorkflowTool } from "../../../../happy-agent-modules/sources/workflows/tools/wait_workflow.ts";
import { workflowLogsTool } from "../../../../happy-agent-modules/sources/workflows/tools/workflow_logs.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const runner = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/workflows/runner/WorkflowScriptRunner.ts",
        import.meta.url,
    ),
    ["workflowAgentOptionsSchema", "workflowAgentRequestSchema", "normalizeOptions"],
);
export const workflowsTools = [
    runWorkflowTool(undefined, "source-agent", undefined, undefined),
    listWorkflowsTool(undefined, "source-agent"),
    workflowStatusTool(undefined, "source-agent"),
    cancelWorkflowTool(undefined, "source-agent"),
    resumeWorkflowTool(undefined, "source-agent"),
    waitWorkflowTool(undefined, "source-agent"),
    workflowLogsTool(undefined, "source-agent"),
];
export const workflowsSchemas = {
    ownerWorkflowId: original.workflowIdSchema,
    ownerWorkflowAgentId: original.workflowAgentIdSchema,
    ownerWorkflowRun: original.workflowRunSchema,
    ownerWorkflowLaunch: original.workflowLaunchInputSchema,
    ownerWorkflowRequest: original.workflowLaunchRequestSchema,
    ownerWorkflowPageQuery: original.workflowPageQuerySchema,
    ownerWorkflowPage: original.workflowPageSchema,
    ownerWorkflowLogQuery: original.workflowLogQuerySchema,
    ownerWorkflowLogPage: original.workflowLogPageSchema,
    ownerWorkflowArgs: original.workflowArgsSchema,
    ownerWorkflowEvent: workflowEventSchema,
    ownerWorkflowAgentOptions: runner.workflowAgentOptionsSchema,
    ownerWorkflowAgentRequest: runner.workflowAgentRequestSchema,
    ownerWorkflowCheckpoint: Type.Object(
        { nextAgentCallIndex: original.workflowAgentCountSchema, phase: Type.String() },
        { additionalProperties: false },
    ),
    ownerWorkflowAgentCall: Type.Object(
        {
            runId: original.workflowIdSchema,
            callIndex: Type.Integer({ minimum: 0, maximum: 999 }),
            collaboratorId: Type.String({ maxLength: 512 }),
            signature: Type.String(),
            output: Type.Optional(Type.Unknown()),
            error: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
    ownerWorkflowCollaboratorMetadata: Type.Object(
        { workflow: Type.Object({}, { additionalProperties: true }) },
        { additionalProperties: true },
    ),
    ownerWorkflowSchemaRecord: Type.Record(
        Type.String(),
        Type.Object({}, { additionalProperties: true }),
    ),
    ownerWorkflowExecute: Type.Object(
        {
            agentId: original.workflowAgentIdSchema,
            runId: original.workflowIdSchema,
            resumeFromRunId: Type.Optional(original.workflowIdSchema),
        },
        { additionalProperties: false },
    ),
};
workflowsSchemas.ownerWorkflowExecuteResult = Type.Null();
workflowsSchemas.ownerWorkflowFileMarker = Type.Object(
    {
        path: Type.String(),
        mode: Type.String(),
        position: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    },
    { additionalProperties: true },
);
for (const tool of workflowsTools) {
    workflowsSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
const module = new WorkflowsModule(undefined, undefined, undefined);
const base = {
    id: "source-run",
    agentId: "source-agent",
    workflow: "Review",
    description: "Verify a change",
    agentCount: 2,
    logs: ["Started"],
    logsTruncated: false,
    createdAt: 100,
    startedAt: 100,
    updatedAt: 101,
};
const runs = [
    { ...base, status: "running", phase: "Review" },
    { ...base, status: "paused", pausedAt: 101 },
    { ...base, status: "completed", finishedAt: 101, output: "Verified" },
    { ...base, status: "failed", finishedAt: 101, error: "An agent did not answer" },
    { ...base, status: "cancelled", finishedAt: 101 },
];
const cases = [
    {
        text: '```json\n{"ok":true}\n```',
        schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
    { text: '"ok"', schema: { type: "string", minLength: 100 } },
    {
        text: '{"other":1}',
        schema: {
            type: "object",
            properties: { requiredNumber: { type: "number" } },
            additionalProperties: false,
        },
    },
    {
        text: '{"number":"ignored"}',
        schema: { type: "object", properties: { number: { type: "number" }, invalid: 3 } },
    },
    { text: "4", schema: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    { text: '{"ok":true}', schema: { enum: [{ ok: true }] } },
    { text: 'prose {"ok":true}', schema: { type: "object" } },
].map((input) => {
    try {
        return { ...input, output: parseStructuredWorkflowResult(input.text, input.schema) };
    } catch (error) {
        return { ...input, error: error.message };
    }
});
const page = { agentId: "source-agent", cursor: 0, runs, totalRuns: 9, nextCursor: 5 };
const logs = {
    agentId: "source-agent",
    id: "source-run",
    cursor: 2,
    lines: [{ position: 2, text: "Third line" }],
    totalLines: 5,
    nextCursor: 3,
};
const require = createRequire(
    new URL(
        "../../../../happy-agent-modules/sources/workflows/runner/WorkflowScriptRunner.ts",
        import.meta.url,
    ),
);
const { encodeMontyObject } = await import(
    new URL("./worker/value.js", pathToFileURL(require.resolve("@pydantic/monty"))).href
);
const marker = (type, fields = {}) => ({ __monty_type__: type, ...fields });
const inputCases = [
    null,
    true,
    17,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    -(2 ** 63),
    "A source string",
    [1, "value"],
    { 2: 2, 1: 1, ordinary: true },
    marker("Ellipsis"),
    marker("NotImplemented"),
    marker("Date", { year: 2026, month: 6, day: 3 }),
    marker("DateTime", {
        year: 2026,
        month: 6,
        day: 3,
        hour: 12,
        minute: 30,
        second: 0,
        microsecond: 10,
        offsetSeconds: 3600,
        timezoneName: "Example",
    }),
    marker("TimeDelta", { days: 2, seconds: 3, microseconds: 4 }),
    marker("TimeZone", { offsetSeconds: -3600, name: "Example" }),
    marker("Type", { value: "int" }),
    marker("BuiltinFunction", { value: "len" }),
    marker("Exception", { excType: "ValueError", message: "Source error" }),
    marker("FileHandle", { path: "/virtual-file", mode: "rt", position: 2 }),
];
writeFileSync(
    new URL("input_goldens.json", import.meta.url),
    `${JSON.stringify(
        inputCases.map((value) => ({
            value,
            encoded: Buffer.from(encodeMontyObject(value)).toString("base64"),
        })),
        null,
        2,
    )}\n`,
);
writeFileSync(
    new URL("format_goldens.json", import.meta.url),
    `${JSON.stringify({ runs: runs.map((run) => ({ run, text: module.formatRunForModel(run) })), page: { page, text: module.formatPageForModel(page) }, logs: { page: logs, text: module.formatLogsForModel(logs) }, emptyPage: module.formatPageForModel({ ...page, runs: [] }), emptyLogs: module.formatLogsForModel({ ...logs, lines: [] }), serialized: [null, "Final result", { ok: true, values: [1, 2] }].map((value) => ({ value, text: serializeWorkflowValue(value) })), structured: cases, options: [{ effort: "medium", model: "  openai/gpt-5.6-terra  ", provider: "  codex  ", label: "  Keep label  " }].map((options) => ({ input: options, normalized: runner.normalizeOptions(options) })) }, null, 2)}\n`,
);
