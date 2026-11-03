import { defineAgentTool } from "@slopus/happy-agent-base";

import { markPromptDocumentInputSchema, MAX_PROMPT_DOCUMENTS } from "../PromptDocument.js";
import type { SurfacesModule } from "../../SurfacesModule.js";
import { formatPromptDocuments } from "./promptDocumentToolOutput.js";
import { tabContentSchema } from "../../tools/tabContent.js";
import { tabPromptDocumentChange, tabPromptDocumentChangeSchema } from "./tabPromptDocument.js";

/** Put one document Tab in every agent's instructions, or reword one already there. */
export function markPromptDocumentTool(surfaces: SurfacesModule, actingAgentId: string) {
    return defineAgentTool({
        name: "mark_prompt_document",
        defer: true,
        capabilities: ["List, mark, and unmark this installation's important documents."],
        searchKeywords: [
            "mark important document",
            "add document to system prompt",
            "prompt documents",
            "standing guidance",
        ],
        description: `Mark a document Tab as important for every agent on this Happy Agent installation. Every agent's instructions then list it with its name, link, and your description, and tell agents to read it with read_document before acting on work it covers. Write the description like a skill's: what the document covers and when an agent should read it. name is optional and replaces the Tab's own name in that list; leave it out to follow the Tab. Marking a document again replaces its description and name but keeps its place, which is ordered by when it was first marked. At most ${String(MAX_PROMPT_DOCUMENTS)} documents can be marked. The change applies from each agent's next turn. Only active admin bots may use it.`,
        parameters: tabContentSchema(markPromptDocumentInputSchema),
        returnType: tabPromptDocumentChangeSchema,
        durable: true,
        transactional: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ tabId }) =>
            `marking document Tab ${JSON.stringify(tabId)} as an important document that every agent on this Happy Agent installation is told to read and follow. Access: installation-wide agent instructions write; no filesystem access`,
        execute: async (ctx, { tabId, ...input }) =>
            tabPromptDocumentChange(
                await surfaces.markPromptDocument(ctx, actingAgentId, {
                    ...input,
                    surfaceId: tabId,
                }),
            ),
        toLLM: (result) => [
            {
                type: "text",
                text: `${
                    result.changed
                        ? `Marked ${result.tabId} as an important document.`
                        : `${result.tabId} was already marked with that name and description.`
                }\n\n${formatPromptDocuments(result.documents)}`,
            },
        ],
    });
}
