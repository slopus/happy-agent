import type { PromptDocument } from "../PromptDocument.js";

/** The list as an admin bot reads it back: each document's identity, words, and when it was marked. */
export function formatPromptDocuments(documents: readonly PromptDocument[]): string {
    if (documents.length === 0) return "This installation has no important documents.";
    return [
        "Important documents, in the order every agent sees them:",
        ...documents.map((document) =>
            [
                `- ${JSON.stringify(document.displayName)} (surfaceId ${document.surfaceId}, ${document.link})`,
                `  Description: ${document.description}`,
                `  Name: ${document.name === null ? "the Surface's own" : "given when marked"}`,
                `  Marked ${new Date(document.markedAt).toISOString()} by agent ${document.markedByAgentId}`,
                ...(document.readable
                    ? []
                    : [
                          "  Unavailable: the Surface is missing or no longer a document, so agents do not see it. Unmark it.",
                      ]),
            ].join("\n"),
        ),
    ].join("\n");
}
