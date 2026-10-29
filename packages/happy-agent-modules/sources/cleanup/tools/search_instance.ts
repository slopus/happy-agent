import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { CleanupModule } from "../CleanupModule.js";
import {
    cleanupItemKindSchema,
    cleanupItemStatusSchema,
    cleanupSearchPageSchema,
    cleanupSortSchema,
    DEFAULT_CLEANUP_PAGE_SIZE,
    MAX_CLEANUP_PAGE_SIZE,
    MAX_CLEANUP_QUERY_LENGTH,
    type CleanupSearchQuery,
} from "../CleanupSearch.js";
import { formatCleanupItem } from "../impl/formatCleanupItem.js";

const timeSchema = (description: string) =>
    Type.String({ minLength: 4, maxLength: 64, description });

const searchInstanceInputSchema = Type.Object(
    {
        query: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: MAX_CLEANUP_QUERY_LENGTH,
                description:
                    "Words to rank by with BM25 over names, usernames, folder paths, branches, and the project, bot, or task a row belongs to. Omit to list every row by activity.",
            }),
        ),
        kinds: Type.Optional(
            Type.Array(cleanupItemKindSchema, {
                minItems: 1,
                maxItems: 5,
                uniqueItems: true,
                description: "Only these kinds. Omit for all five.",
            }),
        ),
        status: Type.Optional(cleanupItemStatusSchema),
        ownerUserId: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 96,
                description: "Only tasks owned by this team user, and the subtasks under them.",
            }),
        ),
        activeSince: Type.Optional(
            timeSchema(
                "Only rows active at or after this ISO 8601 date or time, such as 2026-10-01.",
            ),
        ),
        inactiveSince: Type.Optional(
            timeSchema(
                "Only rows with no activity at or after this ISO 8601 date or time: stale since then.",
            ),
        ),
        createdAfter: Type.Optional(
            timeSchema("Only rows created at or after this ISO 8601 time."),
        ),
        createdBefore: Type.Optional(timeSchema("Only rows created before this ISO 8601 time.")),
        sort: Type.Optional(cleanupSortSchema),
        cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CLEANUP_PAGE_SIZE })),
    },
    { additionalProperties: false },
);
type SearchInstanceInput = Static<typeof searchInstanceInputSchema>;

/** Search everything on the installation for cleanup. Admin bots only. */
export function searchInstanceTool(cleanup: CleanupModule, actingAgentId: string) {
    return defineAgentTool({
        name: "search_instance",
        defer: true,
        capabilities: [
            "Find, inspect, and clean up stale bots, tasks, subtasks, projects, workspaces, and folders on this installation.",
        ],
        searchKeywords: [
            "cleanup",
            "stale tasks",
            "inactive bots",
            "recent activity",
            "find workspace",
            "search instance",
        ],
        description: [
            "Search this installation's bots, tasks, subtasks, projects, and workspaces, archived ones included. Only active admin bots may use it.",
            "Each row shows its ID, name, status, creation time, last activity, owner, child counts, agents, folder, and branch. Last activity rolls up everything under the row: a bot or task includes its subtasks and their subagents at any depth, a workspace its agents and child workspaces, and a project every workspace and agent in it. A row with a run open is running now.",
            'With query, rows are ranked by BM25 relevance; without it, every row matches and the most recently active come first. sort "recent" or "stale" orders by last activity, newest or oldest first. activeSince and inactiveSince filter by last activity; createdAfter and createdBefore by creation.',
            `Pages hold ${String(DEFAULT_CLEANUP_PAGE_SIZE)} rows unless limit says otherwise; continue with nextCursor.`,
        ].join("\n"),
        parameters: searchInstanceInputSchema,
        returnType: cleanupSearchPageSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SearchInstanceInput) =>
            await cleanup.searchForAgent(ctx, actingAgentId, toQuery(input)),
        toLLM: (page) => {
            const shown = page.results.length;
            const lines = page.results.map(({ item }) => formatCleanupItem(item, page.at));
            const footer =
                page.total === 0
                    ? "Nothing matched."
                    : page.nextCursor === undefined
                      ? `Showing ${String(page.cursor + 1)}–${String(page.cursor + shown)} of ${String(page.total)}, ordered by ${page.sort}.`
                      : `Showing ${String(page.cursor + 1)}–${String(page.cursor + shown)} of ${String(page.total)}, ordered by ${page.sort}; continue with cursor ${String(page.nextCursor)}.`;
            return [{ type: "text", text: [...lines, footer].join("\n") }];
        },
    });
}

function toQuery(input: SearchInstanceInput): CleanupSearchQuery {
    const { activeSince, inactiveSince, createdAfter, createdBefore, ...rest } = input;
    return {
        ...rest,
        ...time("activeSince", activeSince),
        ...time("inactiveSince", inactiveSince),
        ...time("createdAfter", createdAfter),
        ...time("createdBefore", createdBefore),
    };
}

function time(name: string, value: string | undefined): Record<string, number> {
    if (value === undefined) return {};
    const at = Date.parse(value);
    if (!Number.isFinite(at) || at < 0) {
        throw new Error(`${name} must be an ISO 8601 date or time, such as 2026-10-01.`);
    }
    return { [name]: at };
}
