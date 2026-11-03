import { defineAgentTool } from "@slopus/happy-agent-base";

import { unmarkPromptDocumentInputSchema } from "../PromptDocument.js";
import type { SurfacesModule } from "../../SurfacesModule.js";
import { formatPromptDocuments } from "./promptDocumentToolOutput.js";
import { tabContentSchema } from "../../tools/tabContent.js";
import { tabPromptDocumentChange, tabPromptDocumentChangeSchema } from "./tabPromptDocument.js";

/** Take one document out of every agent's instructions. */
export function unmarkPromptDocumentTool(surfaces: SurfacesModule, actingAgentId: string) {
    return defineAgentTool({
        name: "unmark_prompt_document",
        defer: true,
        capabilities: ["List, mark, and unmark this installation's important documents."],
        searchKeywords: [
            "unmark important document",
            "remove document from system prompt",
            "prompt documents",
        ],
        description:
            "Stop listing a document Tab as important in every agent's instructions on this Happy Agent installation. The document itself is unchanged. Unmarking a document that is not marked changes nothing. The change applies from each agent's next turn. Only active admin bots may use it.",
        parameters: tabContentSchema(unmarkPromptDocumentInputSchema),
        returnType: tabPromptDocumentChangeSchema,
        durable: true,
        transactional: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ tabId }) =>
            `removing document Tab ${JSON.stringify(tabId)} from the important documents every agent on this Happy Agent installation is told to read and follow. Access: installation-wide agent instructions write; no filesystem access`,
        execute: async (ctx, { tabId }) =>
            tabPromptDocumentChange(await surfaces.unmarkPromptDocument(ctx, actingAgentId, tabId)),
        toLLM: (result) => [
            {
                type: "text",
                text: `${
                    result.changed
                        ? `Unmarked ${result.tabId}.`
                        : `${result.tabId} was not an important document.`
                }\n\n${formatPromptDocuments(result.documents)}`,
            },
        ],
    });
}
