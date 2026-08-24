import type { SessionTool } from "@/core/SessionTool.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";
import type { NamespaceTool, Tool } from "openai/resources/responses/responses.js";

export function toCodexToolDefinitions(
    tools: readonly SessionTool[],
    options: { includeDeferred?: boolean } = {},
): Tool[] {
    for (const tool of tools) assertCodexToolSearchDefinition(tool);
    // Discovery is selected by the explicit provider-native descriptor supplied by the caller.
    // Without it, deferred tools are ordinary eager tools so a provider that does not support
    // discovery still receives the complete catalog.
    const discoveryEnabled =
        options.includeDeferred === true || tools.some(isCodexToolSearchDefinition);
    const nativeNamespaceDescriptions = new Map([
        ["image_gen", "Tools in the image_gen namespace."],
        ["collaboration", "Tools for spawning and managing sub-agents."],
    ]);
    const output: Tool[] = [];
    const namespaces = new Map<string, NamespaceTool>();

    for (const tool of tools) {
        const definition = toCodexTool(tool, discoveryEnabled);
        // A server descriptor is already provider-native and stays top-level. Its SessionTool
        // namespace is the caller-facing identity Base uses for policy, not an OpenAI namespace
        // wrapper around the native server tool.
        if (tool.namespace === undefined || tool.server !== undefined) {
            output.push(definition);
            continue;
        }
        let namespace = namespaces.get(tool.namespace);
        if (namespace === undefined) {
            namespace = {
                type: "namespace",
                name: tool.namespace,
                description:
                    tool.namespaceDescription ??
                    nativeNamespaceDescriptions.get(tool.namespace) ??
                    `Tools in the ${humanizeNamespace(tool.namespace)} namespace.`,
                tools: [],
            };
            namespaces.set(tool.namespace, namespace);
            output.push(namespace);
        }
        if (definition.type !== "function" && definition.type !== "custom") {
            throw new Error(
                `Namespaced Codex tool '${tool.namespace}.${tool.name}' must be a function or custom tool.`,
            );
        }
        namespace.tools.push(definition);
    }
    return output;
}

function humanizeNamespace(namespace: string): string {
    return namespace.replaceAll("_", " ");
}

function toCodexTool(tool: SessionTool, discoveryEnabled: boolean): Tool {
    if (tool.server !== undefined) {
        const server = structuredClone(tool.server) as Tool & {
            parameters?: unknown;
            input_schema?: unknown;
        };
        if (server.parameters && typeof server.parameters === "object") {
            server.parameters = toLlmParametersSchema(server.parameters as any);
        }
        if (server.input_schema && typeof server.input_schema === "object") {
            server.input_schema = toLlmParametersSchema(server.input_schema as any);
        }
        return server;
    }
    if (tool.grammar !== undefined) {
        return {
            type: "custom",
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            format: { type: "grammar", syntax: "lark", definition: tool.grammar.grammar },
        };
    }
    return {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        strict: false,
        ...(discoveryEnabled && tool.defer === true ? { defer_loading: true } : {}),
        parameters: tool.parameters === undefined ? null : toLlmParametersSchema(tool.parameters),
    };
}

export function isCodexToolSearchDefinition(tool: SessionTool): boolean {
    return tool.server?.type === "tool_search";
}

function assertCodexToolSearchDefinition(tool: SessionTool): void {
    if (!isCodexToolSearchDefinition(tool)) return;
    const execution = tool.server?.execution;
    if (execution === undefined || execution === "client" || execution === "server") return;
    throw new Error("Codex tool_search execution must be 'client' or 'server'.");
}
