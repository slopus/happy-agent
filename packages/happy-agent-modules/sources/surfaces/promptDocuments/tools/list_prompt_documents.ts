import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { promptDocumentListSchema } from "../PromptDocument.js";
import type { SurfacesModule } from "../../SurfacesModule.js";
import { formatPromptDocuments } from "./promptDocumentToolOutput.js";

/** Read the installation's important documents with their marking details. */
export function listPromptDocumentsTool(surfaces: SurfacesModule, actingAgentId: string) {
    return defineAgentTool({
        name: "list_prompt_documents",
        defer: true,
        capabilities: ["List, mark, and unmark this installation's important documents."],
        searchKeywords: [
            "important documents",
            "prompt documents",
            "system prompt documents",
            "standing guidance",
        ],
        description:
            "List the document Surfaces marked as important for every agent on this Happy Agent installation, in the order agents see them, with each description, name, and when it was marked. Includes marked Surfaces that can no longer be read, which agents do not see. Only active admin bots may use it.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: promptDocumentListSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await surfaces.listPromptDocuments(ctx, actingAgentId),
        toLLM: (result) => [{ type: "text", text: formatPromptDocuments(result.documents) }],
    });
}
