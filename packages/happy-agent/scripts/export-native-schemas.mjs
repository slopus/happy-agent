import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import {
    documentBodySchema,
    securityDocumentBodySchema,
    agentCreateBodySchema,
    messageSendBodySchema,
    agentModeSchema,
} from "../../happy-agent-modules/sources/api/ApiSchemas.ts";
import {
    eventIdSchema,
    appendEventInputSchema,
} from "../../happy-agent-modules/sources/events/types.ts";
import { historyMessageSchema } from "../../happy-agent-modules/sources/history/HistoryMessage.ts";
import {
    usageRecordSchema,
    usageCurrentContextSchema,
    usageRunBreakdownSchema,
} from "../../happy-agent-modules/sources/usage/Usage.ts";
import { codexExecCommandTool } from "../../happy-agent-modules/sources/compute/tools/codex/exec_command.ts";

// Build-time reference data only; the released daemon evaluates the serialized
// TypeBox contract in Rust and does not load JavaScript.
const require = createRequire(new URL("../../happy-agent-modules/package.json", import.meta.url));
const { Type } = require("@sinclair/typebox");
const { agentConfigSchema, cuid2Schema, agentPermissionModeSchema } = await import(
    require.resolve("@slopus/happy-agent-base")
);
// The factory closes over compute only in execution/review functions. Reading
// its schema and descriptor neither constructs compute nor executes a command.
const execCommand = codexExecCommandTool(undefined);
const text = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const image = Type.Object({
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
});
const reasoning = Type.Object({
    type: Type.Literal("reasoning"),
    text: Type.Optional(Type.String()),
    reasoning: Type.Optional(Type.String()),
});
const callFields = {
    name: Type.String(),
    arguments: Type.String(),
    namespace: Type.Optional(Type.String()),
    incomplete: Type.Optional(Type.Boolean()),
    vendor: Type.Optional(Type.Unknown()),
};
const call = Type.Object({
    type: Type.Literal("tool_call"),
    callId: Type.String(),
    ...callFields,
    server: Type.Optional(Type.Literal(true)),
});
const result = Type.Object({
    type: Type.Literal("tool_result"),
    callId: Type.String(),
    content: Type.Array(Type.Union([text, image])),
    isError: Type.Optional(Type.Boolean()),
    incomplete: Type.Optional(Type.Boolean()),
    vendor: Type.Optional(Type.Unknown()),
});
const toolRequest = Type.Object({
    type: Type.Literal("tool_call_request"),
    name: Type.String(),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
const inputs = Type.Array(Type.Union([text, image, toolRequest]));
const outputs = Type.Array(Type.Union([text, reasoning, call, result]));
const toolMessage = Type.Object({
    role: Type.Literal("tool"),
    callId: Type.String(),
    content: Type.Array(Type.Union([text, image])),
    isError: Type.Optional(Type.Boolean()),
    vendor: Type.Optional(Type.Unknown()),
});
const sessionMessage = Type.Union([
    Type.Object({ role: Type.Literal("user"), content: inputs }),
    Type.Object({ role: Type.Literal("system"), content: inputs }),
    Type.Object({
        role: Type.Literal("agent"),
        author: Type.Object({ id: Type.String(), description: Type.String() }),
        content: Type.Array(Type.Union([text, image, reasoning])),
    }),
    Type.Object({ role: Type.Literal("assistant"), content: outputs }),
    toolMessage,
    Type.Object({
        role: Type.Literal("compaction"),
        content: Type.Union([Type.Null(), Type.String()]),
        encryptedContent: Type.Union([Type.Null(), Type.String()]),
        vendor: Type.Optional(Type.Unknown()),
    }),
]);
const schemas = {
    instructions: documentBodySchema,
    security: securityDocumentBodySchema,
    cursor: eventIdSchema,
    appendEvent: appendEventInputSchema,
    eventLimitText: Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 5 }),
    eventLimit: Type.Integer({ minimum: 1, maximum: 10_000 }),
    historyQuery: Type.Object({
        before: Type.Optional(cuid2Schema),
        after: Type.Optional(cuid2Schema),
        limit: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 3 })),
        omitToolData: Type.Optional(Type.Union([Type.Literal("true"), Type.Literal("false")])),
    }),
    historyLimit: Type.Integer({ minimum: 1, maximum: 500 }),
    execCommand: execCommand.parameters,
    cuid2: cuid2Schema,
    agentConfig: agentConfigSchema,
    agentCreate: agentCreateBodySchema,
    agentSend: messageSendBodySchema,
    agentMode: agentModeSchema,
    permissionMode: agentPermissionModeSchema,
    historyMessage: historyMessageSchema,
    usageRecord: usageRecordSchema,
    usageContext: usageCurrentContextSchema,
    usageBreakdown: usageRunBreakdownSchema,
    owed: Type.Object({
        stage: Type.Union([
            Type.Literal("inference"),
            Type.Literal("tools"),
            Type.Literal("compaction"),
            Type.Literal("settlement"),
        ]),
        loopId: cuid2Schema,
        turnId: Type.Optional(cuid2Schema),
        inferenceId: Type.Optional(cuid2Schema),
        settlementId: Type.Optional(cuid2Schema),
    }),
    sessionMessage,
    pendingCall: Type.Object({
        id: cuid2Schema,
        call: Type.Object({ type: Type.Literal("tool_call"), ...callFields }),
        committed: Type.Optional(toolMessage),
    }),
    privateRecord: Type.Union([
        Type.Object({
            type: Type.Literal("user"),
            id: cuid2Schema,
            message: sessionMessage,
            metadata: Type.Optional(Type.Unknown()),
        }),
        Type.Object({
            type: Type.Literal("block"),
            id: Type.Optional(cuid2Schema),
            block: Type.Union([text, image, reasoning, call, result]),
        }),
        Type.Object({ type: Type.Literal("tool"), id: cuid2Schema, message: toolMessage }),
        Type.Object({ type: Type.Literal("system"), message: sessionMessage }),
        Type.Object({
            type: Type.Literal("compaction"),
            contextToolIds: Type.Array(Type.Tuple([cuid2Schema, Type.String()])),
            messages: Type.Array(sessionMessage),
        }),
    ]),
    activeRun: Type.Object(
        {
            activeIndex: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
            activeKind: Type.Union([
                Type.Literal("reasoning"),
                Type.Literal("text"),
                Type.Literal("tool"),
                Type.Null(),
            ]),
            argumentBuffers: Type.Record(Type.String(), Type.String()),
            blocks: Type.Array(Type.Unknown()),
            acceptedMessageIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
                maxItems: 512,
            }),
            callIndexes: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
            errorMessage: Type.Optional(Type.String({ maxLength: 8192 })),
            inferenceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            runId: Type.String({ minLength: 1, maxLength: 256 }),
            hasProviderEvent: Type.Boolean(),
            stopReason: Type.Union([
                Type.Literal("aborted"),
                Type.Literal("error"),
                Type.Literal("length"),
                Type.Literal("stop"),
            ]),
            text: Type.String(),
        },
        { additionalProperties: false },
    ),
};
writeFileSync(
    new URL("../sources/product/request_schemas.json", import.meta.url),
    `${JSON.stringify(
        schemas,
        (_key, value) => {
            // TypeBox emits Draft-7 tuples while its contains bounds use newer
            // keywords. Preserve tuple semantics in the native Draft-2020 evaluator.
            if (value && typeof value === "object" && Array.isArray(value.items)) {
                const { items, additionalItems, ...rest } = value;
                return { ...rest, prefixItems: items, items: additionalItems ?? false };
            }
            return value;
        },
        2,
    )}\n`,
);
writeFileSync(
    new URL("../sources/product/tool_definitions.json", import.meta.url),
    `${JSON.stringify({ codex: [{ name: execCommand.name, description: execCommand.description, parameters: execCommand.parameters, defer: execCommand.defer }] }, null, 2)}\n`,
);
