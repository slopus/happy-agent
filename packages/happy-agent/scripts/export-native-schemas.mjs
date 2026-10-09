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
import {
    historyMessageSchema,
    historyToolArgumentsSchema,
    historyAgentIdSchema,
    historyToolResultBlockSchema,
} from "../../happy-agent-modules/sources/history/HistoryMessage.ts";
import { readAgentHistoryTool } from "../../happy-agent-modules/sources/history/tools/read_agent_history.ts";
import { selectHistoryPage } from "../../happy-agent-modules/sources/history/impl/selectHistoryPage.ts";
import { createHistoryExcerpt } from "../../happy-agent-modules/sources/history/impl/createHistoryExcerpt.ts";
import { createModelSwitchNotice } from "../../happy-agent-modules/sources/modelSwitch/impl/createModelSwitchNotice.ts";
import {
    summarizeHistory,
    historyStatsSchema,
} from "../../happy-agent-modules/sources/history/impl/summarizeHistory.ts";
import {
    foldHistorySearchText,
    historyMessageSearchParts,
} from "../../happy-agent-modules/sources/history/impl/messageMatchesHistoryFilters.ts";
import { historyPendingMessageSchema } from "../../happy-agent-modules/sources/history/HistoryRun.ts";
import {
    usageRecordSchema,
    usageCurrentContextSchema,
    usageRunBreakdownSchema,
} from "../../happy-agent-modules/sources/usage/Usage.ts";
import { codexExecCommandTool } from "../../happy-agent-modules/sources/compute/tools/codex/exec_command.ts";
import { codexWriteStdinTool } from "../../happy-agent-modules/sources/compute/tools/codex/write_stdin.ts";
import { codexKillSessionTool } from "../../happy-agent-modules/sources/compute/tools/codex/kill_session.ts";
import { agentModelCatalog } from "../../happy-agent-modules/sources/config/impl/agentCatalog.ts";
import {
    projectIdSchema,
    projectRepositoryRefSchema,
    projectStatusSchema,
    projectOrderKeySchema,
    projectTimestampSchema,
    projectVersionSchema,
} from "../../happy-agent-modules/sources/projects/Project.ts";

// Build-time reference data only; the released daemon evaluates the serialized
// TypeBox contract in Rust and does not load JavaScript.
const require = createRequire(new URL("../../happy-agent-modules/package.json", import.meta.url));
const { Type } = require("@sinclair/typebox");
const { agentConfigSchema, cuid2Schema, agentPermissionModeSchema } = await import(
    require.resolve("@slopus/happy-agent-base")
);
const { providerModelFamily, PROVIDER_MODEL_COMPATIBILITY_MATRIX } = await import(
    require.resolve("@slopus/happy-providers")
);
// The factory closes over compute only in execution/review functions. Reading
// its schema and descriptor neither constructs compute nor executes a command.
const execCommand = codexExecCommandTool(undefined);
const writeStdin = codexWriteStdinTool(undefined);
const killSession = codexKillSessionTool(undefined);
const readHistory = readAgentHistoryTool(undefined, "build-reference");
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
const modelSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 512 }),
        providerId: Type.String({ minLength: 1, maxLength: 128 }),
        name: Type.String({ minLength: 1, maxLength: 512 }),
        effortLevels: Type.Array(Type.String()),
        defaultEffort: Type.String(),
        contextWindow: Type.Integer({ minimum: 1 }),
        autoCompactWindow: Type.Integer({ minimum: 1 }),
        enabled: Type.Boolean(),
        serviceTiers: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
);
const family = Type.Union([
    Type.Literal("claude"),
    Type.Literal("codex"),
    Type.Literal("grok"),
    Type.Literal("kimi"),
    Type.Literal("glm"),
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
    historyToolName: historyToolResultBlockSchema.properties.toolName,
    writeStdin: writeStdin.parameters,
    killSession: killSession.parameters,
    unifiedExecOutput: execCommand.returnType,
    commandSessionId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    cuid2: cuid2Schema,
    agentConfig: agentConfigSchema,
    agentCreate: agentCreateBodySchema,
    agentSend: messageSendBodySchema,
    agentMode: agentModeSchema,
    permissionMode: agentPermissionModeSchema,
    historyMessage: historyMessageSchema,
    historyToolArguments: historyToolArgumentsSchema,
    historyTool: readHistory.parameters,
    historyToolResult: readHistory.returnType,
    historyAgentId: historyAgentIdSchema,
    historyExcerptBudget: Type.Integer({ minimum: 1, maximum: 200_000 }),
    historyStats: historyStatsSchema,
    historyExcerpt: Type.Object(
        {
            beginning: Type.String({ maxLength: 200_000 }),
            recent: Type.String({ maxLength: 200_000 }),
            stats: historyStatsSchema,
            statsAreSampled: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
    historyEventReference: Type.Object(
        {
            agentId: cuid2Schema,
            runId: Type.Union([cuid2Schema, Type.Null()]),
            messageId: Type.String({ minLength: 1, maxLength: 256 }),
        },
        { additionalProperties: false },
    ),
    historyPending: historyPendingMessageSchema,
    nativeCatalog: Type.Record(
        Type.Union([
            Type.Literal("codex"),
            Type.Literal("claude"),
            Type.Literal("grok"),
            Type.Literal("bedrock"),
        ]),
        Type.Array(modelSchema, { maxItems: 1000 }),
    ),
    nativeModelCompatibility: Type.Object(
        {
            families: Type.Record(Type.String(), family),
            matrix: Type.Record(
                Type.String(),
                Type.Record(Type.String(), Type.Array(family, { maxItems: 5 })),
            ),
        },
        { additionalProperties: false },
    ),
    queuedInput: Type.Object({
        id: cuid2Schema,
        message: sessionMessage,
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        options: Type.Optional(
            Type.Object({
                provider: Type.Optional(Type.String()),
                model: Type.Optional(Type.String()),
                effort: Type.Optional(Type.String()),
                serviceTier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                permissionMode: Type.Optional(agentPermissionModeSchema),
                profile: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 512 })])),
            }),
        ),
    }),
    projectScope: Type.Object({
        id: projectIdSchema,
        root: projectRepositoryRefSchema,
        status: projectStatusSchema,
        runnerId: Type.String(),
        updatedAt: projectTimestampSchema,
        version: projectVersionSchema,
    }),
    projectOrderKey: projectOrderKeySchema,
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
    `${JSON.stringify({ codex: [execCommand, writeStdin, killSession].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, defer: tool.defer })), common: [{ name: readHistory.name, description: readHistory.description, parameters: readHistory.parameters, defer: readHistory.defer }] }, null, 2)}\n`,
);
const catalogs = {};
for (const type of ["codex", "claude", "grok", "bedrock"]) {
    const provider = { type };
    if (type === "bedrock") {
        // Capture the complete curated subset independently of regional Mantle
        // availability. Each concrete route still needs its actual regional filters.
        provider.modelOverrides = Object.fromEntries(
            [
                "anthropic/opus-5-5",
                "anthropic/opus-5",
                "anthropic/sonnet-5-5",
                "anthropic/sonnet-5",
                "anthropic/fable-5-1",
                "anthropic/fable-5",
                "anthropic/opus-4-8",
            ].map((id) => [id, { transport: "runtime" }]),
        );
    }
    catalogs[type] = agentModelCatalog({ values: { providers: { [type]: provider } } });
}
writeFileSync(
    new URL("../sources/product/model_catalogs.json", import.meta.url),
    `${JSON.stringify(catalogs, null, 2)}\n`,
);
const compatibilityModels = [
    ...new Set(
        Object.values(catalogs)
            .flat()
            .map((model) => model.id)
            .concat("openai/codex-auto-review"),
    ),
];
writeFileSync(
    new URL("../sources/product/model_compatibility.json", import.meta.url),
    `${JSON.stringify({ families: Object.fromEntries(compatibilityModels.map((model) => [model, providerModelFamily(model)])), matrix: PROVIDER_MODEL_COMPATIBILITY_MATRIX }, null, 2)}\n`,
);
const handoffRecords = [
    {
        position: 0,
        message: {
            recordId: "handoffuserzero",
            role: "user",
            blocks: [{ type: "text", text: "Remember the original request." }],
        },
    },
    {
        position: 1,
        message: {
            recordId: "handoffassistantzero",
            role: "assistant",
            provider: "fixture",
            model: "openai/gpt-5.6-sol",
            blocks: [{ type: "text", text: "A prior assistant answer." }],
        },
    },
    {
        position: 2,
        message: {
            recordId: "handoffuserone",
            role: "user",
            blocks: [{ type: "text", text: "Continue with the compatible model." }],
        },
    },
    {
        position: 3,
        message: {
            recordId: "handoffassistantone",
            role: "assistant",
            provider: "fixture",
            model: "openai/gpt-5.6-luna",
            blocks: [{ type: "text", text: "Selected model completed." }],
        },
    },
];
const handoffExcerpt = createHistoryExcerpt(
    handoffRecords,
    32_000,
    summarizeHistory(handoffRecords.map((record) => record.message)),
);
const handoffNotice = createModelSwitchNotice({
    previousModel: catalogs.codex.find((model) => model.id === "openai/gpt-5.6-luna").name,
    previousProvider: "fixture",
    model: catalogs.grok.find((model) => model.id === "xai/grok-4.6").name,
    provider: "switch-fixture",
    historyTool: "read_agent_history",
    excerpt: handoffExcerpt,
});
writeFileSync(
    new URL("../tests/model_switch_goldens.json", import.meta.url),
    `${JSON.stringify({ notice: handoffNotice, excerpt: handoffExcerpt }, null, 2)}\n`,
);

// Golden results come from the original pure tool and history selector. The
// native test seeds these original archive rows, then invokes the real daemon.
const goldenRecords = [
    {
        position: 0,
        message: {
            recordId: "goldenuser",
            role: "user",
            blocks: [
                { type: "text", text: "Καλημέρα 😀" },
                { type: "tool_call_request", name: "read_file", arguments: { path: "needle.txt" } },
            ],
        },
    },
    {
        position: 2,
        message: {
            recordId: "goldenassistant",
            role: "assistant",
            provider: "fixture",
            model: "openai/gpt-5.6-sol",
            blocks: [
                { type: "thinking", thinking: "Hidden reasoning.", redacted: true },
                {
                    type: "tool_call",
                    callId: "callgoldenhistory",
                    name: "read_file",
                    arguments: { path: "needle.txt", mode: "read" },
                },
                {
                    type: "tool_result",
                    callId: "callgoldenhistory",
                    toolName: "read_file",
                    display: "Read complete.",
                    output: `begin ${"x".repeat(5000)} NeedleOnlyAtEnd`,
                },
            ],
        },
    },
    {
        position: 4,
        message: {
            recordId: "goldengenerated",
            role: "agent",
            senderAgentId: "agentsender",
            blocks: [{ type: "text", text: "Work generated by another agent." }],
        },
    },
    {
        position: 7,
        message: {
            recordId: "goldenerror",
            role: "error",
            blocks: [{ type: "text", text: "Provider failed." }],
        },
    },
    {
        position: 9,
        message: {
            recordId: "goldensystem",
            role: "system",
            blocks: [{ type: "text", text: "System-only archive content." }],
        },
    },
];
const longRecords = Array.from({ length: 9 }, (_, position) => ({
    position,
    message: {
        recordId: `longgolden${position}`,
        role: "assistant",
        blocks: Array.from({ length: 4 }, () => ({
            type: "text",
            text: `${position}${"x".repeat(11_999)}`,
        })),
    },
}));
const archives = { agentgoldensmall: goldenRecords, agentgoldenlong: longRecords };
const goldenHistory = {
    resolveTarget: async (_ctx, _requester, target) => target,
    listAgents: async (_ctx, requester, target) =>
        [requester, target].sort().map((agentId) => ({
            agentId,
            path: agentId,
            status: "unknown",
            messageCount: archives[agentId]?.length ?? 0,
        })),
    read: async (_ctx, target, query) => ({
        agentId: target,
        ...selectHistoryPage(archives[target] ?? [], query),
    }),
};
const goldenTool = readAgentHistoryTool(goldenHistory, "agentgoldenreader");
const cases = [];
for (const arguments_ of [
    { target: "agentgoldensmall", from: "begin", limit: 2 },
    { target: "agentgoldensmall", cursor: 0, limit: 2 },
    { target: "agentgoldensmall", cursor: 2, limit: 2 },
    { target: "agentgoldensmall", from: "last", limit: 1 },
    { target: "agentgoldensmall", query: "needleonlyatend", include_tools: false },
    { target: "agentgoldensmall", query: "READ_FILE", roles: ["assistant"] },
    { target: "agentgoldensmall", cursor: 30, limit: 2 },
    { target: "agentgoldensmall", query: "no matching content" },
    { target: "agentgoldensmall", query: "ΚΑΛΗΜΈΡΑ", roles: ["user"] },
    { target: "agentgoldenlong", from: "start", limit: 9 },
    { target: "agentgoldenlong", from: "end", limit: 9 },
]) {
    const { agents: _agents, ...expected } = await goldenTool.execute(
        undefined,
        arguments_,
        undefined,
    );
    cases.push({ arguments: arguments_, expected });
}
const rows = Object.entries(archives).flatMap(([agentId, records]) =>
    records.map((record) => ({
        ...record,
        agentId,
        searchText: foldHistorySearchText(historyMessageSearchParts(record.message).join("\n")),
        stats: summarizeHistory([record.message]),
    })),
);
writeFileSync(
    new URL("../tests/history_tool_goldens.json", import.meta.url),
    `${JSON.stringify({ rows, cases }, null, 2)}\n`,
);
