import { Type } from "@sinclair/typebox";
import { networkToolPermission } from "../../../runtime/networkToolPermission.js";

import { defineTool } from "../../types.js";
import { quoteVisibleExact } from "../../../permissions/quoteVisibleExact.js";
import {
    applyPromptToMarkdown,
    MAX_WEB_FETCH_MARKDOWN_LENGTH,
} from "../../../tools/claude/webFetch/applyPromptToMarkdown.js";
import { getUrlMarkdownContent } from "../../../tools/claude/webFetch/getUrlMarkdownContent.js";
import { isPreapprovedWebFetchUrl } from "../../../tools/claude/webFetch/isPreapprovedWebFetchUrl.js";
import type { WebFetchResponse } from "../../../tools/claude/webFetch/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import { selectClaudeWebToolModel } from "../../../tools/claude/selectClaudeWebToolModel.js";

const CLAUDE_WEB_FETCH_DESCRIPTION = `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check whether the URL points to an authenticated service such as Google Docs, Confluence, Jira, or GitHub. If so, look for a specialized MCP tool that provides authenticated access.

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content and converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead, as it may have fewer restrictions.
  - The URL must be a fully formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify project files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will provide the redirect URL. Make a new WebFetch request with that URL to continue.
  - For GitHub URLs, prefer using the gh CLI through Bash, such as gh pr view, gh issue view, or gh api.`;

const claudeWebFetchReturnSchema = Type.Object({
    bytes: Type.Number({ description: "Size of the fetched content in bytes" }),
    code: Type.Number({ description: "HTTP response code" }),
    codeText: Type.String({ description: "HTTP response status text" }),
    result: Type.String({ description: "Processed result from the fetched content" }),
    durationMs: Type.Number({ description: "Time taken to fetch and process the content" }),
    url: Type.String({ description: "The URL that was fetched" }),
});

export interface ClaudeWebFetchDependencies {
    fetchPage?: (url: string, signal?: AbortSignal) => Promise<WebFetchResponse>;
    applyPrompt?: (
        prompt: string,
        markdown: string,
        provider: Provider,
        model: Model,
        signal: AbortSignal | undefined,
        isPreapprovedDomain: boolean,
    ) => Promise<string>;
    now?: () => number;
}

export function createClaudeWebFetchTool(dependencies: ClaudeWebFetchDependencies = {}) {
    const fetchPage = dependencies.fetchPage ?? getUrlMarkdownContent;
    const applyPrompt = dependencies.applyPrompt ?? applyPromptToMarkdown;
    const now = dependencies.now ?? Date.now;

    return defineTool({
        name: "WebFetch",
        label: "WebFetch",
        description: CLAUDE_WEB_FETCH_DESCRIPTION,
        arguments: Type.Object(
            {
                url: Type.String({ description: "The URL to fetch content from" }),
                prompt: Type.String({ description: "The prompt to run on the fetched content" }),
            },
            { additionalProperties: false },
        ),
        returnType: claudeWebFetchReturnSchema,
        ...networkToolPermission,
        describeAutoPermissionAction: ({ url }) =>
            `fetching ${quoteVisibleExact(url)}. Access: network access outside Rig’s shell sandbox`,
        execute: async ({ url, prompt }, _context, execution) => {
            try {
                new URL(url);
            } catch {
                throw new Error(`Invalid URL: ${url}`);
            }

            const startedAt = now();
            const response = await fetchPage(url, execution.signal);
            if ("type" in response) {
                const codeText = redirectStatusText(response.statusCode);
                const result = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${codeText}

To complete your request, use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`;
                return {
                    bytes: Buffer.byteLength(result),
                    code: response.statusCode,
                    codeText,
                    result,
                    durationMs: now() - startedAt,
                    url,
                };
            }

            const isPreapproved = isPreapprovedWebFetchUrl(url);
            let result: string;
            // Match current Claude Code: trusted short Markdown is already model-ready and skips
            // auxiliary inference, while every other response is processed by the requested prompt.
            if (
                isPreapproved &&
                response.contentType.includes("text/markdown") &&
                response.content.length < MAX_WEB_FETCH_MARKDOWN_LENGTH
            ) {
                result = response.content;
            } else {
                if (execution.provider === undefined || execution.model === undefined) {
                    throw new Error("WebFetch requires the active provider and model.");
                }
                result = await applyPrompt(
                    prompt,
                    response.content,
                    execution.provider,
                    selectClaudeWebToolModel(execution.provider, execution.model),
                    execution.signal,
                    isPreapproved,
                );
            }
            if (response.persistedPath !== undefined) {
                result += `\n\n[Binary content (${response.contentType}, ${formatFileSize(response.persistedSize ?? response.bytes)}) also saved to ${response.persistedPath}]`;
            }

            return {
                bytes: response.bytes,
                code: response.code,
                codeText: response.codeText,
                result,
                durationMs: now() - startedAt,
                url,
            };
        },
        toLLM: (result) => [{ type: "text", text: result.result }],
        toUI: (result) =>
            `Received ${formatFileSize(result.bytes)} (${result.code} ${result.codeText})`,
        toSharedCall: ({ url }) => `Fetched ${url}.`,
        // Size and HTTP status are safe; the fetched page body never leaks.
        toSharedResult: (result) =>
            result.code >= 400
                ? `The fetch failed with HTTP ${result.code} ${result.codeText}.`
                : `Fetched ${formatFileSize(result.bytes)} with HTTP ${result.code} ${result.codeText}.`,
        sharedOutputDisclosable: true,
        locks: [],
    });
}

export const claudeWebFetchTool = createClaudeWebFetchTool();

function redirectStatusText(statusCode: number): string {
    if (statusCode === 301) return "Moved Permanently";
    if (statusCode === 307) return "Temporary Redirect";
    if (statusCode === 308) return "Permanent Redirect";
    return "Found";
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
