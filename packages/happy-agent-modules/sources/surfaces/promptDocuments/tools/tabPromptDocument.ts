import { Type } from "@sinclair/typebox";
import {
    MAX_PROMPT_DOCUMENTS,
    promptDocumentSchema,
    promptDocumentChangeSchema,
    type PromptDocument,
    type PromptDocumentChange,
} from "../PromptDocument.js";
import { tabContent, tabContentSchema } from "../../tools/tabContent.js";

export const tabPromptDocumentSchema = tabContentSchema(promptDocumentSchema);
export const tabPromptDocumentListSchema = Type.Object(
    { documents: Type.Array(tabPromptDocumentSchema, { maxItems: MAX_PROMPT_DOCUMENTS }) },
    { additionalProperties: false },
);
export const tabPromptDocumentChangeSchema = Type.Object(
    {
        ...tabContentSchema(promptDocumentChangeSchema).properties,
        documents: tabPromptDocumentListSchema.properties.documents,
    },
    { additionalProperties: false },
);

export function tabPromptDocument(document: PromptDocument) {
    return { ...tabContent(document), link: `happy://tabs/${document.surfaceId}` };
}

export function tabPromptDocumentChange(change: PromptDocumentChange) {
    return { ...tabContent(change), documents: change.documents.map(tabPromptDocument) };
}
