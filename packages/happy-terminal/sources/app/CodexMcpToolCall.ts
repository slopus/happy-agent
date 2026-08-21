export interface CodexMcpToolInvocation {
    readonly arguments?: unknown;
    readonly server: string;
    readonly tool: string;
}

export type CodexMcpToolCallStatus = "active" | "error" | "success";

export interface CodexMcpToolCall {
    readonly invocation: CodexMcpToolInvocation;
    readonly review?: string;
    readonly result?: string | readonly string[];
    readonly status: CodexMcpToolCallStatus;
}

export interface CodexMcpToolPalette {
    readonly accent: string;
    readonly error: string;
    readonly primary: string;
    readonly success: string;
}

export interface CodexMcpToolRenderOptions {
    readonly maxReviewRows?: number;
    readonly maxResultRows?: number;
    readonly palette?: CodexMcpToolPalette;
    readonly width: number;
}

export const DEFAULT_CODEX_MCP_TOOL_PALETTE: CodexMcpToolPalette = {
    accent: "\x1b[36m",
    error: "\x1b[31m",
    primary: "\x1b[39m",
    success: "\x1b[32m",
};
