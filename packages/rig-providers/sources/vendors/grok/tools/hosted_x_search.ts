import type { SessionTool } from "@/core/SessionTool.js";

/**
 * X (Twitter) search, executed by Grok's own backend inside a single response.
 *
 * Declaring it is the whole integration: Grok picks the sub-call it wants — keyword or semantic
 * search — runs it upstream, and answers with the posts already cited. Rig never sees a tool it
 * has to execute, which is why this carries no parameters.
 */
export const hosted_x_search = {
    name: "x_search",
    type: "cloud",
} as const satisfies SessionTool;
