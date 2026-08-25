import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { HistoryModule } from "../HistoryModule.js";
import {
    historyAgentIdSchema,
    MAX_HISTORY_PAGE_SIZE,
    MAX_HISTORY_POSITION,
    MAX_HISTORY_QUERY_LENGTH,
    MAX_HISTORY_TOTAL_BLOCKS,
    MAX_HISTORY_TOTAL_MESSAGES,
    MAX_HISTORY_TOTAL_TEXT_CHARACTERS,
} from "../HistoryMessage.js";
import {
    historyAgentTargetSchema,
    MAX_HISTORY_AGENT_DESCRIPTION_LENGTH,
    MAX_HISTORY_AGENT_PATH_LENGTH,
    MAX_HISTORY_AGENT_STATUS_LENGTH,
    MAX_HISTORY_AGENT_SUMMARIES,
    type HistoryAgentSummary,
} from "../HistoryAgent.js";
import { formatHistoryPage, MAX_HISTORY_CHARACTERS } from "../impl/formatHistoryPage.js";
import type { HistoryStats } from "../impl/summarizeHistory.js";

/** The counted shape of one stretch of history, as the model reads it. */
const historyStatsSchema = Type.Object(
    {
        assistant_messages: Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 0 }),
        messages: Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 0 }),
        text_characters: Type.Integer({
            maximum: MAX_HISTORY_TOTAL_TEXT_CHARACTERS,
            minimum: 0,
        }),
        thinking_blocks: Type.Integer({ maximum: MAX_HISTORY_TOTAL_BLOCKS, minimum: 0 }),
        tool_calls: Type.Integer({ maximum: MAX_HISTORY_TOTAL_BLOCKS, minimum: 0 }),
        tool_results: Type.Integer({ maximum: MAX_HISTORY_TOTAL_BLOCKS, minimum: 0 }),
        user_messages: Type.Integer({ maximum: MAX_HISTORY_TOTAL_MESSAGES, minimum: 0 }),
    },
    { additionalProperties: false },
);

const historyAgentSummaryResponseSchema = Type.Object(
    {
        agent_id: historyAgentIdSchema,
        description: Type.Optional(
            Type.String({ maxLength: MAX_HISTORY_AGENT_DESCRIPTION_LENGTH }),
        ),
        message_count: Type.Integer({
            minimum: 0,
            maximum: MAX_HISTORY_TOTAL_MESSAGES,
        }),
        path: Type.String({
            minLength: 1,
            maxLength: MAX_HISTORY_AGENT_PATH_LENGTH,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
        status: Type.String({
            minLength: 1,
            maxLength: MAX_HISTORY_AGENT_STATUS_LENGTH,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
    },
    { additionalProperties: false },
);

/** The tool that reads and searches one agent's durable history. */
export function readAgentHistoryTool(history: HistoryModule, agentId: string) {
    return defineAgentTool({
        name: "read_agent_history",
        defer: true,
        capabilities: ["Read the agent's durable conversation and tool history."],
        searchKeywords: ["prior messages", "previous tool calls", "agent conversation history"],
        description:
            "Read or search the durable low-level history of any agent. The response lists the agents it concerns with their stable IDs, message counts, paths, and statuses; any stable Agent ID may be read, including one that has recorded nothing yet. Use this to investigate prior requests, decisions, reasoning, tool activity, and subagent work after a model change or whenever earlier context matters. This is not a user-facing chat export. Search examines stored block content, but each response is simplified and capped at 80,000 characters: provider-hidden reasoning is unavailable, only exposed thinking is readable, tool calls are summarized, tool outputs are truncated, and images are represented only by metadata. A requested message limit may therefore return fewer messages; continue with next_cursor or previous_cursor.",
        parameters: Type.Object({
            cursor: Type.Optional(
                Type.Integer({
                    description:
                        "Zero-based original history position. Use a returned previous_cursor or next_cursor to navigate. Cannot be combined with from.",
                    minimum: 0,
                    maximum: MAX_HISTORY_POSITION,
                }),
            ),
            from: Type.Optional(
                Type.Union(
                    [
                        Type.Literal("start"),
                        Type.Literal("begin"),
                        Type.Literal("beginning"),
                        Type.Literal("end"),
                        Type.Literal("last"),
                    ],
                    {
                        description:
                            "Read the first matching page with start, begin, or beginning; read the last matching page with end or last. Results are always chronological. Cannot be combined with cursor.",
                    },
                ),
            ),
            include_tools: Type.Optional(
                Type.Boolean({
                    description:
                        "Include simplified tool calls and truncated tool results. Defaults to true. This does not change what query searches.",
                }),
            ),
            limit: Type.Optional(
                Type.Integer({
                    description:
                        "Maximum matching messages to select before the 80,000-character response cap is applied. Defaults to 100 and cannot exceed 500. Large messages may return fewer; use the returned cursors to continue.",
                    maximum: MAX_HISTORY_PAGE_SIZE,
                    minimum: 1,
                }),
            ),
            query: Type.Optional(
                Type.String({
                    description:
                        "Case-insensitive text search across full stored conversation, thinking, tool names, arguments, and outputs.",
                    maxLength: MAX_HISTORY_QUERY_LENGTH,
                    minLength: 1,
                }),
            ),
            roles: Type.Optional(
                Type.Array(
                    Type.Union([
                        Type.Literal("user"),
                        Type.Literal("agent"),
                        Type.Literal("assistant"),
                        Type.Literal("error"),
                        Type.Literal("system"),
                    ]),
                    {
                        description:
                            'Return only messages with one of these roles. "user" is a message the person actually sent; "agent" is a system-generated message such as a goal continuation or another agent\'s delivery.',
                        maxItems: 5,
                        minItems: 1,
                        uniqueItems: true,
                    },
                ),
            ),
            target: Type.Optional(historyAgentTargetSchema),
        }),
        returnType: Type.Object({
            agents: Type.Array(historyAgentSummaryResponseSchema, {
                maxItems: MAX_HISTORY_AGENT_SUMMARIES,
            }),
            cursor: Type.Integer({ maximum: MAX_HISTORY_POSITION, minimum: 0 }),
            history: Type.String({
                description:
                    "Simplified chronological history, capped at 80,000 characters. It is not verbatim provider traffic and may omit or truncate tool and image details.",
                maxLength: MAX_HISTORY_CHARACTERS,
            }),
            matched_messages: Type.Integer({
                maximum: MAX_HISTORY_TOTAL_MESSAGES,
                minimum: 0,
            }),
            next_cursor: Type.Optional(
                Type.Integer({
                    description:
                        "Stable original-history position for the next matching page. Omitted at the end.",
                    maximum: MAX_HISTORY_POSITION,
                    minimum: 0,
                }),
            ),
            previous_cursor: Type.Optional(
                Type.Integer({
                    description:
                        "Stable original-history position for the preceding matching page. Omitted at the beginning.",
                    maximum: MAX_HISTORY_POSITION,
                    minimum: 0,
                }),
            ),
            returned_messages: Type.Integer({
                description:
                    "Messages actually returned after filtering and the character cap; this can be lower than limit.",
                maximum: MAX_HISTORY_PAGE_SIZE,
                minimum: 0,
            }),
            stats: Type.Object({
                matched: historyStatsSchema,
                returned: historyStatsSchema,
                total: historyStatsSchema,
            }),
            target: historyAgentIdSchema,
            total_messages: Type.Integer({
                maximum: MAX_HISTORY_TOTAL_MESSAGES,
                minimum: 0,
            }),
        }),
        // Reading history changes nothing and reaches nothing outside the agent's own store.
        durable: true,
        reloadable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args) => {
            if (args.cursor !== undefined && args.from !== undefined) {
                throw new Error("Use either cursor or from, not both.");
            }
            const from =
                args.from === "begin" || args.from === "beginning"
                    ? "start"
                    : args.from === "last"
                      ? "end"
                      : args.from;
            const target = await history.resolveTarget(ctx, agentId, args.target ?? agentId);
            const agents = await history.listAgents(ctx, agentId, target);
            if (!agents.some((agent) => agent.agentId === target)) {
                throw new Error("The history agent roster did not include the resolved target.");
            }
            const page = await history.read(ctx, target, {
                ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
                ...(from === undefined ? {} : { from }),
                limit: args.limit ?? 100,
                ...(args.query === undefined ? {} : { query: args.query }),
                ...(args.roles === undefined ? {} : { roles: args.roles }),
            });
            const formatted = formatHistoryPage(page, {
                fromEnd: from === "end",
                includeTools: args.include_tools !== false,
            });
            const cursor = page.messages[formatted.startIndex]?.position ?? page.cursor;
            const next =
                formatted.startIndex + formatted.consumedMessages < page.messages.length
                    ? page.messages[formatted.startIndex + formatted.consumedMessages]?.position
                    : page.nextCursor;
            const previous =
                formatted.startIndex > 0 ? page.messages[0]?.position : page.previousCursor;
            return {
                agents: agents.map(toAgentSummary),
                cursor,
                history: formatted.history,
                matched_messages: page.matchedMessages,
                ...(next === undefined ? {} : { next_cursor: next }),
                ...(previous === undefined ? {} : { previous_cursor: previous }),
                returned_messages: formatted.consumedMessages,
                stats: {
                    matched: toStats(page.matchedStats),
                    returned: toStats(formatted.stats),
                    total: toStats(page.totalStats),
                },
                target: page.agentId,
                total_messages: page.totalMessages,
            };
        },
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}

/** The counts as the model reads them, named the way the rest of the answer is. */
function toStats(stats: HistoryStats) {
    return {
        assistant_messages: stats.assistantMessages,
        messages: stats.messages,
        text_characters: stats.textCharacters,
        thinking_blocks: stats.thinkingBlocks,
        tool_calls: stats.toolCalls,
        tool_results: stats.toolResults,
        user_messages: stats.userMessages,
    };
}

function toAgentSummary(agent: HistoryAgentSummary) {
    return {
        agent_id: agent.agentId,
        ...(agent.description === undefined ? {} : { description: agent.description }),
        message_count: agent.messageCount,
        path: agent.path,
        status: agent.status,
    };
}
