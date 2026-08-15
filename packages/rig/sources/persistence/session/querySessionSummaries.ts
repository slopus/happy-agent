import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type {
    SessionInterruption,
    SessionSummary,
    SessionTitleStatus,
    SessionTokenCount,
    SessionUnreadReason,
} from "../../protocol/index.js";
import { parsePermissionMode } from "../../permissions/index.js";
import type { DockerExecutionConfig } from "../../execution/index.js";
import { summarizeDockerExecution } from "../../execution/index.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";
import { sessionScopeFromRow } from "./impl/sessionScope.js";

export async function querySessionSummaries(
    ctx: Context,
    activeOnly: boolean,
    options: { limit?: number },
): Promise<readonly SessionSummary[]> {
    return await inDatabase(ctx, "rig.sql.session.query_session_summaries", async (ctx) => {
        const tx = ctx.tx;
        const rows = await tx.all<Record<string, unknown>>(sql`
        SELECT listed_sessions.*
        FROM (
            SELECT
                id, owner_instance_id, profile_id, scope_kind, project_id, workspace_id, folder_id, order_key, archived, track_unread,
                unread_reason, unread_since_ms, cwd, draft, draft_updated_at_ms,
                docker_json, secret_ids_json, provider_id, model_id, permission_mode,
                effort, service_tier, status, title, title_status, title_error, recap,
                session_token_count_json, interruption_json,
                created_at_ms, updated_at_ms, last_message_at_ms,
                last_event_id
            FROM sessions
            WHERE parent_session_id IS NULL
                ${activeOnly ? sql`AND archived = 0` : sql``}
        ) AS listed_sessions
        LEFT JOIN projects ON projects.id = listed_sessions.project_id
        LEFT JOIN project_workspaces ON project_workspaces.id = listed_sessions.workspace_id
        ORDER BY
            listed_sessions.scope_kind ASC,
            projects.order_key ASC,
            project_workspaces.order_key ASC,
            listed_sessions.order_key ASC,
            listed_sessions.id ASC
        LIMIT ${options.limit ?? (activeOnly ? -1 : 500)}
    `);

        return rows.map((row) => {
            const effort = readOptionalString(row, "effort");
            const serviceTier = readOptionalString(row, "service_tier");
            const title = readOptionalString(row, "title");
            const titleError = readOptionalString(row, "title_error");
            const recap = readOptionalString(row, "recap");
            const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
            const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
            const lastEventId = readOptionalString(row, "last_event_id");
            const profileId = readOptionalString(row, "profile_id");
            const interruptionJson = readOptionalString(row, "interruption_json");
            const draft = readOptionalString(row, "draft");
            const draftUpdatedAt = readOptionalNumber(row, "draft_updated_at_ms");
            const dockerJson = readOptionalString(row, "docker_json");
            const docker =
                dockerJson === undefined
                    ? undefined
                    : (JSON.parse(dockerJson) as DockerExecutionConfig);
            const unreadReason = readOptionalString(row, "unread_reason");
            const unreadSince = readOptionalNumber(row, "unread_since_ms");
            const scope = sessionScopeFromRow(row);
            // An empty stored key means the session has no place in an ordered
            // list, which the protocol says by leaving the position out.
            const orderKey = readString(row, "order_key");
            return {
                id: readString(row, "id"),
                ownerInstanceId: readString(row, "owner_instance_id"),
                ...(profileId === undefined ? {} : { profileId }),
                archived: readNumber(row, "archived") !== 0,
                scope,
                ...(scope.kind === "project" || scope.kind === "workspace"
                    ? { projectId: scope.projectId }
                    : {}),
                ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {}),
                ...(scope.kind === "folder" ? { folderId: scope.folderId } : {}),
                ...(orderKey === "" ? {} : { orderKey }),
                trackUnread: readNumber(row, "track_unread") !== 0,
                ...(unreadReason !== undefined && unreadSince !== undefined
                    ? {
                          unread: {
                              reason: unreadReason as SessionUnreadReason,
                              since: unreadSince,
                          },
                      }
                    : {}),
                cwd: readString(row, "cwd"),
                ...(draft === undefined ? {} : { draft }),
                ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
                providerId: readString(row, "provider_id"),
                modelId: readString(row, "model_id"),
                permissionMode: parsePermissionMode(readString(row, "permission_mode")),
                environment: summarizeDockerExecution(docker),
                ...(effort !== undefined ? { effort } : {}),
                ...(serviceTier === "fast" ? { serviceTier } : {}),
                status: readString(row, "status") as SessionSummary["status"],
                titleStatus: readString(row, "title_status") as SessionTitleStatus,
                createdAt: readNumber(row, "created_at_ms"),
                updatedAt: readNumber(row, "updated_at_ms"),
                ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
                ...(lastEventId !== undefined ? { lastEventId } : {}),
                ...(title !== undefined ? { title } : {}),
                ...(titleError !== undefined ? { titleError } : {}),
                ...(recap !== undefined ? { recap } : {}),
                ...(sessionTokenCountJson === undefined
                    ? {}
                    : {
                          sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount,
                      }),
                ...(interruptionJson === undefined
                    ? {}
                    : { interruption: JSON.parse(interruptionJson) as SessionInterruption }),
            };
        });
    });
}
