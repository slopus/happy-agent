import {
    happyReferencePlaceholder,
    parseHappyLinks,
    renderHappyLinksAsText,
    replaceHappyLinks,
    stripMediaLayoutBlocks,
    type HappyLinkMatch,
    type HappyReference,
} from "@slopus/happy-agent-client";

import type { HappySessionProtocolMessage } from "./HappyProtocol.js";

/**
 * Replaces the Happy links in what the agent said with plain words, because the phone cannot open
 * them: each entity link becomes its entity's current name, else the label the agent wrote, else
 * the shared placeholder, and each file link becomes its label. Legacy reference tags read as
 * entity links with no label. Media layout blocks are dropped, and a text that was only layout is
 * left out. Only the agent's own text, service notices, and the descriptions of its tool calls
 * carry them; user input and tool output are relayed as they are. Each distinct reference is
 * resolved once, one at a time, so the lookups can share the caller's transaction.
 */
export async function renderHappyMessageReferences(
    messages: readonly HappySessionProtocolMessage[],
    label: (reference: HappyReference) => Promise<string | undefined>,
): Promise<HappySessionProtocolMessage[]> {
    const labels = new Map<string, string | undefined>();
    /** Resolves the text's references into `labels`, and says whether it had any Happy link. */
    const resolve = async (text: string): Promise<boolean> => {
        let linked = false;
        for (const segment of parseHappyLinks(text)) {
            if (segment.type !== "link") continue;
            linked = true;
            if (segment.link?.type !== "reference") continue;
            const key = referenceKey(segment.link.reference);
            if (!labels.has(key)) labels.set(key, await label(segment.link.reference));
        }
        return linked;
    };
    const named = (reference: HappyReference) => labels.get(referenceKey(reference));
    const rendered: HappySessionProtocolMessage[] = [];
    for (const message of messages) {
        const { content } = message;
        const { ev } = content;
        if (content.role !== "agent") {
            rendered.push(message);
            continue;
        }
        if (ev.t === "tool-call-start") {
            // A row's description is plain words, not Markdown, so a title goes in as written.
            const description = (await resolve(ev.description))
                ? replaceHappyLinks(ev.description, (match) => plainWords(match, named))
                : ev.description;
            rendered.push(
                description === ev.description
                    ? message
                    : { ...message, content: { ...content, ev: { ...ev, description } } },
            );
            continue;
        }
        if (ev.t !== "text" && ev.t !== "service") {
            rendered.push(message);
            continue;
        }
        // Layout blocks arrange media the phone already shows in order; their HTML would show raw.
        const laidOut = ev.t === "text" ? stripMediaLayoutBlocks(ev.text) : ev.text;
        if (laidOut.trim() === "") continue;
        const text = (await resolve(laidOut)) ? renderHappyLinksAsText(laidOut, named) : laidOut;
        rendered.push(
            text === ev.text
                ? message
                : { ...message, content: { ...content, ev: { ...ev, text } } },
        );
    }
    return rendered;
}

/** The fallback's words for one link, unescaped, for a tool row's description. */
function plainWords(
    { link, label, syntax }: HappyLinkMatch,
    named: (reference: HappyReference) => string | undefined,
): string {
    if (link?.type === "reference") {
        return (
            named(link.reference) ??
            (label.trim() === "" ? happyReferencePlaceholder(link.reference) : label)
        );
    }
    if (label.trim() !== "") return label;
    if (link?.type === "file") return link.file.path;
    return syntax === "legacyTag" ? "an unavailable reference" : "";
}

function referenceKey(reference: HappyReference): string {
    return JSON.stringify([
        reference.kind,
        reference.id,
        reference.version ?? null,
        reference.workspaceId ?? null,
    ]);
}
