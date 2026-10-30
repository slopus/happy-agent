import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    promptDocumentChangeSchema,
    unmarkPromptDocumentInputSchema,
    type UnmarkPromptDocumentInput,
} from "../PromptDocument.js";
import type { SurfacesModule } from "../../SurfacesModule.js";
import { formatPromptDocuments } from "./promptDocumentToolOutput.js";

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
            "Stop listing a document Surface as important in every agent's instructions on this Happy Agent installation. The document itself is unchanged. Unmarking a document that is not marked changes nothing. The change applies from each agent's next turn. Only active admin bots may use it.",
        parameters: unmarkPromptDocumentInputSchema,
        returnType: promptDocumentChangeSchema,
        durable: true,
        transactional: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ surfaceId }: UnmarkPromptDocumentInput) =>
            `removing document Surface ${JSON.stringify(surfaceId)} from the important documents every agent on this Happy Agent installation is told to read and follow. Access: installation-wide agent instructions write; no filesystem access`,
        execute: async (ctx, { surfaceId }: UnmarkPromptDocumentInput) =>
            await surfaces.unmarkPromptDocument(ctx, actingAgentId, surfaceId),
        toLLM: (result) => [
            {
                type: "text",
                text: `${
                    result.changed
                        ? `Unmarked ${result.surfaceId}.`
                        : `${result.surfaceId} was not an important document.`
                }\n\n${formatPromptDocuments(result.documents)}`,
            },
        ],
    });
}
