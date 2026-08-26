import { Value } from "@sinclair/typebox/value";

import {
    mcpPromptPageSchema,
    mcpResourcePageSchema,
    mcpResourceTemplatePageSchema,
    mcpServerPageSchema,
    mcpToolPageSchema,
    type McpPromptPage,
    type McpResourcePage,
    type McpResourceTemplatePage,
    type McpServerPage,
    type McpToolPage,
} from "./Mcp.js";

export function assertServerPage(value: unknown): asserts value is McpServerPage {
    if (!Value.Check(mcpServerPageSchema, value)) {
        throw new Error("MCP returned an invalid server page.");
    }
}

export function assertToolPage(value: unknown): asserts value is McpToolPage {
    if (!Value.Check(mcpToolPageSchema, value)) {
        throw new Error("MCP returned an invalid tool page.");
    }
}

export function assertResourcePage(value: unknown): asserts value is McpResourcePage {
    if (!Value.Check(mcpResourcePageSchema, value)) {
        throw new Error("MCP returned an invalid resource page.");
    }
}

export function assertResourceTemplatePage(
    value: unknown,
): asserts value is McpResourceTemplatePage {
    if (!Value.Check(mcpResourceTemplatePageSchema, value)) {
        throw new Error("MCP returned an invalid resource-template page.");
    }
}

export function assertPromptPage(value: unknown): asserts value is McpPromptPage {
    if (!Value.Check(mcpPromptPageSchema, value)) {
        throw new Error("MCP returned an invalid prompt page.");
    }
}
