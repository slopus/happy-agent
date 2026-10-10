// Build-time capture of Source's daemon-lifetime process projection.
// Native execution consumes the captured TypeBox schemas, never this module.
import {
    computeProcessSchema,
    computeProcessChangesSchema,
    computeProcessEventSchema,
} from "../../../../happy-agent-modules/sources/compute/ComputeProcess.ts";
import { assembleComputeTools } from "../../../../happy-agent-modules/sources/compute/tools/assembleComputeTools.ts";
import { assembleReviewerTools } from "../../../../happy-agent-modules/sources/compute/tools/assembleReviewerTools.ts";
import { computeFileDiffPresentationSchema } from "../../../../happy-agent-modules/sources/compute/ComputeToolPresentation.ts";
import {
    computeToolSelectionSchema,
    computeToolVendorSchema,
} from "../../../../happy-agent-modules/sources/compute/ComputeToolVendor.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
import {
    runnerMethods,
    runnerEvents,
} from "../../../../happy-agent-compute/sources/runner/runnerProtocol.ts";
import { computePermissionsSchema } from "../../../../happy-agent-compute/sources/ComputePermissions.ts";
import { agentComputeConfigSchema } from "../../../../happy-agent-modules/sources/compute/ComputeModule.ts";
import { createRequire } from "node:module";
const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");

// Factory construction reads only the platform kind. No execution, discovery,
// credentials, filesystem access or JavaScript runtime is part of the daemon.
const sourceCompute = { kind: "host" };
export const computeTools = Object.fromEntries(
    ["codex", "claude", "grok", "kimi", "glm"].map((vendor) => [
        vendor,
        assembleComputeTools(vendor, sourceCompute, undefined),
    ]),
);
export const computeReviewerTools = Object.fromEntries(
    ["codex", "claude", "grok", "kimi", "glm"].map((vendor) => [
        vendor,
        assembleReviewerTools(vendor, sourceCompute, undefined),
    ]),
);
const readLog = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/impl/FileReadLog.ts", import.meta.url),
    ["fileReadLogSchema"],
);
const kimiTask = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/compute/tools/kimi/impl/kimiTaskResult.ts",
        import.meta.url,
    ),
    ["taskIdSchema"],
);

export const computeProcessSchemas = {
    computeProcess: computeProcessSchema,
    computeProcessChanges: computeProcessChangesSchema,
    computeProcessEvent: computeProcessEventSchema,
    computeFileReadLog: readLog.fileReadLogSchema,
    computeFileDiffPresentation: computeFileDiffPresentationSchema,
    computeToolSelection: computeToolSelectionSchema,
    computeToolVendor: computeToolVendorSchema,
    computeKimiTaskId: kimiTask.taskIdSchema,
    // Claude and Grok's original handle parsers use this decimal spelling;
    // numeric bounds are checked through Source's commandSessionId schema.
    computeDecimalTaskId: Type.String({ pattern: "^[0-9]+$" }),
    computeToolMetadata: Type.Object(
        {
            name: Type.String(),
            durable: Type.Boolean(),
            reloadable: Type.Boolean(),
            steerable: Type.Boolean(),
            autoPermissionInstructions: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
    computeAgentConfiguration: agentComputeConfigSchema,
    computeRunnerPermissions: computePermissionsSchema,
    computeRegexRequest: Type.Union([
        Type.Object(
            {
                kind: Type.Literal("init"),
                pattern: Type.String({ maxLength: 65536 }),
                ignoreCase: Type.Boolean(),
                multiline: Type.Boolean(),
                countOccurrences: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
        Type.Object(
            {
                kind: Type.Literal("file"),
                content: Type.String({ maxLength: 1000000 }),
                budget: Type.Integer({ minimum: 0, maximum: 4000000 }),
            },
            { additionalProperties: false },
        ),
    ]),
    computeRegexResponse: Type.Union([
        Type.Object({ ready: Type.Literal(true) }, { additionalProperties: false }),
        Type.Object({ error: Type.String({ maxLength: 8192 }) }, { additionalProperties: false }),
        Type.Object(
            {
                matchingLineNumbers: Type.Array(Type.Integer({ minimum: 0, maximum: 1000000 }), {
                    maxItems: 10000,
                }),
                totalMatches: Type.Integer({ minimum: 0, maximum: 4000000 }),
                remainingBudget: Type.Integer({ minimum: 0, maximum: 4000000 }),
                incomplete: Type.Boolean(),
                exhausted: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
    ]),
};
for (const [method, definition] of Object.entries(runnerMethods)) {
    computeProcessSchemas[`ownerRunnerParams_${method.replaceAll(".", "_")}`] = definition.params;
    computeProcessSchemas[`ownerRunnerResult_${method.replaceAll(".", "_")}`] = definition.result;
}
for (const [event, definition] of Object.entries(runnerEvents)) {
    computeProcessSchemas[`ownerRunnerEvent_${event.replaceAll(".", "_")}`] = definition;
}
for (const [vendor, tools] of Object.entries(computeTools)) {
    for (const tool of tools) {
        computeProcessSchemas[`computeTool_${vendor}_${tool.name}`] = tool.parameters;
        computeProcessSchemas[`computeResult_${vendor}_${tool.name}`] = tool.returnType;
    }
}
