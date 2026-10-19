import type { AnyAgentTool } from "@slopus/happy-agent-base";

/** How deep a schema is written out before the rest is called `unknown`. */
const MAX_DEPTH = 4;

/** The longest result type written out. A larger one is declared `unknown`, as Codex does. */
const MAX_RESULT_TYPE_CHARACTERS = 1_500;

/**
 * One nested tool's declaration in Codex's own form, for example
 * `declare const tools: { exec_command(args: { cmd: string; }): Promise<{ output: string; }>; };`.
 *
 * Arguments are written out in full because the model has to get them right. The result type is
 * written out while it stays small and is otherwise `unknown`, so a tool whose structured result
 * carries a large presentation does not crowd the description.
 */
export function codexExecDeclaration(identifier: string, tool: AnyAgentTool): string {
    const input =
        tool.grammar !== undefined
            ? "input: string"
            : `args: ${tool.parameters === undefined ? "{}" : typeOf(tool.parameters, 0)}${singleStringField(tool) === undefined ? "" : " | string"}`;
    const result = typeOf(tool.returnType, 0);
    const output = result.length > MAX_RESULT_TYPE_CHARACTERS ? "unknown" : result;
    return `declare const tools: { ${identifier}(${input}): Promise<${output}>; };`;
}

/**
 * The one required string field a bare string argument stands for, when there is exactly one.
 * Codex lets a nested tool take a string; for a tool whose only required argument is a string,
 * such as a patch, that string is the argument.
 */
export function singleStringField(tool: AnyAgentTool): string | undefined {
    const parameters = tool.parameters as SchemaNode | undefined;
    if (parameters?.type !== "object" || parameters.properties === undefined) return undefined;
    const required = parameters.required ?? [];
    if (required.length !== 1) return undefined;
    const field = required[0]!;
    return parameters.properties[field]?.type === "string" ? field : undefined;
}

interface SchemaNode {
    readonly type?: string | readonly string[];
    readonly description?: string;
    readonly properties?: Readonly<Record<string, SchemaNode>>;
    readonly required?: readonly string[];
    readonly items?: SchemaNode;
    readonly anyOf?: readonly SchemaNode[];
    readonly oneOf?: readonly SchemaNode[];
    readonly const?: unknown;
    readonly enum?: readonly unknown[];
    readonly additionalProperties?: boolean | SchemaNode;
}

function typeOf(schema: unknown, depth: number): string {
    if (typeof schema !== "object" || schema === null) return "unknown";
    const node = schema as SchemaNode;
    if (depth > MAX_DEPTH) return "unknown";
    if (node.const !== undefined) return JSON.stringify(node.const);
    if (node.enum !== undefined) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
    const variants = node.anyOf ?? node.oneOf;
    if (variants !== undefined) {
        return [...new Set(variants.map((variant) => typeOf(variant, depth + 1)))].join(" | ");
    }
    if (Array.isArray(node.type)) {
        return node.type.map((type) => typeOf({ ...node, type }, depth)).join(" | ");
    }
    switch (node.type) {
        case "string":
            return "string";
        case "number":
        case "integer":
            return "number";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "undefined":
        case "void":
            return "void";
        case "array":
            return `Array<${typeOf(node.items, depth + 1)}>`;
        case "object":
            return objectType(node, depth);
        default:
            return "unknown";
    }
}

function objectType(node: SchemaNode, depth: number): string {
    const properties = Object.entries(node.properties ?? {});
    if (properties.length === 0) {
        return typeof node.additionalProperties === "object"
            ? `Record<string, ${typeOf(node.additionalProperties, depth + 1)}>`
            : "{}";
    }
    const required = new Set(node.required ?? []);
    const indent = "  ".repeat(depth + 1);
    const lines = properties.flatMap(([name, property]) => [
        ...(property.description === undefined
            ? []
            : [`${indent}// ${property.description.replaceAll(/\s*\n\s*/g, " ")}`]),
        `${indent}${name}${required.has(name) ? "" : "?"}: ${typeOf(property, depth + 1)};`,
    ]);
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}
