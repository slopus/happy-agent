import type { HistoryExcerpt } from "../../history/index.js";

/** What the notice needs to say: where the conversation came from, and where it is now. */
export interface ModelSwitchNotice {
    /** The label of the model that was in force, or its ID when nothing nicer is known. */
    readonly previousModel: string;
    /** The registry ID of the provider that was serving it. */
    readonly previousProvider: string;
    /** The label of the model now in force, or its ID when nothing nicer is known. */
    readonly model: string;
    /** The registry ID of the provider now serving it. */
    readonly provider: string;
    /** Whether the same model/provider started fresh because the opaque request profile changed. */
    readonly profileReset?: boolean | undefined;
    /** The tool that reads the durable history, when the agent has one. */
    readonly historyTool?: string | undefined;
    /** The two ends of the erased conversation, when a history was there to read. */
    readonly excerpt?: HistoryExcerpt | undefined;
}

/**
 * The one message a model reset by a switch is handed.
 *
 * It is the first thing in an otherwise empty context, so it has to say plainly that a
 * conversation happened, what was in it, and what to do about that before answering. The wording
 * follows Happy Agent's own switch notice, including its insistence on investigating rather than being
 * handed something: a model told it received a handoff acts as though it already knows what was
 * decided.
 *
 * With a history to read from it carries what Happy Agent's carries — an overview and both ends of the
 * conversation, bounded. Without one it says so, which is the honest version of the same message.
 */
export function createModelSwitchNotice(notice: ModelSwitchNotice): string {
    const excerpt = notice.excerpt;
    const tag =
        notice.profileReset === true
            ? "profile-reset-history-context"
            : "model-switch-history-context";
    return [
        `<${tag}>`,
        notice.profileReset === true
            ? "The request profile changed, so the active model started a fresh private context."
            : `The active model/provider configuration changed from ${notice.previousModel} on ${notice.previousProvider} to ${notice.model} on ${notice.provider}.`,
        investigate(notice),
        ...(excerpt === undefined
            ? [
                  notice.profileReset === true
                      ? "The conversation itself is not part of this context: the request profile requires a fresh context, so none of it is visible to you, and the work it describes still stands. Do not repeat or undo work that may already be done."
                      : "The conversation itself is not part of this context: the two configurations are incompatible, so none of it is visible to you, and the work it describes still stands. Do not repeat or undo work that may already be done.",
              ]
            : [
                  `The excerpt${notice.historyTool === undefined ? " exposes" : " and tool expose"} the durable inference-oriented history, not raw provider protocol traffic or hidden reasoning. Exposed thinking and conversation are prioritized; tool calls are summarized and tool outputs are truncated.`,
                  overview(excerpt),
                  `Beginning history excerpt:\n${excerpt.beginning}`,
                  ...(excerpt.recent.length === 0
                      ? []
                      : [`Recent history excerpt:\n${excerpt.recent}`]),
              ]),
        `</${tag}>`,
    ].join("\n");
}

function overview(excerpt: HistoryExcerpt): string {
    const prefix =
        excerpt.statsAreSampled === true
            ? "History sample overview (counts cover only the bounded excerpt, not the full archive)"
            : "History overview";
    return `${prefix}: ${excerpt.stats.messages} messages, ${excerpt.stats.userMessages} user messages, ${excerpt.stats.assistantMessages} assistant messages, ${excerpt.stats.thinkingBlocks} thinking blocks, ${excerpt.stats.toolCalls} tool calls, ${excerpt.stats.toolResults} tool results, and ${excerpt.stats.textCharacters} text characters.`;
}

/** What the new model is asked to do before it answers, given what it can reach. */
function investigate(notice: ModelSwitchNotice): string {
    const opening =
        "Before responding, investigate the prior agent history so you understand the user's request, decisions, work already performed, and relevant subagent findings.";
    if (notice.historyTool === undefined) {
        return notice.excerpt === undefined
            ? `${opening} Durable history lookup is unavailable in this runtime, so establish what you need from the user rather than assuming it.`
            : `${opening} Review the bounded excerpt below carefully; additional durable history lookup is unavailable in this runtime.`;
    }
    return notice.excerpt === undefined
        ? `${opening} Use ${notice.historyTool} proactively whenever more detail could affect your answer.`
        : `${opening} Review the bounded excerpt below, then use ${notice.historyTool} proactively whenever the excerpt is incomplete or more detail could affect your answer.`;
}
