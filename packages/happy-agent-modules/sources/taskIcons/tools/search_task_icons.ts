import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import {
    searchTaskIcons,
    taskIconCandidateSchema,
    taskIconQuerySchema,
} from "../searchTaskIcons.js";
import type { TaskIconsModule } from "../TaskIconsModule.js";

export function searchTaskIconsTool(icons: TaskIconsModule, agentId: string) {
    return defineAgentTool({
        name: "search_task_icons",
        // Loaded with the task's tools: its instructions ask it to choose an icon early.
        defer: false,
        capabilities: ["Search the bundled topic icons for this task's icon."],
        description:
            "Search the topic icon catalog by subject, object, or related words. Returns up to ten BM25-ranked candidates with stable slugs, labels, descriptions, categories, and scores. Choose the best fitting candidate yourself; refine the query if none fits. Use a returned slug when setting your topic icon.",
        parameters: Type.Object({ query: taskIconQuerySchema }, { additionalProperties: false }),
        returnType: Type.Object({ icons: Type.Array(taskIconCandidateSchema, { maxItems: 10 }) }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { query }) => {
            await icons.assertEligible(ctx, agentId);
            return { icons: searchTaskIcons(query) };
        },
        toLLM: (candidates) => [{ type: "text", text: JSON.stringify(candidates) }],
    });
}
