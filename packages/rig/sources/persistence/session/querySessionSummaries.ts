import { sql } from "drizzle-orm";

import type {
    SessionInterruption,
    SessionSummary,
    SessionTitleStatus,
    SessionTokenCount,
    SessionUnreadReason,
} from "../../protocol/index.js";
import { parsePermissionMode } from "../../permissions/index.js";
import {
    describePeerCapabilitiesActivePhrase,
    resolveOfferablePeerCapabilities,
    type PeerCapability,
} from "../../session-sharing/peer-access/index.js";
import {
    describeSharedToolOutput,
    toSharedToolOutput,
} from "../../session-sharing/SharedToolOutput.js";
import type { DockerExecutionConfig } from "../../execution/index.js";
import { summarizeDockerExecution } from "../../execution/index.js";
import type { TX } from "../Transaction.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";
import { parseStoredHostedCapabilities } from "./impl/parseStoredHostedCapabilities.js";

export function querySessionSummaries(
    tx: TX,
    activeOnly: boolean,
    options: { limit?: number },
): readonly SessionSummary[] {
    const rows = tx.all<Record<string, unknown>>(sql`
        SELECT listed_sessions.*,
            session_shares.share_id AS share_id,
            session_shares.state AS share_state,
            session_shares.include_friend_messages AS share_include_friend_messages,
            session_shares.tool_output AS share_tool_output,
            (
                SELECT COUNT(*)
                FROM session_share_members
                WHERE session_share_members.share_id = session_shares.share_id
                  AND session_share_members.state = 'active'
            ) AS share_member_count,
            (
                SELECT COUNT(DISTINCT session_share_capabilities.share_member_id)
                FROM session_share_capabilities
                JOIN session_share_members
                    ON session_share_members.share_member_id
                        = session_share_capabilities.share_member_id
                    AND session_share_members.current_grant_epoch
                        = session_share_capabilities.grant_epoch
                WHERE session_share_members.share_id = session_shares.share_id
                  AND session_share_members.state = 'active'
                  AND session_share_capabilities.state = 'active'
            ) AS share_capability_member_count,
            (
                SELECT GROUP_CONCAT(DISTINCT session_share_capabilities.capability)
                FROM session_share_capabilities
                JOIN session_share_members
                    ON session_share_members.share_member_id
                        = session_share_capabilities.share_member_id
                    AND session_share_members.current_grant_epoch
                        = session_share_capabilities.grant_epoch
                WHERE session_share_members.share_id = session_shares.share_id
                  AND session_share_members.state = 'active'
                  AND session_share_capabilities.state = 'active'
            ) AS share_active_capabilities
        FROM (
            SELECT
                id, project_id, workspace_id, order_key, archived, track_unread,
                unread_reason, unread_since_ms, cwd, draft, draft_updated_at_ms,
                docker_json, secret_ids_json, provider_id, model_id, permission_mode,
                hosted_capabilities, effort, service_tier, status, title, title_status, title_error, recap,
                session_token_count_json, metadata_updated_at_ms, metadata_run_id,
                interruption_json, created_at_ms, updated_at_ms, last_message_at_ms,
                last_event_id
            FROM sessions
            WHERE parent_session_id IS NULL
                ${activeOnly ? sql`AND archived = 0` : sql``}
        ) AS listed_sessions
        JOIN projects ON projects.id = listed_sessions.project_id
        LEFT JOIN project_workspaces ON project_workspaces.id = listed_sessions.workspace_id
        LEFT JOIN session_shares ON session_shares.share_id = (
            SELECT latest_share.share_id
            FROM session_shares AS latest_share
            WHERE latest_share.owner_session_id = listed_sessions.id
            ORDER BY
                latest_share.state <> 'stopped' DESC,
                latest_share.created_at_ms DESC,
                latest_share.share_id DESC
            LIMIT 1
        )
        ORDER BY
            projects.order_key ASC,
            listed_sessions.workspace_id IS NOT NULL ASC,
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
        const metadataUpdatedAt = readOptionalNumber(row, "metadata_updated_at_ms");
        const metadataRunId = readOptionalString(row, "metadata_run_id");
        const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
        const lastEventId = readOptionalString(row, "last_event_id");
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
        const workspaceId = readOptionalString(row, "workspace_id");
        const shareId = readOptionalString(row, "share_id");
        const hostedCapabilities = parseStoredHostedCapabilities(
            readOptionalString(row, "hosted_capabilities"),
        );
        // An empty stored key means the session has no place in an ordered
        // list, which the protocol says by leaving the position out.
        const orderKey = readString(row, "order_key");
        // An unshared session has no joined share row, so this column is absent
        // rather than empty; anything unreadable is read as the private setting.
        const toolOutput = toSharedToolOutput(readOptionalString(row, "share_tool_output"));
        // NULL (no active capability row at all) reads the same as an empty list;
        // GROUP_CONCAT never produces an empty string for a row that exists.
        const activeCapabilities = (readOptionalString(row, "share_active_capabilities")?.split(
            ",",
        ) ?? []) as PeerCapability[];
        return {
            id: readString(row, "id"),
            archived: readNumber(row, "archived") !== 0,
            projectId: readString(row, "project_id"),
            ...(orderKey === "" ? {} : { orderKey }),
            ...(workspaceId === undefined ? {} : { workspaceId }),
            ...(shareId === undefined
                ? {}
                : {
                      shared: {
                          activeCapabilitiesDescription:
                              describePeerCapabilitiesActivePhrase(activeCapabilities),
                          capabilityMemberCount: readNumber(row, "share_capability_member_count"),
                          includeFriendMessagesInModel:
                              readNumber(row, "share_include_friend_messages") !== 0,
                          memberCount: readNumber(row, "share_member_count"),
                          // What this project could offer, which is a property of the
                          // project's execution environment rather than of the share:
                          // a session on the host can offer nothing, and says why.
                          offerableCapabilities: [...resolveOfferablePeerCapabilities(docker)],
                          shareId,
                          state: readString(row, "share_state") as
                              | "active"
                              | "degraded"
                              | "stopped",
                          toolOutput,
                          toolOutputDescription: describeSharedToolOutput(toolOutput),
                      },
                  }),
            trackUnread: readNumber(row, "track_unread") !== 0,
            ...(unreadReason !== undefined && unreadSince !== undefined
                ? { unread: { reason: unreadReason as SessionUnreadReason, since: unreadSince } }
                : {}),
            cwd: readString(row, "cwd"),
            ...(draft === undefined ? {} : { draft }),
            ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
            providerId: readString(row, "provider_id"),
            modelId: readString(row, "model_id"),
            permissionMode: parsePermissionMode(readString(row, "permission_mode")),
            ...(hostedCapabilities === undefined ? {} : { hostedCapabilities }),
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
                : { sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount }),
            ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
            ...(metadataRunId !== undefined ? { metadataRunId } : {}),
            ...(interruptionJson === undefined
                ? {}
                : { interruption: JSON.parse(interruptionJson) as SessionInterruption }),
        };
    });
}
