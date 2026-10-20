import {
    formatHappyReferenceTag,
    happyReferencePlaceholder,
    parseHappyReferences,
    renderHappyFileLinksAsText,
    renderHappyReferencesAsMarkdown,
    replaceHappyReferences,
    type HappyReference,
} from "@slopus/happy-agent-client";

import type { HappySessionProtocolMessage } from "./HappyProtocol.js";

/**
 * Replaces the reference tags and file links in what the agent said with plain words, because the
 * phone cannot open them: each tag becomes its entity's current name, or the shared placeholder
 * when `label` has none, and each `happy-file` link becomes its label. Only the agent's own text,
 * service notices, and the descriptions of its tool calls carry them; user input and tool output
 * are relayed as they are. Each distinct reference is resolved once, one at a time, so the lookups
 * can share the caller's transaction.
 */
export async function renderHappyMessageReferences(
    messages: readonly HappySessionProtocolMessage[],
    label: (reference: HappyReference) => Promise<string | undefined>,
): Promise<HappySessionProtocolMessage[]> {
    const labels = new Map<string, string | undefined>();
    /** Resolves the text's tags into `labels`, and says whether it had any. */
    const resolve = async (text: string): Promise<boolean> => {
        if (!text.includes("<happy-")) return false;
        let tagged = false;
        for (const segment of parseHappyReferences(text)) {
            if (segment.type !== "reference") continue;
            tagged = true;
            const key = formatHappyReferenceTag(segment.reference);
            if (!labels.has(key)) labels.set(key, await label(segment.reference));
        }
        return tagged;
    };
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
                ? replaceHappyReferences(
                      ev.description,
                      (reference) =>
                          labels.get(formatHappyReferenceTag(reference)) ??
                          happyReferencePlaceholder(reference),
                  )
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
        let text = renderHappyFileLinksAsText(ev.text);
        if (await resolve(text)) {
            text = renderHappyReferencesAsMarkdown(text, (reference) =>
                labels.get(formatHappyReferenceTag(reference)),
            );
        }
        rendered.push(
            text === ev.text
                ? message
                : { ...message, content: { ...content, ev: { ...ev, text } } },
        );
    }
    return rendered;
}
