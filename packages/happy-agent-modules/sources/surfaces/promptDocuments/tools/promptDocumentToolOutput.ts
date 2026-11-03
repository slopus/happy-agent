import type { Static } from "@sinclair/typebox";
import type { tabPromptDocumentSchema } from "./tabPromptDocument.js";

/** The list as an admin bot reads it back: each document's identity, words, and when it was marked. */
export function formatPromptDocuments(
    documents: readonly Static<typeof tabPromptDocumentSchema>[],
): string {
    if (documents.length === 0) return "This installation has no important documents.";
    return [
        "Important documents, in the order every agent sees them:",
        ...documents.map((document) =>
            [
                `- ${JSON.stringify(document.displayName)} (tabId ${document.tabId}, ${document.link})`,
                `  Description: ${document.description}`,
                `  Name: ${document.name === null ? "the Tab's own" : "given when marked"}`,
                `  Marked ${new Date(document.markedAt).toISOString()} by agent ${document.markedByAgentId}`,
                ...(document.readable
                    ? []
                    : [
                          "  Unavailable: the Tab is missing or no longer a document, so agents do not see it. Unmark it.",
                      ]),
            ].join("\n"),
        ),
    ].join("\n");
}
