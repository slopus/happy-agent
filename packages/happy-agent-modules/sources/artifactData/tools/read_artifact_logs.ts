import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    ARTIFACT_LOG_LIMITS,
    ArtifactDataInputError,
    artifactDataUserIdSchema,
    artifactLogEntrySchema,
    artifactLogLevelSchema,
    type ArtifactLogEntry,
} from "../ArtifactData.js";
import type { ArtifactDataModule } from "../ArtifactDataModule.js";
import { artifactDataAuthorViewSchema, authorViews } from "./common.js";

const DEFAULT_LOG_ENTRIES = 50;
/** How much of one entry's data a model reads. */
const DATA_BYTES = 2 * 1024;

const readArtifactLogsToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        level: Type.Optional(
            Type.Union(artifactLogLevelSchema.anyOf, {
                description:
                    'The least severe level shown: "error" shows errors only, "warn" warnings and errors, "info" everything (default)',
            }),
        ),
        userId: Type.Optional(
            Type.String({
                ...artifactDataUserIdSchema,
                description: "Only entries this user's pages reported",
            }),
        ),
        since: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                description: "Only entries received at or after this time, ISO 8601",
            }),
        ),
        until: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                description: "Only entries received at or before this time, ISO 8601",
            }),
        ),
        limit: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: ARTIFACT_LOG_LIMITS.pageSize,
                description: `Entries per page, default ${String(DEFAULT_LOG_ENTRIES)}`,
            }),
        ),
        pageCursor: Type.Optional(
            Type.String({
                pattern: "^[1-9][0-9]{0,15}$",
                description: "The nextPageCursor of the previous page, for older entries",
            }),
        ),
    },
    { additionalProperties: false },
);
type ReadArtifactLogsToolInput = Static<typeof readArtifactLogsToolInputSchema>;

const artifactLogsReadSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        entries: Type.Array(artifactLogEntrySchema),
        nextPageCursor: Type.Union([Type.String(), Type.Null()]),
        users: Type.Array(artifactDataAuthorViewSchema),
    },
    { additionalProperties: false },
);
type ArtifactLogsRead = Static<typeof artifactLogsReadSchema>;

/** Read what an HTML artifact's pages reported while people used it: errors, warnings, sync. */
export function readArtifactLogsTool(data: ArtifactDataModule) {
    return defineAgentTool({
        name: "read_artifact_logs",
        defer: true,
        capabilities: [
            "Read the errors, warnings, and sync problems HTML artifact apps reported while people used them.",
        ],
        searchKeywords: [
            "artifact logs",
            "artifact errors",
            "debug artifact app",
            "console errors",
            "html app crash",
        ],
        description: [
            "Read the debug log of an HTML artifact app, newest first: what its pages reported while people used them. A page that loads /api/v1/client.js reports uncaught errors, unhandled promise rejections, console.error and console.warn, the SDK's own sync trouble (reconnects, conflicts, rejected writes, resets, going unavailable), and whatever the page passes to happy.debug.log.",
            `Each entry shows its level, source, message, data, who was using the page, when it arrived, and the artifact's newest version then. Filter by level, user, and time; ${String(DEFAULT_LOG_ENTRIES)} entries per page by default. The log keeps the newest ${String(ARTIFACT_LOG_LIMITS.keptEntries)} entries of the last 7 days. Use it after someone reports a problem with an app, or after publishing a new version, to see what broke.`,
        ].join("\n\n"),
        parameters: readArtifactLogsToolInputSchema,
        returnType: artifactLogsReadSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (
            ctx: Context,
            input: ReadArtifactLogsToolInput,
        ): Promise<ArtifactLogsRead> => {
            const page = await data.readLogs(ctx, input.artifactId, {
                ...(input.level === undefined ? {} : { level: input.level }),
                ...(input.userId === undefined ? {} : { userId: input.userId }),
                ...(input.since === undefined ? {} : { since: time(input.since, "since") }),
                ...(input.until === undefined ? {} : { until: time(input.until, "until") }),
                ...(input.pageCursor === undefined ? {} : { before: input.pageCursor }),
                limit: input.limit ?? DEFAULT_LOG_ENTRIES,
            });
            const ids = [...new Set(page.entries.map((entry) => entry.userId))];
            const users: ArtifactLogsRead["users"] = [];
            for (let index = 0; index < ids.length; index += 100) {
                users.push(
                    ...authorViews(
                        await data.users(ctx, input.artifactId, ids.slice(index, index + 100)),
                    ),
                );
            }
            return {
                artifactId: input.artifactId,
                entries: [...page.entries],
                nextPageCursor: page.nextBefore ?? null,
                users,
            };
        },
        toLLM: (read) => [{ type: "text", text: formatArtifactLogs(read) }],
    });
}

function time(value: string, name: string): number {
    const at = Date.parse(value);
    if (!Number.isFinite(at) || at < 0)
        throw new ArtifactDataInputError(`\`${name}\` must be an ISO 8601 time.`);
    return at;
}

function formatArtifactLogs(read: ArtifactLogsRead): string {
    if (read.entries.length === 0) {
        return `Artifact ${read.artifactId} has no log entries${read.nextPageCursor === null ? " that match" : " on this page"}.`;
    }
    const users = new Map(read.users.map((user) => [user.id, user]));
    const lines = [
        `Artifact ${read.artifactId} log, newest first, ${String(read.entries.length)} ${read.entries.length === 1 ? "entry" : "entries"}:`,
        ...read.entries.map((entry) => formatArtifactLogEntry(entry, users)),
    ];
    if (read.nextPageCursor !== null) {
        lines.push(
            `Older entries follow; pass pageCursor ${JSON.stringify(read.nextPageCursor)} for the next page.`,
        );
    }
    return lines.join("\n");
}

function formatArtifactLogEntry(
    entry: ArtifactLogEntry,
    users: ReadonlyMap<string, { readonly name: string | null }>,
): string {
    const name = users.get(entry.userId)?.name ?? "someone";
    const version = entry.version === null ? "" : ` · version ${String(entry.version)}`;
    const head = `- ${new Date(entry.at).toISOString()} · ${entry.level} · ${entry.source} · ${name} (${entry.userId})${version}`;
    const lines = [head, `  ${entry.message.replace(/\n/g, "\n  ")}`];
    if (entry.data !== null) {
        const json = JSON.stringify(entry.data);
        lines.push(
            `  data: ${json.length <= DATA_BYTES ? json : `${json.slice(0, DATA_BYTES)}… [cut]`}`,
        );
    }
    if (entry.url !== null) lines.push(`  page: ${entry.url}`);
    return lines.join("\n");
}
