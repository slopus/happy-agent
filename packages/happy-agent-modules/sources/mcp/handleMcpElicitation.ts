import { randomUUID } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    mcpContextSchema,
    mcpElicitationRequestSchema,
    mcpElicitationResultSchema,
    mcpUserInputRequestSchema,
    mcpUserInputResponseSchema,
    type McpElicitationRequest,
    type McpElicitationResult,
    type McpUserInputRequest,
    type McpUserInputResponse,
} from "./Mcp.js";

export const mcpUserInputServiceSchema = Type.Object(
    {
        request: Type.Union([
            Type.Function([mcpUserInputRequestSchema], Type.Promise(mcpUserInputResponseSchema)),
            Type.Function(
                [mcpContextSchema, mcpUserInputRequestSchema],
                Type.Promise(mcpUserInputResponseSchema),
            ),
        ]),
    },
    { additionalProperties: false },
);
export type McpUserInputService = Static<typeof mcpUserInputServiceSchema>;

/**
 * Adapt MCP's schema-shaped elicitation request to the ordinary user-input surface. If no
 * user-input service is supplied, the safe MCP response is decline.
 */
export function handleMcpElicitation(
    request: McpElicitationRequest,
    userInput: McpUserInputService | undefined,
): Promise<McpElicitationResult>;
export function handleMcpElicitation(
    ctx: Context,
    request: McpElicitationRequest,
    userInput: McpUserInputService | undefined,
): Promise<McpElicitationResult>;
export async function handleMcpElicitation(
    first: Context | McpElicitationRequest,
    second: McpElicitationRequest | McpUserInputService | undefined,
    third?: McpUserInputService,
): Promise<McpElicitationResult> {
    const request = Value.Check(mcpElicitationRequestSchema, first)
        ? first
        : (second as McpElicitationRequest);
    const ctx = Value.Check(mcpElicitationRequestSchema, first) ? undefined : first;
    const userInput = Value.Check(mcpElicitationRequestSchema, first)
        ? (second as McpUserInputService | undefined)
        : third;
    if (!Value.Check(mcpElicitationRequestSchema, request)) return { action: "decline" };
    if (userInput === undefined) return { action: "decline" };

    const { message, requestedSchema } = request.params;
    const entries = Object.entries(requestedSchema.properties);
    const valuesByLabel = new Map<string, Map<string, string | number | boolean>>();
    /** Properties whose allowed values the server declared, and which no other answer satisfies. */
    const declaredChoiceIds = new Set<string>();
    const questions: McpUserInputRequest["questions"][number][] = entries.map(([id, property]) => {
        const record = asRecord(property);
        const declaredChoices = declaredChoicesFor(record);
        if (declaredChoices !== undefined) declaredChoiceIds.add(id);
        const enumValues = declaredChoices ?? booleanChoicesFor(record);
        const enumNames = enumNamesFor(record, enumValues);
        valuesByLabel.set(
            id,
            new Map(enumValues.map((value, index) => [String(enumNames[index] ?? value), value])),
        );
        const required = requestedSchema.required?.includes(id) === true;
        const rawTitle = typeof record?.title === "string" ? record.title.trim() : id;
        const header = rawTitle.length > 12 ? `${rawTitle.slice(0, 11).trimEnd()}…` : rawTitle;
        const propertyDescription =
            typeof record?.description === "string" ? record.description : undefined;
        const propertyType = typeof record?.type === "string" ? record.type : undefined;
        return {
            header: header.length === 0 ? "MCP request" : header,
            id,
            multiSelect: propertyType === "array",
            options: enumValues.map((value, index) => ({
                label: String(enumNames[index] ?? value),
                description:
                    propertyDescription ??
                    (propertyType === "boolean"
                        ? `Answer ${String(enumNames[index] ?? value)}.`
                        : `Use ${String(value)}.`),
            })),
            question: propertyDescription ?? message,
            ...(required ? { required: true } : {}),
        };
    });

    let response: McpUserInputResponse;
    if (questions.length === 0) {
        response = await requestUserInput(userInput, ctx, {
            requestId: `mcp:${randomUUID()}`,
            questions: [
                {
                    header: "MCP request",
                    id: "confirmation",
                    multiSelect: false,
                    options: [
                        {
                            label: "Continue",
                            description: "Accept this request without providing additional values.",
                        },
                        { label: "Decline", description: "Reject this request." },
                    ],
                    question: message,
                },
            ],
        });
        if (
            !Value.Check(mcpUserInputResponseSchema, response) ||
            response.status !== "answered" ||
            response.answers?.confirmation?.includes("Continue") !== true
        ) {
            return { action: "decline" };
        }
        return { action: "accept", content: {} };
    }

    response = await requestUserInput(userInput, ctx, {
        requestId: `mcp:${randomUUID()}`,
        questions,
    });
    if (!Value.Check(mcpUserInputResponseSchema, response) || response.status !== "answered") {
        return { action: "decline" };
    }

    const content: Record<string, string | number | boolean | Array<string | number | boolean>> =
        {};
    for (const [id, property] of entries) {
        const record = asRecord(property);
        const answers = response.answers?.[id] ?? [];
        const labels = valuesByLabel.get(id);
        /*
         * A server that declared the values it accepts gets one of those values back or nothing at
         * all.  An answer that matches no offered label is not a choice the server described, so
         * the whole request is declined rather than passing an invented value through.
         */
        if (declaredChoiceIds.has(id) && answers.some((answer) => labels?.has(answer) !== true)) {
            return { action: "decline" };
        }
        const normalized = answers.map((answer) => labels?.get(answer) ?? answer);
        const propertyType = typeof record?.type === "string" ? record.type : undefined;
        const raw = propertyType === "array" ? normalized : normalized[0];
        if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
            if (requestedSchema.required?.includes(id) === true) return { action: "decline" };
            continue;
        }
        if (propertyType === "boolean" && typeof raw === "string") {
            if (raw !== "true" && raw !== "false") return { action: "decline" };
            content[id] = raw === "true";
        } else if (
            (propertyType === "number" || propertyType === "integer") &&
            typeof raw === "string"
        ) {
            const number = Number(raw);
            if (!Number.isFinite(number)) return { action: "decline" };
            // An integer property means a whole number; 1.5 replicas is not a value to hand back.
            if (propertyType === "integer" && !Number.isInteger(number)) {
                return { action: "decline" };
            }
            content[id] = number;
        } else if (Array.isArray(raw)) {
            // Selections keep the type the server declared them with, so a numeric choice comes
            // back as the number it was rather than as its label.
            content[id] = [...raw];
        } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
            content[id] = raw;
        } else {
            return { action: "decline" };
        }
    }
    const result = { action: "accept" as const, content };
    if (!Value.Check(mcpElicitationResultSchema, result)) return { action: "decline" };
    return result;
}

async function requestUserInput(
    userInput: McpUserInputService,
    ctx: Context | undefined,
    request: McpUserInputRequest,
): Promise<McpUserInputResponse> {
    /*
     * A service may bind itself to an agent context (one-argument request) or expose a
     * context-aware adapter (two-argument request).
     */
    const raw = await Reflect.apply(
        userInput.request,
        userInput,
        userInput.request.length <= 1 || ctx === undefined ? [request] : [ctx, request],
    );
    if (!Value.Check(mcpUserInputResponseSchema, raw)) {
        return { status: "cancelled" };
    }
    return raw;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * The values the server said it accepts, or nothing when it named none.
 *
 * The distinction matters when the answer comes back: a declared set is the complete list of
 * acceptable values, while a property with no declared set is parsed by its type instead.
 */
function declaredChoicesFor(
    record: Record<string, unknown> | undefined,
): Array<string | number | boolean> | undefined {
    if (Array.isArray(record?.enum)) return record.enum.filter(isPrimitive);
    if (Array.isArray(record?.oneOf)) {
        return record.oneOf
            .map(asRecord)
            .map((item) => item?.const)
            .filter(isPrimitive);
    }
    const items = asRecord(record?.items);
    if (record?.type === "array" && Array.isArray(items?.enum)) {
        return items.enum.filter(isPrimitive);
    }
    if (record?.type === "array" && Array.isArray(items?.anyOf)) {
        return items.anyOf
            .map(asRecord)
            .map((item) => item?.const)
            .filter(isPrimitive);
    }
    return undefined;
}

/** Yes and no, which this module offers itself rather than reading from the server's schema. */
function booleanChoicesFor(
    record: Record<string, unknown> | undefined,
): Array<string | number | boolean> {
    return record?.type === "boolean" ? ["true", "false"] : [];
}

function enumNamesFor(
    record: Record<string, unknown> | undefined,
    values: readonly (string | number | boolean)[],
): readonly unknown[] {
    if (Array.isArray(record?.enumNames)) return record.enumNames;
    if (Array.isArray(record?.oneOf)) {
        return record.oneOf.map(asRecord).map((item) => item?.title ?? undefined);
    }
    const items = asRecord(record?.items);
    if (record?.type === "array" && Array.isArray(items?.anyOf)) {
        return items.anyOf.map(asRecord).map((item) => item?.title ?? undefined);
    }
    if (record?.type === "boolean") return ["Yes", "No"];
    return values;
}

function isPrimitive(value: unknown): value is string | number | boolean {
    return (
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
    );
}
