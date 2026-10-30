import type { PromptDocument } from "./PromptDocument.js";

/** The section every agent reads, or nothing when the installation lists no readable document. */
export function formatPromptDocumentsInstructions(documents: readonly PromptDocument[]): string {
    if (documents.length === 0) return "";
    const rows = documents.map(
        (document) =>
            `  <document>\n    <name>${escapeXml(document.displayName)}</name>\n    <description>${escapeXml(document.description)}</description>\n    <surface_id>${document.surfaceId}</surface_id>\n    <link>${escapeXml(document.link)}</link>\n  </document>`,
    );
    return [
        "# Important documents",
        "",
        "The admins of this installation keep these shared documents as standing guidance for every agent: how work is done here and what to do. Treat them as part of your instructions; they live outside this prompt so people can keep them current.",
        "Before you act on a task, read every document whose description matches it with read_document, passing its surface_id, and follow what it says. Search for read_document by name if it is not loaded yet.",
        "Read a document again whenever later work touches it. People edit these documents while you work, so an earlier reading may be out of date.",
        "When a document conflicts with the user's direct request, follow the user and tell them about the conflict. When a document cannot be read, say so and continue with your best judgment.",
        "",
        "<important_documents>",
        ...rows,
        "</important_documents>",
    ].join("\n");
}

function escapeXml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
