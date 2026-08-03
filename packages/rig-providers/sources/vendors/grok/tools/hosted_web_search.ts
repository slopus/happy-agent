import type { SessionTool } from "@/core/SessionTool.js";

/**
 * Web search, executed by Grok's own backend inside a single response.
 *
 * Distinct from the captured `web_search` function tool, which is how CLI 0.2.111 asked the
 * client to search. Current Grok runs the search upstream and returns cited results directly.
 */
export const hosted_web_search = {
    name: "web_search",
    type: "cloud",
} as const satisfies SessionTool;
