import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    historyToolPresentationSchema,
    MAX_HISTORY_TOOL_OUTPUT_LENGTH,
    type HistoryToolPresentation,
} from "../history/index.js";
import type { ToolPermissionReview } from "../permissions/index.js";

const presentationTextSchema = Type.String({ maxLength: MAX_HISTORY_TOOL_OUTPUT_LENGTH });
const nonEmptyPresentationTextSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HISTORY_TOOL_OUTPUT_LENGTH,
});

const explorationOperationSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("list"), target: presentationTextSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("read"), name: presentationTextSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("search"),
            command: presentationTextSchema,
            query: Type.Optional(presentationTextSchema),
            path: Type.Optional(presentationTextSchema),
        },
        { additionalProperties: false },
    ),
]);

const toolPresentationSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("exploration"),
            operations: Type.Array(explorationOperationSchema, { maxItems: 64 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("exec_command"),
            command: presentationTextSchema,
            output: Type.Optional(presentationTextSchema),
        },
        { additionalProperties: false },
    ),
    historyToolPresentationSchema,
    Type.Object(
        {
            type: Type.Literal("search"),
            target: Type.Union([Type.Literal("web"), Type.Literal("x")]),
            query: presentationTextSchema,
        },
        { additionalProperties: false },
    ),
]);

type ToolPresentation = Static<typeof toolPresentationSchema>;
type ToolCallStatus = "running" | "completed" | "failed";

export interface MessageResourceOptions {
    /** Remove raw tool payloads only when the call has a complete typed presentation. */
    readonly omitToolData?: boolean;
}

export interface ToolCallProjection {
    readonly id: string;
    readonly name: string;
    readonly status: ToolCallStatus;
    readonly arguments?: unknown;
    readonly output?: string;
    readonly presentation?: HistoryToolPresentation;
    readonly elevated?: boolean;
    readonly review?: ToolPermissionReview;
}

const codexExecArgumentsSchema = Type.Object(
    { cmd: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);
const commandArgumentsSchema = Type.Object(
    { command: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);
const claudeReadArgumentsSchema = Type.Object(
    { file_path: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);
const grokReadArgumentsSchema = Type.Object(
    { target_file: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);
const pathArgumentsSchema = Type.Object(
    { path: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);
const listArgumentsSchema = Type.Object(
    { target_directory: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);
const patternArgumentsSchema = Type.Object(
    {
        pattern: nonEmptyPresentationTextSchema,
        path: Type.Optional(presentationTextSchema),
    },
    { additionalProperties: true },
);
const queryArgumentsSchema = Type.Object(
    { query: nonEmptyPresentationTextSchema },
    { additionalProperties: true },
);

/** One shared public tool-call projection used by both live events and history loads. */
export function toolCallResource(
    call: ToolCallProjection,
    options: MessageResourceOptions = {},
): Record<string, unknown> {
    const presentation = presentationForToolCall(call);
    const omitRaw = options.omitToolData === true && presentation !== undefined;
    return {
        type: "tool_call",
        id: call.id,
        name: call.name,
        status: call.status,
        ...(omitRaw ? {} : { arguments: call.arguments ?? {} }),
        ...(call.status === "running" || omitRaw ? {} : { result: { output: call.output ?? "" } }),
        ...(presentation === undefined ? {} : { presentation }),
        ...(call.elevated === undefined || call.review === undefined
            ? {}
            : { elevated: call.elevated, review: call.review }),
    };
}

function presentationForToolCall(call: ToolCallProjection): ToolPresentation | undefined {
    if (call.status === "completed" && call.presentation !== undefined) {
        const presentation = checked(historyToolPresentationSchema, call.presentation);
        if (presentation !== undefined) return presentation;
    }
    if (call.name === "exec_command") {
        const args = checked(codexExecArgumentsSchema, call.arguments);
        if (args !== undefined) return execPresentation(args.cmd, call);
    }
    if (call.name === "Bash" || call.name === "run_terminal_command") {
        const args = checked(commandArgumentsSchema, call.arguments);
        if (args !== undefined) return execPresentation(args.command, call);
    }
    if (call.name === "Read") {
        const args = checked(claudeReadArgumentsSchema, call.arguments);
        if (args !== undefined) return explorationRead(args.file_path);
    }
    if (call.name === "read_file") {
        const args = checked(grokReadArgumentsSchema, call.arguments);
        if (args !== undefined) return explorationRead(args.target_file);
    }
    if (call.name === "view_image") {
        const args = checked(pathArgumentsSchema, call.arguments);
        if (args !== undefined) return explorationRead(args.path);
    }
    if (call.name === "list_dir") {
        const args = checked(listArgumentsSchema, call.arguments);
        if (args !== undefined) {
            return {
                type: "exploration",
                operations: [{ kind: "list", target: args.target_directory }],
            };
        }
    }
    if (call.name === "Glob" || call.name === "Grep" || call.name === "grep") {
        const args = checked(patternArgumentsSchema, call.arguments);
        if (args !== undefined) {
            return {
                type: "exploration",
                operations: [
                    {
                        kind: "search",
                        command: `${call.name} ${args.pattern}`,
                        query: args.pattern,
                        ...(args.path === undefined ? {} : { path: args.path }),
                    },
                ],
            };
        }
    }
    const target = searchTarget(call.name);
    if (target !== undefined) {
        const args = checked(queryArgumentsSchema, call.arguments);
        if (args !== undefined) return { type: "search", target, query: args.query };
    }
    return undefined;
}

function execPresentation(command: string, call: ToolCallProjection): ToolPresentation {
    return {
        type: "exec_command",
        command,
        ...(call.status === "running" ? {} : { output: call.output ?? "" }),
    };
}

function explorationRead(name: string): ToolPresentation {
    return { type: "exploration", operations: [{ kind: "read", name }] };
}

function searchTarget(name: string): "web" | "x" | undefined {
    switch (name) {
        case "bedrock_web_search":
        case "claude_web_search":
        case "codex_web_search":
        case "gemini_web_search":
        case "grok_web_search":
            return "web";
        case "grok_x_search":
            return "x";
        default:
            return undefined;
    }
}

function checked<Schema extends TSchema>(
    schema: Schema,
    value: unknown,
): Static<Schema> | undefined {
    return Value.Check(schema, value) ? (value as Static<Schema>) : undefined;
}
