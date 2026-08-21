import { Type, type Static } from "@sinclair/typebox";

/**
 * Turns the conversation into the budgeted transcript the guardian reviews, ported behavior-for-
 * behavior from Happy Agent v1's `permissions/createAutoPermissionTranscript.ts`.
 *
 * Two things matter for parity and are preserved exactly. First, classification: what counts as
 * trusted user authorization versus untrusted context. Ordinary human messages are trusted; agent
 * messages, direct shell output, generated conversation summaries, tool results, and assistant
 * turns are not, and only a tool's own `trustedUserEvidence` selection is trusted user response.
 * Second, budgeting: trusted evidence is retained first, then recent untrusted messages, then
 * recent tool output, each under its own character budget, and the transcript is annotated when it
 * had to drop anything — including a marker whenever trusted user evidence did not fully survive.
 *
 * The v2 evidence archive classifies at the base hooks (where message provenance and the
 * human-owned portion of an interactive answer still exist) and stores entries in this exact
 * shape. This builder is the pure step that turns those entries — supplied as a message-shaped
 * view — into the reviewer's prompt.
 */

const autoTranscriptTextBlockSchema = Type.Object(
    {
        type: Type.Literal("text"),
        text: Type.String(),
    },
    { additionalProperties: true },
);

const autoTranscriptImageBlockSchema = Type.Object(
    {
        type: Type.Literal("image"),
    },
    { additionalProperties: true },
);

/** Blocks that appear on user and system messages, and inside a tool result's rendered content. */
const autoTranscriptContentBlockSchema = Type.Union([
    autoTranscriptTextBlockSchema,
    autoTranscriptImageBlockSchema,
]);

const autoTranscriptThinkingBlockSchema = Type.Object(
    {
        type: Type.Literal("thinking"),
        thinking: Type.String(),
    },
    { additionalProperties: true },
);

const autoTranscriptToolCallBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_call"),
        id: Type.Optional(Type.String()),
        name: Type.String(),
        arguments: Type.Unknown(),
    },
    { additionalProperties: true },
);

const autoTranscriptToolResultBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_result"),
        toolCallId: Type.Optional(Type.String()),
        toolName: Type.String(),
        rendered: Type.Array(autoTranscriptContentBlockSchema),
        display: Type.Optional(Type.String()),
        isError: Type.Optional(Type.Boolean()),
        /** Exact user-authored or user-selected content that Auto review may trust. */
        trustedUserEvidence: Type.Optional(Type.Array(autoTranscriptContentBlockSchema)),
    },
    { additionalProperties: true },
);

const autoTranscriptAgentBlockSchema = Type.Union([
    autoTranscriptTextBlockSchema,
    autoTranscriptImageBlockSchema,
    autoTranscriptThinkingBlockSchema,
    autoTranscriptToolCallBlockSchema,
    autoTranscriptToolResultBlockSchema,
]);

export const autoTranscriptMessageSchema = Type.Object(
    {
        role: Type.Union([
            Type.Literal("user"),
            Type.Literal("agent"),
            Type.Literal("system"),
            Type.Literal("error"),
            Type.Literal("compaction"),
        ]),
        id: Type.Optional(Type.String()),
        blocks: Type.Array(autoTranscriptAgentBlockSchema),
        /** Durable model context that must never be presented as transcript content. */
        internal: Type.Optional(Type.Boolean()),
        /** Durable origin for non-human messages that use a user-role provider input shape. */
        provenance: Type.Optional(Type.Literal("agent")),
        /** Whether Happy Agent retried inference, continued after a local failure, or stopped. */
        outcome: Type.Optional(
            Type.Union([
                Type.Literal("retried"),
                Type.Literal("continued"),
                Type.Literal("failed"),
            ]),
        ),
        /** Marks a display-only or system message kept out of every model-facing transcript. */
        context: Type.Optional(Type.Literal("excluded")),
    },
    { additionalProperties: true },
);

export type AutoTranscriptMessage = Static<typeof autoTranscriptMessageSchema>;
type AutoTranscriptAgentBlock = Static<typeof autoTranscriptAgentBlockSchema>;

interface TranscriptEntry {
    category: "message" | "tool";
    ordinal: number;
    text: string;
    trustedUserEvidence: boolean;
    trustedUserEvidenceTruncated: boolean;
}

export interface AutoPermissionTranscript {
    text: string;
    userEvidenceOmitted: boolean;
}

const MAX_ENTRY_CHARACTERS = 8_000;
const MAX_MESSAGE_CHARACTERS = 40_000;
const MAX_TOOL_CHARACTERS = 40_000;
const MAX_RECENT_UNTRUSTED_MESSAGES = 40;
export const AUTO_PERMISSION_USER_EVIDENCE_OMITTED =
    "[Auto permission review has incomplete user evidence]";

export function createAutoPermissionTranscript(
    messages: readonly AutoTranscriptMessage[],
): AutoPermissionTranscript {
    const entries = collectEntries(messages);
    const selected = new Set<number>();
    let messageCharacters = selectTrustedUserEvidence(entries, selected);

    const recentMessages = entries
        .filter(
            (entry) =>
                entry.category === "message" &&
                !entry.trustedUserEvidence &&
                !selected.has(entry.ordinal),
        )
        .slice(-MAX_RECENT_UNTRUSTED_MESSAGES)
        .reverse();
    for (const entry of recentMessages) {
        if (messageCharacters + entry.text.length > MAX_MESSAGE_CHARACTERS) continue;
        selected.add(entry.ordinal);
        messageCharacters += entry.text.length;
    }

    let toolCharacters = 0;
    const recentToolEntries = entries.filter((entry) => entry.category === "tool").reverse();
    for (const entry of recentToolEntries) {
        if (toolCharacters + entry.text.length > MAX_TOOL_CHARACTERS) continue;
        selected.add(entry.ordinal);
        toolCharacters += entry.text.length;
    }

    const retained = entries
        .filter((entry) => selected.has(entry.ordinal))
        .map((entry) => `[${String(entry.ordinal + 1)}] ${entry.text}`);
    const omitted = entries.length - retained.length;
    const omittedUserEvidence = entries.some(
        (entry) =>
            entry.trustedUserEvidence &&
            (!selected.has(entry.ordinal) || entry.trustedUserEvidenceTruncated),
    );
    if (omitted > 0) {
        retained.push(
            `[Context note] ${String(omitted)} transcript entr${omitted === 1 ? "y was" : "ies were"} omitted to stay within the review budget.`,
        );
    }
    if (omittedUserEvidence) retained.push(AUTO_PERMISSION_USER_EVIDENCE_OMITTED);
    return {
        text: retained.join("\n\n"),
        userEvidenceOmitted: omittedUserEvidence,
    };
}

function collectEntries(messages: readonly AutoTranscriptMessage[]): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const message of messages) {
        if (isInternalMessage(message)) continue;
        if (message.role === "system") continue;
        if (message.role === "user") {
            if (isGeneratedConversationSummary(message.blocks)) continue;
            const text = renderContent(message.blocks, "[Image shared by user]");
            if (text.length > 0) {
                const isShellContext = isUserShellCommandContext(message.blocks);
                const isAgentMessage = message.provenance === "agent";
                const rendered = isShellContext
                    ? `Tool result (direct user shell command):\n${text}`
                    : isAgentMessage
                      ? `Agent message:\n${text}`
                      : `User:\n${text}`;
                const trustedUserEvidence = !isShellContext && !isAgentMessage;
                entries.push({
                    category: isShellContext ? "tool" : "message",
                    ordinal: entries.length,
                    text: truncateEntry(rendered),
                    trustedUserEvidence,
                    trustedUserEvidenceTruncated:
                        trustedUserEvidence && rendered.length > MAX_ENTRY_CHARACTERS,
                });
            }
            continue;
        }
        if (message.role === "error") {
            if (isExcludedFromModelContext(message)) continue;
            const text = renderContent(message.blocks, "[Image attached to inference error]");
            if (text.length > 0) {
                entries.push({
                    category: "message",
                    ordinal: entries.length,
                    text: truncateEntry(
                        `${message.outcome === "retried" ? "Retried inference error" : "Run error"}:\n${text}`,
                    ),
                    trustedUserEvidence: false,
                    trustedUserEvidenceTruncated: false,
                });
            }
            continue;
        }

        for (const block of message.blocks) {
            if (block.type === "thinking") continue;
            if (block.type === "text") {
                entries.push({
                    category: "message",
                    ordinal: entries.length,
                    text: truncateEntry(`Assistant:\n${block.text}`),
                    trustedUserEvidence: false,
                    trustedUserEvidenceTruncated: false,
                });
                continue;
            }
            if (block.type === "image") {
                entries.push({
                    category: "message",
                    ordinal: entries.length,
                    text: "Assistant:\n[Image shared by assistant]",
                    trustedUserEvidence: false,
                    trustedUserEvidenceTruncated: false,
                });
                continue;
            }
            if (block.type === "tool_call") {
                entries.push({
                    category: "message",
                    ordinal: entries.length,
                    text: truncateEntry(
                        `Assistant tool call (${block.name}):\n${safeJson(block.arguments)}`,
                    ),
                    trustedUserEvidence: false,
                    trustedUserEvidenceTruncated: false,
                });
                continue;
            }

            const trustedUserEvidence = block.trustedUserEvidence !== undefined;
            const rendered = renderContent(
                block.trustedUserEvidence ?? block.rendered,
                trustedUserEvidence ? "[Image selected by user]" : "[Image returned by tool]",
            );
            const entryText = trustedUserEvidence
                ? `User response through ${block.toolName}:\n${rendered}`
                : `Tool result (${block.toolName}${block.isError === true ? ", error" : ""}):\n${rendered}`;
            entries.push({
                category: trustedUserEvidence ? "message" : "tool",
                ordinal: entries.length,
                text: truncateEntry(entryText),
                trustedUserEvidence,
                trustedUserEvidenceTruncated:
                    trustedUserEvidence && entryText.length > MAX_ENTRY_CHARACTERS,
            });
        }
    }
    return entries;
}

/** A durable model-context message that must never be presented as transcript content. */
function isInternalMessage(message: AutoTranscriptMessage): boolean {
    return message.internal === true;
}

/** Whether a durable visible message must stay out of every model-facing transcript. */
function isExcludedFromModelContext(message: AutoTranscriptMessage): boolean {
    return (
        (message.role === "error" || message.role === "system") && message.context === "excluded"
    );
}

function isGeneratedConversationSummary(blocks: readonly AutoTranscriptAgentBlock[]): boolean {
    if (blocks.length === 0 || blocks.some((block) => block.type !== "text")) return false;
    return blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trimStart()
        .startsWith("<conversation_summary>");
}

function isUserShellCommandContext(blocks: readonly AutoTranscriptAgentBlock[]): boolean {
    if (blocks.length === 0 || blocks.some((block) => block.type !== "text")) return false;
    return blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trimStart()
        .startsWith("<user_shell_command>");
}

function renderContent(
    blocks: readonly AutoTranscriptAgentBlock[],
    imagePlaceholder: string,
): string {
    return blocks
        .map((block) => (block.type === "text" ? block.text : imagePlaceholder))
        .join("\n");
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function selectTrustedUserEvidence(
    entries: readonly TranscriptEntry[],
    selected: Set<number>,
): number {
    const trusted = entries.filter((entry) => entry.trustedUserEvidence);
    const totalCharacters = trusted.reduce((total, entry) => total + entry.text.length, 0);
    if (totalCharacters <= MAX_MESSAGE_CHARACTERS) {
        for (const entry of trusted) selected.add(entry.ordinal);
        return totalCharacters;
    }

    let retainedCharacters = 0;
    const anchors = [trusted[0], trusted.at(-1)].filter(
        (entry): entry is TranscriptEntry => entry !== undefined,
    );
    for (const entry of anchors) {
        if (selected.has(entry.ordinal)) continue;
        selected.add(entry.ordinal);
        retainedCharacters += entry.text.length;
    }
    for (const entry of trusted.toReversed()) {
        if (selected.has(entry.ordinal)) continue;
        if (retainedCharacters + entry.text.length > MAX_MESSAGE_CHARACTERS) continue;
        selected.add(entry.ordinal);
        retainedCharacters += entry.text.length;
    }
    return retainedCharacters;
}

function truncateEntry(text: string): string {
    if (text.length <= MAX_ENTRY_CHARACTERS) return text;
    const marker = "\n[...entry truncated for permission review...]\n";
    const retainedPerSide = Math.floor((MAX_ENTRY_CHARACTERS - marker.length) / 2);
    return `${text.slice(0, retainedPerSide)}${marker}${text.slice(-retainedPerSide)}`;
}
