import { desc, sql } from "drizzle-orm";
import {
    check,
    foreignKey,
    index,
    integer,
    primaryKey,
    sqliteTable,
    text,
    unique,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const rigDataIdentityTable = sqliteTable(
    "rig_data_identity",
    {
        singleton: integer("singleton").notNull().primaryKey(),
        epoch: text("epoch").notNull(),
        formatVersion: integer("format_version").notNull().default(1),
    },
    (identity) => [
        check("rig_data_identity_singleton", sql`${identity.singleton} = 1`),
        check("rig_data_identity_format_version", sql`${identity.formatVersion} = 1`),
    ],
);

export const p2pPeers = sqliteTable("p2p_peers", {
    instanceId: text("instance_id").notNull().primaryKey(),
    publicKey: text("public_key").notNull().unique(),
    name: text("name").notNull(),
    bindingsJson: text("bindings_json").notNull(),
    connectionsJson: text("connections_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const p2pPeerPairings = sqliteTable("p2p_peer_pairings", {
    pairingId: text("pairing_id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    publicKey: text("public_key").notNull(),
    name: text("name").notNull(),
    bindingsJson: text("bindings_json").notNull(),
    connectionsJson: text("connections_json").notNull(),
    assignPrimary: integer("assign_primary", { mode: "boolean" }).notNull(),
    state: text("state").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
});

export const projectAvatarAssets = sqliteTable("project_avatar_assets", {
    hash: text("hash").primaryKey(),
    mediaType: text("media_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dereferencedAtMs: integer("dereferenced_at_ms"),
});

export const projects = sqliteTable(
    "projects",
    {
        id: text("id").primaryKey(),
        path: text("path").notNull().unique(),
        storageKey: text("storage_key").notNull().unique(),
        kind: text("kind").notNull(),
        name: text("name").notNull(),
        nameKey: text("name_key").notNull().unique(),
        nameSource: text("name_source").notNull(),
        orderKey: text("order_key").notNull(),
        avatarHash: text("avatar_hash").references(() => projectAvatarAssets.hash),
        avatarSource: text("avatar_source"),
        initializationStatus: text("initialization_status").notNull(),
        initializationError: text("initialization_error"),
        initializationAttempt: integer("initialization_attempt").notNull(),
        presence: text("presence").notNull(),
        worktreeSupport: text("worktree_support").notNull(),
        worktreeSupportReason: text("worktree_support_reason"),
        gitBranch: text("git_branch"),
        gitHead: text("git_head"),
        gitUpstream: text("git_upstream"),
        gitAhead: integer("git_ahead").notNull(),
        gitBehind: integer("git_behind").notNull(),
        gitDetached: integer("git_detached", { mode: "boolean" }).notNull(),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        archivedAtMs: integer("archived_at_ms"),
        defaultBranch: text("default_branch"),
        defaultCompute: text("default_compute"),
        defaultDockerImage: text("default_docker_image"),
        defaultComputeGeneration: integer("default_compute_generation").notNull().default(0),
        userMutationVersion: integer("user_mutation_version").notNull().default(1),
    },
    (table) => [
        index("projects_updated").on(desc(table.updatedAtMs)),
        index("projects_order").on(table.orderKey),
    ],
);

export const projectWorkspaces = sqliteTable(
    "project_workspaces",
    {
        id: text("id").primaryKey(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        path: text("path").notNull().unique(),
        storageKey: text("storage_key").notNull(),
        name: text("name").notNull(),
        nameKey: text("name_key").notNull(),
        title: text("title"),
        orderKey: text("order_key").notNull(),
        kind: text("kind").notNull(),
        status: text("status").notNull(),
        baseRef: text("base_ref"),
        baseCommit: text("base_commit"),
        gitCommonDir: text("git_common_dir").notNull(),
        error: text("error"),
        creatorSessionId: text("creator_session_id"),
        presence: text("presence").notNull(),
        gitBranch: text("git_branch"),
        gitHead: text("git_head"),
        gitUpstream: text("git_upstream"),
        gitAhead: integer("git_ahead").notNull(),
        gitBehind: integer("git_behind").notNull(),
        gitDetached: integer("git_detached", { mode: "boolean" }).notNull(),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        archivedAtMs: integer("archived_at_ms"),
    },
    (table) => [
        unique().on(table.projectId, table.storageKey),
        unique().on(table.projectId, table.nameKey),
        index("project_workspaces_project_updated").on(table.projectId, desc(table.updatedAtMs)),
        index("project_workspaces_project_order").on(table.projectId, table.orderKey),
    ],
);

export const sessions = sqliteTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        agentId: text("agent_id").notNull(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id),
        workspaceId: text("workspace_id").references(() => projectWorkspaces.id),
        orderKey: text("order_key").notNull(),
        sessionKind: text("session_kind").notNull(),
        parentSessionId: text("parent_session_id"),
        rootSessionId: text("root_session_id").notNull(),
        depth: integer("depth").notNull(),
        parentToolCallId: text("parent_tool_call_id"),
        taskName: text("task_name"),
        description: text("description"),
        archived: integer("archived", { mode: "boolean" }).notNull(),
        trackUnread: integer("track_unread", { mode: "boolean" }).notNull(),
        unreadReason: text("unread_reason"),
        unreadSinceMs: integer("unread_since_ms"),
        cwd: text("cwd").notNull(),
        draft: text("draft"),
        draftUpdatedAtMs: integer("draft_updated_at_ms"),
        dockerJson: text("docker_json"),
        secretIdsJson: text("secret_ids_json").notNull(),
        providerId: text("provider_id").notNull(),
        modelId: text("model_id").notNull(),
        effort: text("effort"),
        serviceTier: text("service_tier"),
        instructions: text("instructions"),
        appendSystemPrompt: text("append_system_prompt"),
        systemPrompt: text("system_prompt"),
        externalToolsJson: text("external_tools_json").notNull(),
        durableSkillsJson: text("durable_skills_json").notNull(),
        status: text("status").notNull(),
        activeRunId: text("active_run_id"),
        activeSinceMs: integer("active_since_ms"),
        elapsedMs: integer("elapsed_ms").notNull(),
        totalTokens: integer("total_tokens").notNull(),
        sessionTokenCountJson: text("session_token_count_json"),
        usageJson: text("usage_json"),
        lastEventId: text("last_event_id"),
        permissionMode: text("permission_mode").notNull(),
        modelsJson: text("models_json").notNull(),
        toolsJson: text("tools_json").notNull(),
        tasksJson: text("tasks_json").notNull(),
        workflowsJson: text("workflows_json").notNull(),
        workflowsEnabled: integer("workflows_enabled", { mode: "boolean" }).notNull(),
        goalJson: text("goal_json"),
        nextTaskId: integer("next_task_id").notNull(),
        title: text("title"),
        titleStatus: text("title_status").notNull(),
        titleError: text("title_error"),
        recap: text("recap"),
        metadataUpdatedAtMs: integer("metadata_updated_at_ms"),
        metadataRunId: text("metadata_run_id"),
        interrupted: integer("interrupted", { mode: "boolean" }).notNull(),
        interruptionJson: text("interruption_json"),
        lastMessageAtMs: integer("last_message_at_ms"),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        // Added by later migrations, so they follow the columns of the initial schema.
        delegatedBySessionId: text("delegated_by_session_id"),
        lifetimeTotalTokens: integer("lifetime_total_tokens").notNull().default(0),
        workspaceTransferJson: text("workspace_transfer_json")
            .notNull()
            .default('{"status":"idle"}'),
        workspaceQueueWaiting: integer("workspace_queue_waiting", { mode: "boolean" })
            .notNull()
            .default(false),
    },
    (table) => [
        index("sessions_agent_id").on(table.agentId),
        index("sessions_parent_created").on(table.parentSessionId, table.createdAtMs),
        index("sessions_delegated_created").on(
            table.delegatedBySessionId,
            table.createdAtMs,
            table.id,
        ),
        index("sessions_project_activity").on(
            table.projectId,
            sql`${table.lastMessageAtMs} DESC`,
            sql`${table.updatedAtMs} DESC`,
        ),
        index("sessions_workspace_activity").on(
            table.workspaceId,
            sql`${table.lastMessageAtMs} DESC`,
            sql`${table.updatedAtMs} DESC`,
        ),
        index("sessions_parent_order").on(table.projectId, table.workspaceId, table.orderKey),
    ],
);

export const sessionEvents = sqliteTable(
    "session_events",
    {
        seq: integer("seq").primaryKey({ autoIncrement: true }),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        eventId: text("event_id").notNull().unique(),
        type: text("type").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        dataJson: text("data_json").notNull(),
        runId: text("run_id"),
        messageId: text("message_id"),
        toolCallId: text("tool_call_id"),
    },
    (table) => [
        index("session_events_session_seq").on(table.sessionId, table.seq),
        index("session_events_session_type_seq").on(table.sessionId, table.type, table.seq),
        index("session_events_run_id").on(table.sessionId, table.runId, table.seq),
        index("session_events_message_id").on(table.sessionId, table.messageId, table.seq),
        index("session_events_tool_call_id").on(table.sessionId, table.toolCallId, table.seq),
    ],
);

export const sessionMessages = sqliteTable(
    "session_messages",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        messageId: text("message_id").notNull(),
        role: text("role").notNull(),
        isPartial: integer("is_partial", { mode: "boolean" }).notNull(),
        runId: text("run_id"),
        messageJson: text("message_json").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.position] }),
        index("session_messages_session_message").on(table.sessionId, table.messageId),
    ],
);

export const sessionContextMessages = sqliteTable(
    "session_context_messages",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        messageId: text("message_id").notNull(),
        role: text("role").notNull(),
        messageJson: text("message_json").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.position] }),
        index("session_context_messages_session_message").on(table.sessionId, table.messageId),
    ],
);

export const sessionTurns = sqliteTable(
    "session_turns",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        firstPosition: integer("first_position").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.runId] }),
        index("session_turns_order").on(table.sessionId, table.firstPosition),
    ],
);

export const queuedRuns = sqliteTable(
    "queued_runs",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        debug: integer("debug", { mode: "boolean" }).notNull(),
        debugDirectory: text("debug_directory"),
        displayText: text("display_text").notNull(),
        kind: text("kind").notNull(),
        text: text("text").notNull(),
        userMessageJson: text("user_message_json").notNull(),
        integrationConfigJson: text("integration_config_json"),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [primaryKey({ columns: [table.sessionId, table.runId] })],
);

export const pendingContextMessages = sqliteTable(
    "pending_context_messages",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        messageId: text("message_id").notNull(),
        position: integer("position").notNull(),
        anchorRunId: text("anchor_run_id").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.messageId] }),
        unique().on(table.sessionId, table.position),
        index("pending_context_messages_session_fifo").on(table.sessionId, table.position),
    ],
);

export const sessionShares = sqliteTable(
    "session_shares",
    {
        shareId: text("share_id").primaryKey(),
        ownerSessionId: text("owner_session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        state: text("state").notNull(),
        includeFriendMessages: integer("include_friend_messages", { mode: "boolean" }).notNull(),
        ownerPeerId: text("owner_peer_id").notNull(),
        snapshotThroughPosition: integer("snapshot_through_position"),
        snapshotThroughEventId: text("snapshot_through_event_id"),
        publishedMessagePosition: integer("published_message_position").notNull().default(-1),
        publishedEventSeq: integer("published_event_seq").notNull().default(0),
        nextShareSequence: integer("next_share_sequence").notNull().default(1),
        outboxBytes: integer("outbox_bytes").notNull().default(0),
        outboxCount: integer("outbox_count").notNull().default(0),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        stoppedAtMs: integer("stopped_at_ms"),
        /**
         * How much of each tool's work this share replicates: `summaries` or
         * `full`. Last because the migration that added it appends it, and the
         * Drizzle schema has to describe the columns in the order they exist.
         */
        toolOutput: text("tool_output").notNull().default("summaries"),
    },
    (table) => [
        uniqueIndex("session_shares_one_current_per_owner")
            .on(table.ownerSessionId)
            .where(sql`${table.state} <> 'stopped'`),
        check(
            "session_shares_state_check",
            sql`${table.state} IN ('active', 'degraded', 'stopped')`,
        ),
        check("session_shares_published_seq_check", sql`${table.publishedEventSeq} >= 0`),
        check(
            "session_shares_published_message_check",
            sql`${table.publishedMessagePosition} >= -1`,
        ),
        check("session_shares_next_sequence_check", sql`${table.nextShareSequence} >= 1`),
        check("session_shares_outbox_bytes_check", sql`${table.outboxBytes} >= 0`),
        check("session_shares_outbox_count_check", sql`${table.outboxCount} >= 0`),
        check(
            "session_shares_snapshot_position_check",
            sql`${table.snapshotThroughPosition} IS NULL OR ${table.snapshotThroughPosition} >= 0`,
        ),
    ],
);

export const sessionShareMembers = sqliteTable(
    "session_share_members",
    {
        shareMemberId: text("share_member_id").primaryKey(),
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        murmurPeerId: text("murmur_peer_id").notNull(),
        displayName: text("display_name").notNull(),
        currentGrantEpoch: integer("current_grant_epoch").notNull(),
        state: text("state").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        unique().on(table.shareId, table.murmurPeerId),
        unique().on(table.shareMemberId, table.currentGrantEpoch),
        index("session_share_members_share_state").on(table.shareId, table.state),
        check("session_share_members_epoch_check", sql`${table.currentGrantEpoch} >= 1`),
        check(
            "session_share_members_state_check",
            sql`${table.state} IN ('active', 'revoked', 'stopped')`,
        ),
    ],
);

export const sessionShareSnapshotMessages = sqliteTable(
    "session_share_snapshot_messages",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        messageId: text("message_id").notNull(),
        messageJson: text("message_json").notNull(),
        runId: text("run_id"),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.position] }),
        unique().on(table.shareId, table.messageId),
        check("session_share_snapshot_messages_position_check", sql`${table.position} >= 0`),
    ],
);

export const sessionShareGrants = sqliteTable(
    "session_share_grants",
    {
        shareMemberId: text("share_member_id")
            .notNull()
            .references(() => sessionShareMembers.shareMemberId, { onDelete: "cascade" }),
        grantEpoch: integer("grant_epoch").notNull(),
        state: text("state").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        endedAtMs: integer("ended_at_ms"),
    },
    (table) => [
        primaryKey({ columns: [table.shareMemberId, table.grantEpoch] }),
        index("session_share_grants_state").on(table.shareMemberId, table.state),
        check("session_share_grants_epoch_check", sql`${table.grantEpoch} >= 1`),
        check(
            "session_share_grants_state_check",
            sql`${table.state} IN ('active', 'revoked', 'stopped')`,
        ),
    ],
);

export const sessionShareOutbox = sqliteTable(
    "session_share_outbox",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        sequence: integer("sequence").notNull(),
        shareEventId: text("share_event_id").notNull().unique(),
        sourceEventSeq: integer("source_event_seq").references(() => sessionEvents.seq, {
            onDelete: "set null",
        }),
        canonicalJson: text("canonical_json").notNull(),
        contentHash: text("content_hash").notNull(),
        byteLength: integer("byte_length").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.sequence] }),
        unique().on(table.shareId, table.sourceEventSeq),
        index("session_share_outbox_source_event").on(table.shareId, table.sourceEventSeq),
        check("session_share_outbox_sequence_check", sql`${table.sequence} >= 1`),
        check("session_share_outbox_byte_length_check", sql`${table.byteLength} >= 0`),
        check(
            "session_share_outbox_source_event_check",
            sql`${table.sourceEventSeq} IS NULL OR ${table.sourceEventSeq} >= 0`,
        ),
    ],
);

export const sessionShareFriendMessages = sqliteTable(
    "session_share_friend_messages",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        shareMemberId: text("share_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        clientMessageId: text("client_message_id").notNull(),
        messageId: text("message_id").notNull().unique(),
        ownerSessionId: text("owner_session_id").notNull(),
        ownerPosition: integer("owner_position").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        unique().on(table.shareId, table.shareMemberId, table.grantEpoch, table.clientMessageId),
        foreignKey({
            columns: [table.shareMemberId, table.grantEpoch],
            foreignColumns: [sessionShareGrants.shareMemberId, sessionShareGrants.grantEpoch],
        }).onDelete("cascade"),
        foreignKey({
            columns: [table.ownerSessionId, table.ownerPosition],
            foreignColumns: [sessionMessages.sessionId, sessionMessages.position],
        }).onDelete("cascade"),
        index("session_share_friend_messages_owner").on(table.ownerSessionId, table.ownerPosition),
        check("session_share_friend_messages_position_check", sql`${table.ownerPosition} >= 0`),
    ],
);

export const sessionShareMessageContext = sqliteTable(
    "session_share_message_context",
    {
        messageId: text("message_id")
            .primaryKey()
            .references(() => sessionShareFriendMessages.messageId, { onDelete: "cascade" }),
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        shareMemberId: text("share_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        disposition: text("disposition").notNull(),
        includedRunId: text("included_run_id"),
        byteEstimate: integer("byte_estimate").notNull(),
        tokenEstimate: integer("token_estimate").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        foreignKey({
            columns: [table.shareMemberId, table.grantEpoch],
            foreignColumns: [sessionShareGrants.shareMemberId, sessionShareGrants.grantEpoch],
        }).onDelete("cascade"),
        index("session_share_message_context_disposition").on(
            table.shareId,
            table.disposition,
            table.updatedAtMs,
        ),
        check(
            "session_share_message_context_disposition_check",
            sql`${table.disposition} IN ('pending', 'included', 'overflow')`,
        ),
        check("session_share_message_context_bytes_check", sql`${table.byteEstimate} >= 0`),
        check("session_share_message_context_tokens_check", sql`${table.tokenEstimate} >= 0`),
    ],
);

export const sessionShareReplicas = sqliteTable(
    "session_share_replicas",
    {
        shareId: text("share_id").primaryKey(),
        ownerPeerId: text("owner_peer_id").notNull(),
        murmurPeerId: text("murmur_peer_id").notNull(),
        shareMemberId: text("share_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        appliedThroughSequence: integer("applied_through_sequence").notNull().default(0),
        title: text("title").notNull(),
        memberCount: integer("member_count").notNull(),
        state: text("state").notNull(),
        endedReason: text("ended_reason"),
        endedAtMs: integer("ended_at_ms"),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        index("session_share_replicas_member").on(table.shareMemberId, table.grantEpoch),
        check("session_share_replicas_epoch_check", sql`${table.grantEpoch} >= 1`),
        check(
            "session_share_replicas_applied_sequence_check",
            sql`${table.appliedThroughSequence} >= 0`,
        ),
        check("session_share_replicas_member_count_check", sql`${table.memberCount} >= 0`),
        check("session_share_replicas_state_check", sql`${table.state} IN ('active', 'ended')`),
    ],
);

export const sessionShareReplicaEntries = sqliteTable(
    "session_share_replica_entries",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShareReplicas.shareId, { onDelete: "cascade" }),
        shareEventId: text("share_event_id").notNull(),
        grantMemberId: text("grant_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        sequence: integer("sequence").notNull(),
        canonicalJson: text("canonical_json").notNull(),
        contentHash: text("content_hash").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.shareEventId] }),
        unique().on(table.shareId, table.sequence),
        check("session_share_replica_entries_epoch_check", sql`${table.grantEpoch} >= 1`),
        check("session_share_replica_entries_sequence_check", sql`${table.sequence} >= 1`),
    ],
);

export const sessionShareEntries = sqliteTable(
    "session_share_entries",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        sequence: integer("sequence").notNull(),
        shareEventId: text("share_event_id").notNull(),
        contentHash: text("content_hash").notNull(),
        canonicalJson: text("canonical_json").notNull(),
        byteLength: integer("byte_length").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.sequence] }),
        check("session_share_entries_sequence_check", sql`${table.sequence} >= 1`),
        check("session_share_entries_byte_length_check", sql`${table.byteLength} >= 0`),
    ],
);

export const sessionShareCapabilities = sqliteTable(
    "session_share_capabilities",
    {
        shareMemberId: text("share_member_id")
            .notNull()
            .references(() => sessionShareMembers.shareMemberId, { onDelete: "cascade" }),
        capability: text("capability").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        state: text("state").notNull(),
        grantedAtMs: integer("granted_at_ms").notNull(),
        revokedAtMs: integer("revoked_at_ms"),
    },
    (table) => [
        primaryKey({ columns: [table.shareMemberId, table.capability, table.grantEpoch] }),
        index("session_share_capabilities_state").on(table.shareMemberId, table.state),
        check(
            "session_share_capabilities_capability_check",
            sql`${table.capability} IN ('terminal_view')`,
        ),
        check("session_share_capabilities_epoch_check", sql`${table.grantEpoch} >= 1`),
        check(
            "session_share_capabilities_state_check",
            sql`${table.state} IN ('active', 'revoked')`,
        ),
    ],
);

export const sessionSharePeerActions = sqliteTable(
    "session_share_peer_actions",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => sessionShares.shareId, { onDelete: "cascade" }),
        // Deliberately no foreign key on share_member_id: an audit row must outlive
        // the member it describes, because revoking or stopping a share deletes
        // members but must not erase the record of what a peer did.
        shareMemberId: text("share_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        seq: integer("seq").notNull(),
        capability: text("capability").notNull(),
        action: text("action").notNull(),
        detail: text("detail"),
        outcome: text("outcome").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.seq] }),
        index("session_share_peer_actions_recent").on(table.shareId, desc(table.createdAtMs)),
        check("session_share_peer_actions_epoch_check", sql`${table.grantEpoch} >= 1`),
        check("session_share_peer_actions_seq_check", sql`${table.seq} >= 1`),
        check(
            "session_share_peer_actions_capability_check",
            sql`${table.capability} IN ('terminal_view')`,
        ),
        check(
            "session_share_peer_actions_outcome_check",
            sql`${table.outcome} IN ('allowed', 'denied')`,
        ),
    ],
);

export const scopeShares = sqliteTable(
    "scope_shares",
    {
        shareId: text("share_id").primaryKey(),
        scopeKind: text("scope_kind").notNull(),
        scopeId: text("scope_id").notNull(),
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        state: text("state").notNull(),
        ownerPeerId: text("owner_peer_id").notNull(),
        nextShareSequence: integer("next_share_sequence").notNull().default(1),
        publishedScopeVersion: integer("published_scope_version").notNull().default(-1),
        outboxBytes: integer("outbox_bytes").notNull().default(0),
        outboxCount: integer("outbox_count").notNull().default(0),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        stoppedAtMs: integer("stopped_at_ms"),
    },
    (table) => [
        uniqueIndex("scope_shares_one_current_per_scope")
            .on(table.scopeKind, table.scopeId)
            .where(sql`${table.state} <> 'stopped'`),
        index("scope_shares_project").on(table.projectId, table.state),
        check("scope_shares_kind_check", sql`${table.scopeKind} IN ('workspace', 'project')`),
        check("scope_shares_state_check", sql`${table.state} IN ('active', 'degraded', 'stopped')`),
        check("scope_shares_next_sequence_check", sql`${table.nextShareSequence} >= 1`),
        check("scope_shares_scope_version_check", sql`${table.publishedScopeVersion} >= -1`),
        check("scope_shares_outbox_bytes_check", sql`${table.outboxBytes} >= 0`),
        check("scope_shares_outbox_count_check", sql`${table.outboxCount} >= 0`),
    ],
);

export const scopeShareMembers = sqliteTable(
    "scope_share_members",
    {
        shareMemberId: text("share_member_id").primaryKey(),
        shareId: text("share_id")
            .notNull()
            .references(() => scopeShares.shareId, { onDelete: "cascade" }),
        murmurPeerId: text("murmur_peer_id").notNull(),
        displayName: text("display_name").notNull(),
        currentGrantEpoch: integer("current_grant_epoch").notNull(),
        state: text("state").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        unique().on(table.shareId, table.murmurPeerId),
        unique().on(table.shareMemberId, table.currentGrantEpoch),
        index("scope_share_members_share_state").on(table.shareId, table.state),
        check("scope_share_members_epoch_check", sql`${table.currentGrantEpoch} >= 1`),
        check(
            "scope_share_members_state_check",
            sql`${table.state} IN ('active', 'revoked', 'stopped')`,
        ),
    ],
);

export const scopeShareGrants = sqliteTable(
    "scope_share_grants",
    {
        shareMemberId: text("share_member_id")
            .notNull()
            .references(() => scopeShareMembers.shareMemberId, { onDelete: "cascade" }),
        grantEpoch: integer("grant_epoch").notNull(),
        state: text("state").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        endedAtMs: integer("ended_at_ms"),
    },
    (table) => [
        primaryKey({ columns: [table.shareMemberId, table.grantEpoch] }),
        index("scope_share_grants_state").on(table.shareMemberId, table.state),
        check("scope_share_grants_epoch_check", sql`${table.grantEpoch} >= 1`),
        check(
            "scope_share_grants_state_check",
            sql`${table.state} IN ('active', 'revoked', 'stopped')`,
        ),
    ],
);

export const scopeShareSessionCursors = sqliteTable(
    "scope_share_session_cursors",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => scopeShares.shareId, { onDelete: "cascade" }),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        rotationSeq: integer("rotation_seq").notNull().default(0),
        publishedEventSeq: integer("published_event_seq").notNull().default(0),
        indexVersion: integer("index_version").notNull().default(-1),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.sessionId] }),
        index("scope_share_session_cursors_rotation").on(
            table.shareId,
            table.rotationSeq,
            table.sessionId,
        ),
        check("scope_share_session_cursors_rotation_check", sql`${table.rotationSeq} >= 0`),
        check("scope_share_session_cursors_event_check", sql`${table.publishedEventSeq} >= 0`),
        check("scope_share_session_cursors_index_check", sql`${table.indexVersion} >= -1`),
    ],
);

export const scopeShareOutbox = sqliteTable(
    "scope_share_outbox",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => scopeShares.shareId, { onDelete: "cascade" }),
        sequence: integer("sequence").notNull(),
        shareEventId: text("share_event_id").notNull().unique(),
        subjectKind: text("subject_kind").notNull(),
        subjectId: text("subject_id").notNull(),
        sourceEventSeq: integer("source_event_seq").references(() => sessionEvents.seq, {
            onDelete: "set null",
        }),
        canonicalJson: text("canonical_json").notNull(),
        contentHash: text("content_hash").notNull(),
        byteLength: integer("byte_length").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.sequence] }),
        unique().on(table.shareId, table.sourceEventSeq),
        index("scope_share_outbox_subject").on(table.shareId, table.subjectKind, table.subjectId),
        index("scope_share_outbox_source_event").on(table.shareId, table.sourceEventSeq),
        check("scope_share_outbox_sequence_check", sql`${table.sequence} >= 1`),
        check("scope_share_outbox_byte_length_check", sql`${table.byteLength} >= 0`),
        check(
            "scope_share_outbox_subject_kind_check",
            sql`${table.subjectKind} IN ('scope', 'session_index', 'session_event')`,
        ),
        check(
            "scope_share_outbox_source_event_check",
            sql`${table.sourceEventSeq} IS NULL OR ${table.sourceEventSeq} >= 0`,
        ),
    ],
);

export const scopeShareEntries = sqliteTable(
    "scope_share_entries",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => scopeShares.shareId, { onDelete: "cascade" }),
        sequence: integer("sequence").notNull(),
        shareEventId: text("share_event_id").notNull(),
        subjectKind: text("subject_kind").notNull(),
        subjectId: text("subject_id").notNull(),
        contentHash: text("content_hash").notNull(),
        canonicalJson: text("canonical_json").notNull(),
        byteLength: integer("byte_length").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.sequence] }),
        index("scope_share_entries_subject").on(
            table.shareId,
            table.subjectKind,
            table.subjectId,
            table.sequence,
        ),
        check("scope_share_entries_sequence_check", sql`${table.sequence} >= 1`),
        check("scope_share_entries_byte_length_check", sql`${table.byteLength} >= 0`),
        check(
            "scope_share_entries_subject_kind_check",
            sql`${table.subjectKind} IN ('scope', 'session_index', 'session_event')`,
        ),
    ],
);

export const scopeShareReplicas = sqliteTable(
    "scope_share_replicas",
    {
        shareId: text("share_id").primaryKey(),
        scopeKind: text("scope_kind").notNull(),
        ownerPeerId: text("owner_peer_id").notNull(),
        murmurPeerId: text("murmur_peer_id").notNull(),
        shareMemberId: text("share_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        appliedThroughSequence: integer("applied_through_sequence").notNull().default(0),
        title: text("title").notNull(),
        memberCount: integer("member_count").notNull(),
        state: text("state").notNull(),
        endedReason: text("ended_reason"),
        endedAtMs: integer("ended_at_ms"),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        index("scope_share_replicas_member").on(table.shareMemberId, table.grantEpoch),
        check(
            "scope_share_replicas_kind_check",
            sql`${table.scopeKind} IN ('workspace', 'project')`,
        ),
        check("scope_share_replicas_epoch_check", sql`${table.grantEpoch} >= 1`),
        check(
            "scope_share_replicas_applied_sequence_check",
            sql`${table.appliedThroughSequence} >= 0`,
        ),
        check("scope_share_replicas_member_count_check", sql`${table.memberCount} >= 0`),
        check("scope_share_replicas_state_check", sql`${table.state} IN ('active', 'ended')`),
    ],
);

export const scopeShareReplicaEntries = sqliteTable(
    "scope_share_replica_entries",
    {
        shareId: text("share_id")
            .notNull()
            .references(() => scopeShareReplicas.shareId, { onDelete: "cascade" }),
        shareEventId: text("share_event_id").notNull(),
        grantMemberId: text("grant_member_id").notNull(),
        grantEpoch: integer("grant_epoch").notNull(),
        sequence: integer("sequence").notNull(),
        subjectKind: text("subject_kind").notNull(),
        subjectId: text("subject_id").notNull(),
        canonicalJson: text("canonical_json").notNull(),
        contentHash: text("content_hash").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.shareEventId] }),
        unique().on(table.shareId, table.sequence),
        index("scope_share_replica_entries_session").on(
            table.shareId,
            table.subjectKind,
            table.subjectId,
            table.sequence,
        ),
        check("scope_share_replica_entries_epoch_check", sql`${table.grantEpoch} >= 1`),
        check("scope_share_replica_entries_sequence_check", sql`${table.sequence} >= 1`),
        check(
            "scope_share_replica_entries_subject_kind_check",
            sql`${table.subjectKind} IN ('scope', 'session_index', 'session_event')`,
        ),
    ],
);

export const externalToolCalls = sqliteTable(
    "external_tool_calls",
    {
        id: text("id").primaryKey(),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        batchId: text("batch_id").notNull(),
        toolCallId: text("tool_call_id").notNull(),
        providerToolCallId: text("provider_tool_call_id"),
        toolCallIndex: integer("tool_call_index").notNull(),
        definitionJson: text("definition_json").notNull(),
        skillJson: text("skill_json"),
        argumentsJson: text("arguments_json").notNull(),
        status: text("status").notNull(),
        resolutionJson: text("resolution_json"),
        consumed: integer("consumed", { mode: "boolean" }).notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        resolvedAtMs: integer("resolved_at_ms"),
    },
    (table) => [
        index("external_tool_calls_session_created").on(table.sessionId, table.createdAtMs),
    ],
);

export const durableUserInputs = sqliteTable(
    "durable_user_inputs",
    {
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        requestId: text("request_id").notNull(),
        runId: text("run_id").notNull(),
        batchId: text("batch_id").notNull(),
        toolCallId: text("tool_call_id").notNull(),
        providerToolCallId: text("provider_tool_call_id"),
        toolCallIndex: integer("tool_call_index").notNull(),
        toolName: text("tool_name").notNull(),
        toolArgumentsJson: text("tool_arguments_json").notNull(),
        kind: text("kind").notNull(),
        permissionJson: text("permission_json"),
        requestJson: text("request_json").notNull(),
        responseJson: text("response_json"),
        resultJson: text("result_json"),
        status: text("status").notNull(),
        consumed: integer("consumed", { mode: "boolean" }).notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        resolvedAtMs: integer("resolved_at_ms"),
        detachedAtMs: integer("detached_at_ms"),
        answerDueAtMs: integer("answer_due_at_ms"),
        answerWaitStartedAtMs: integer("answer_wait_started_at_ms"),
    },
    (table) => [
        primaryKey({ columns: [table.sessionId, table.requestId] }),
        index("durable_user_inputs_session_created").on(table.sessionId, table.createdAtMs),
    ],
);

export const durableWaits = sqliteTable(
    "durable_waits",
    {
        id: text("id").primaryKey(),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        runId: text("run_id").notNull(),
        batchId: text("batch_id").notNull(),
        toolCallId: text("tool_call_id").notNull(),
        providerToolCallId: text("provider_tool_call_id"),
        toolCallIndex: integer("tool_call_index").notNull(),
        toolName: text("tool_name").notNull(),
        kind: text("kind").notNull(),
        argumentsJson: text("arguments_json").notNull(),
        status: text("status").notNull(),
        consumed: integer("consumed", { mode: "boolean" }).notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        dueAtMs: integer("due_at_ms").notNull(),
        resultJson: text("result_json"),
        resultBlockJson: text("result_block_json"),
    },
    (table) => [
        unique().on(table.sessionId, table.toolCallId),
        index("durable_waits_session_created").on(table.sessionId, table.createdAtMs),
    ],
);

export const scheduledMessages = sqliteTable(
    "scheduled_messages",
    {
        id: text("id").primaryKey(),
        senderSessionId: text("sender_session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        targetAgentId: text("target_agent_id").notNull(),
        message: text("message").notNull(),
        dueAtMs: integer("due_at_ms").notNull(),
        status: text("status").notNull(),
        failure: text("failure"),
        deliveredAtMs: integer("delivered_at_ms"),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        index("scheduled_messages_sender_created").on(table.senderSessionId, table.createdAtMs),
        index("scheduled_messages_pending_due").on(table.status, table.dueAtMs),
    ],
);

export const secretRegistrations = sqliteTable("secret_registrations", {
    id: text("id").primaryKey(),
    description: text("description").notNull(),
    environmentJson: text("environment_json").notNull(),
});

export const secretEnvironmentVariables = sqliteTable(
    "secret_environment_variables",
    {
        secretId: text("secret_id")
            .notNull()
            .references(() => secretRegistrations.id, { onDelete: "cascade" }),
        normalizedName: text("normalized_name").notNull(),
        name: text("name").notNull(),
    },
    (table) => [primaryKey({ columns: [table.secretId, table.normalizedName] })],
);

export const projectSecretAttachments = sqliteTable(
    "project_secret_attachments",
    {
        projectId: text("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        secretId: text("secret_id")
            .notNull()
            .references(() => secretRegistrations.id, { onDelete: "cascade" }),
    },
    (table) => [primaryKey({ columns: [table.projectId, table.secretId] })],
);

export const happySessions = sqliteTable("happy_sessions", {
    sessionId: text("session_id")
        .primaryKey()
        .references(() => sessions.id, { onDelete: "cascade" }),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    tag: text("tag").notNull(),
    remoteSessionId: text("remote_session_id"),
    encryptionVariant: text("encryption_variant").notNull(),
    encryptionKeyBase64: text("encryption_key_base64").notNull(),
    lastRemoteSeq: integer("last_remote_seq").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const happyOutbox = sqliteTable(
    "happy_outbox",
    {
        seq: integer("seq").primaryKey({ autoIncrement: true }),
        sessionId: text("session_id")
            .notNull()
            .references(() => sessions.id, { onDelete: "cascade" }),
        localId: text("local_id").notNull(),
        payloadJson: text("payload_json").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        unique().on(table.sessionId, table.localId),
        index("happy_outbox_session_seq").on(table.sessionId, table.seq),
    ],
);

export const happyCloudEnrollment = sqliteTable("happy_cloud_enrollment", {
    singletonId: integer("singleton_id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    version: integer("version").notNull(),
    enrollmentState: text("enrollment_state").notNull(),
    enrollmentChangedAtMs: integer("enrollment_changed_at_ms").notNull(),
    friendsConsent: text("friends_consent").notNull(),
    friendsChangedAtMs: integer("friends_changed_at_ms").notNull(),
    groupChatsConsent: text("group_chats_consent").notNull(),
    groupChatsChangedAtMs: integer("group_chats_changed_at_ms").notNull(),
    liveSessionSharingConsent: text("live_session_sharing_consent").notNull(),
    liveSessionSharingChangedAtMs: integer("live_session_sharing_changed_at_ms").notNull(),
    remoteControlConsent: text("remote_control_consent").notNull(),
    remoteControlChangedAtMs: integer("remote_control_changed_at_ms").notNull(),
    sessionBlobPersistenceConsent: text("session_blob_persistence_consent").notNull(),
    sessionBlobPersistenceChangedAtMs: integer("session_blob_persistence_changed_at_ms").notNull(),
    happyProfileConsent: text("happy_profile_consent").notNull(),
    happyProfileChangedAtMs: integer("happy_profile_changed_at_ms").notNull(),
    profileCiphertext: text("profile_ciphertext"),
    profileVersion: integer("profile_version"),
    profileChangedAtMs: integer("profile_changed_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const happyCloudSessionBlobs = sqliteTable("happy_cloud_session_blobs", {
    sessionId: text("session_id").primaryKey(),
    ciphertext: text("ciphertext").notNull(),
    version: integer("version").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const happyCloudMutationReceipts = sqliteTable("happy_cloud_mutation_receipts", {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    mutationId: text("mutation_id").notNull().unique(),
    requestFingerprint: text("request_fingerprint").notNull(),
    responseJson: text("response_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
});

export const slotEntries = sqliteTable("slot_entries", {
    id: text("id").primaryKey(),
    slot: text("slot").notNull(),
    scope: text("scope").notNull(),
    projectId: text("project_id").references(() => projects.id),
    workspaceId: text("workspace_id").references(() => projectWorkspaces.id),
    sessionId: text("session_id"),
    contentJson: text("content_json").notNull(),
    authorType: text("author_type").notNull(),
    authorId: text("author_id").notNull(),
    authorName: text("author_name"),
    description: text("description").notNull(),
    purpose: text("purpose").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const webapps = sqliteTable("webapps", {
    name: text("name").primaryKey(),
    description: text("description").notNull(),
    purpose: text("purpose").notNull(),
    authorSessionId: text("author_session_id").notNull(),
    sourceDescription: text("source_description"),
    currentVersion: integer("current_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    iconThumbhash: text("icon_thumbhash").notNull(),
    allowedScopesJson: text("allowed_scopes_json").notNull(),
});

export const webappVersions = sqliteTable(
    "webapp_versions",
    {
        webappName: text("webapp_name")
            .notNull()
            .references(() => webapps.name, { onDelete: "cascade" }),
        version: integer("version").notNull(),
        changeDescription: text("change_description").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [primaryKey({ columns: [table.webappName, table.version] })],
);

export const durableGlobalEvents = sqliteTable("durable_global_events", {
    cursor: text("cursor").primaryKey(),
    eventId: text("event_id").notNull().unique(),
    aggregateKind: text("aggregate_kind").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    type: text("type").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    dataJson: text("data_json").notNull(),
});

export const durableGlobalEventState = sqliteTable("durable_global_event_state", {
    trimmedThroughCursor: text("trimmed_through_cursor").primaryKey(),
});
