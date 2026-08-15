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
} from "drizzle-orm/sqlite-core";

export const agentRecords = sqliteTable(
    "agent_records",
    {
        sequence: integer("sequence").primaryKey({ autoIncrement: true }),
        agentId: text("agent_id").notNull(),
        recordJson: text("record_json").notNull(),
    },
    (table) => [index("agent_records_agent_sequence").on(table.agentId, table.sequence)],
);

export const agentValues = sqliteTable(
    "agent_values",
    {
        agentId: text("agent_id").notNull(),
        key: text("key").notNull(),
        valueJson: text("value_json").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.agentId, table.key] }),
        index("agent_values_key_agent").on(table.key, table.agentId),
    ],
);

/**
 * Rig's indexed caller-owned message receipt and immutable retry envelope.
 *
 * Settled rows are retained as the durable idempotency archive after the session event log's
 * in-memory retention expires. A future pruning policy must remove them only with an explicit
 * session/marker retention decision; queued and consumed rows are live recovery state.
 */
export const agentMessageSubmissions = sqliteTable(
    "agent_message_submissions",
    {
        agentId: text("agent_id").notNull(),
        messageId: text("message_id").notNull(),
        sessionId: text("session_id").notNull(),
        runId: text("run_id").notNull(),
        delivery: text("delivery").notNull(),
        status: text("status").notNull(),
        fingerprint: text("fingerprint").notNull(),
        metadataJson: text("metadata_json").notNull(),
        messageJson: text("message_json").notNull(),
        inputJson: text("input_json").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.agentId, table.messageId] }),
        index("agent_message_submissions_agent_status").on(
            table.agentId,
            table.status,
            table.createdAtMs,
            table.messageId,
        ),
        index("agent_message_submissions_agent_run_status").on(
            table.agentId,
            table.runId,
            table.status,
            table.messageId,
        ),
    ],
);

/** Durable Rig-owned history records supplied to the Agent Base History feature. */
export const agentHistory = sqliteTable(
    "agent_history",
    {
        agentId: text("agent_id").notNull(),
        position: integer("position").notNull(),
        recordId: text("record_id").notNull(),
        messageJson: text("message_json").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.agentId, table.position] }),
        unique().on(table.agentId, table.recordId),
    ],
);

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

export const onboardingState = sqliteTable(
    "onboarding_state",
    {
        singleton: integer("singleton").notNull().primaryKey(),
        completedVersion: integer("completed_version").notNull().default(0),
    },
    (state) => [
        check("onboarding_state_singleton", sql`${state.singleton} = 1`),
        check("onboarding_state_completed_version", sql`${state.completedVersion} >= 0`),
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

export const rigProfiles = sqliteTable(
    "rig_profiles",
    {
        id: text("id").notNull().primaryKey(),
        parentInstanceId: text("parent_instance_id").notNull(),
        name: text("name").notNull(),
        photoJson: text("photo_json"),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        email: text("email").notNull(),
    },
    (table) => [index("rig_profiles_parent_instance").on(table.parentInstanceId, table.id)],
);

export const p2pProvisionedProviders = sqliteTable(
    "p2p_provisioned_providers",
    {
        ownerInstanceId: text("owner_instance_id").notNull(),
        providerId: text("provider_id").notNull(),
        publicConfigJson: text("public_config_json").notNull(),
        encryptedMaterialJson: text("encrypted_material_json"),
        sourceDigest: text("source_digest").notNull(),
        visibility: text("visibility").notNull(),
        position: integer("position").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.ownerInstanceId, table.providerId] }),
        index("p2p_provisioned_providers_owner_position").on(
            table.ownerInstanceId,
            table.position,
            table.providerId,
        ),
    ],
);

export const p2pCredentialSnapshots = sqliteTable("p2p_credential_snapshots", {
    ownerInstanceId: text("owner_instance_id").primaryKey(),
    version: integer("version").notNull(),
    sourceDigest: text("source_digest").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
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
        remoteSourceJson: text("remote_source_json"),
        requiredSecretKind: text("required_secret_kind"),
        creatorInstanceId: text("creator_instance_id"),
        creatorProfileId: text("creator_profile_id"),
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
        /** Set when the name was chosen on purpose, which stops the first chat from naming it. */
        nameConfigured: integer("name_configured", { mode: "boolean" }).notNull(),
        /** Branch Rig manages for this worktree; it follows the name and outlives storage_key. */
        branch: text("branch").notNull(),
        creatorInstanceId: text("creator_instance_id"),
        creatorProfileId: text("creator_profile_id"),
    },
    (table) => [
        unique().on(table.projectId, table.storageKey),
        unique().on(table.projectId, table.nameKey),
        index("project_workspaces_project_updated").on(table.projectId, desc(table.updatedAtMs)),
        index("project_workspaces_project_order").on(table.projectId, table.orderKey),
    ],
);

export const folders = sqliteTable(
    "folders",
    {
        id: text("id").primaryKey(),
        /** Virtual parent. Null places the folder at the root of the tree. */
        parentId: text("parent_id"),
        name: text("name").notNull(),
        description: text("description"),
        rules: text("rules"),
        /** A single emoji. Pictures and built-in icons are not stored yet. */
        icon: text("icon"),
        orderKey: text("order_key").notNull(),
        /** Flat storage directory named after the folder's own id. */
        path: text("path").notNull().unique(),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        archivedAtMs: integer("archived_at_ms"),
        /** Murmur MLS session identity for a shared root; null for ordinary folders. */
        sharedGroupId: text("shared_group_id"),
    },
    (table) => [
        foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }),
        index("folders_parent_order").on(table.parentId, table.orderKey),
    ],
);

export const folderShares = sqliteTable("folder_shares", {
    groupId: text("group_id").primaryKey(),
    shareId: text("share_id").notNull().unique(),
    rootFolderId: text("root_folder_id")
        .notNull()
        .unique()
        .references(() => folders.id),
    stateJson: text("state_json").notNull(),
    logicalClock: integer("logical_clock").notNull(),
    status: text("status", { enum: ["syncing", "synced", "error"] }).notNull(),
    error: text("error"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    lastSyncedAtMs: integer("last_synced_at_ms"),
});

export const folderShareIntents = sqliteTable("folder_share_intents", {
    shareId: text("share_id").primaryKey(),
    rootFolderId: text("root_folder_id")
        .notNull()
        .unique()
        .references(() => folders.id),
    stateJson: text("state_json").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
});

export const folderShareNodes = sqliteTable(
    "folder_share_nodes",
    {
        groupId: text("group_id")
            .notNull()
            .references(() => folderShares.groupId, { onDelete: "cascade" }),
        folderId: text("folder_id").notNull(),
        nodeJson: text("node_json"),
        logicalClock: integer("logical_clock").notNull(),
        sender: text("sender").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.folderId] })],
);

export const folderShareUpdates = sqliteTable(
    "folder_share_updates",
    {
        deliveryId: text("delivery_id").primaryKey(),
        groupId: text("group_id")
            .notNull()
            .references(() => folderShares.groupId, { onDelete: "cascade" }),
        operationId: text("operation_id").notNull(),
        sender: text("sender").notNull(),
        logicalClock: integer("logical_clock").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [unique().on(table.groupId, table.operationId)],
);

export const folderShareOutbox = sqliteTable(
    "folder_share_outbox",
    {
        operationId: text("operation_id").primaryKey(),
        groupId: text("group_id")
            .notNull()
            .references(() => folderShares.groupId, { onDelete: "cascade" }),
        payloadJson: text("payload_json").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [index("folder_share_outbox_pending").on(table.createdAtMs, table.operationId)],
);

export const sessions = sqliteTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        agentId: text("agent_id").notNull(),
        scopeKind: text("scope_kind", {
            enum: ["project", "workspace", "folder", "unsorted"],
        })
            .notNull()
            .default("project"),
        projectId: text("project_id").references(() => projects.id),
        workspaceId: text("workspace_id").references(() => projectWorkspaces.id),
        /** Folder scope identity; null for every other scope. */
        folderId: text("folder_id").references(() => folders.id),
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
        /** When a chat started out belonging nowhere. Null once it has been filed, or never was. */
        unsortedSinceMs: integer("unsorted_since_ms"),
        ownerInstanceId: text("owner_instance_id").notNull(),
        profileId: text("profile_id"),
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
        index("sessions_project_order").on(table.scopeKind, table.projectId, table.orderKey),
        index("sessions_workspace_order").on(table.scopeKind, table.workspaceId, table.orderKey),
        index("sessions_folder_order").on(table.scopeKind, table.folderId, table.orderKey),
        index("sessions_unsorted_order").on(table.scopeKind, table.orderKey),
    ],
);

/** Singleton revision for light folder-catalog invalidations. */
export const folderCatalog = sqliteTable("folder_catalog", {
    id: integer("id").primaryKey(),
    revision: integer("revision").notNull(),
});

/** Bounded receipts that make ambiguous folder mutation retries idempotent. */
export const folderMutations = sqliteTable(
    "folder_mutations",
    {
        mutationId: text("mutation_id").primaryKey(),
        action: text("action").notNull(),
        folderId: text("folder_id").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [index("folder_mutations_created").on(table.createdAtMs, table.mutationId)],
);

export const documents = sqliteTable("documents", {
    id: text("id").primaryKey(),
    mimeType: text("mime_type").notNull(),
    stateJson: text("state_json").notNull(),
    version: integer("version").notNull(),
    firstRetainedVersion: integer("first_retained_version").notNull(),
    createdByInstanceId: text("created_by_instance_id").notNull(),
    createdByProfileId: text("created_by_profile_id"),
    unreadCursor: text("unread_cursor"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});

export const documentUpdates = sqliteTable(
    "document_updates",
    {
        id: text("id").primaryKey(),
        documentId: text("document_id")
            .notNull()
            .references(() => documents.id),
        version: integer("version").notNull(),
        updateJson: text("update_json").notNull(),
        byteLength: integer("byte_length").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        unique().on(table.documentId, table.version),
        index("document_updates_document_version").on(table.documentId, table.version),
    ],
);

export const documentMutations = sqliteTable(
    "document_mutations",
    {
        mutationId: text("mutation_id").primaryKey(),
        action: text("action").notNull(),
        documentId: text("document_id").notNull(),
        requestFingerprint: text("request_fingerprint").notNull(),
        resultVersion: integer("result_version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [index("document_mutations_created").on(table.createdAtMs, table.mutationId)],
);

export const folderItems = sqliteTable(
    "folder_items",
    {
        id: text("id").primaryKey(),
        folderId: text("folder_id")
            .notNull()
            .references(() => folders.id),
        projectId: text("project_id").references(() => projects.id),
        workspaceId: text("workspace_id").references(() => projectWorkspaces.id),
        documentId: text("document_id").references(() => documents.id),
        orderKey: text("order_key").notNull(),
        version: integer("version").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        updatedAtMs: integer("updated_at_ms").notNull(),
        archivedAtMs: integer("archived_at_ms"),
    },
    (table) => [
        check(
            "folder_items_exactly_one_target",
            sql`(${table.projectId} IS NOT NULL) + (${table.workspaceId} IS NOT NULL) + (${table.documentId} IS NOT NULL) = 1`,
        ),
        index("folder_items_folder_order").on(
            table.folderId,
            table.archivedAtMs,
            table.orderKey,
            table.id,
        ),
    ],
);

export const folderItemMutations = sqliteTable(
    "folder_item_mutations",
    {
        mutationId: text("mutation_id").primaryKey(),
        action: text("action").notNull(),
        itemId: text("item_id").notNull(),
        requestFingerprint: text("request_fingerprint").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [
        index("folder_item_mutations_created").on(table.createdAtMs, table.mutationId),
        index("folder_item_mutations_item_created").on(
            table.itemId,
            table.createdAtMs,
            table.mutationId,
        ),
    ],
);

/** Bounded receipts that make ambiguous session mutation retries idempotent. */
export const sessionMutations = sqliteTable(
    "session_mutations",
    {
        mutationId: text("mutation_id").primaryKey(),
        action: text("action").notNull(),
        sessionId: text("session_id").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [index("session_mutations_created").on(table.createdAtMs, table.mutationId)],
);

export const sessionCredentialBindings = sqliteTable("session_credential_bindings", {
    sessionId: text("session_id")
        .primaryKey()
        .references(() => sessions.id, { onDelete: "cascade" }),
    bindingId: text("binding_id").notNull(),
});

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
    historyBackfilled: integer("history_backfilled", { mode: "boolean" }).notNull(),
    projectedEventSeq: integer("projected_event_seq"),
    projectedEventId: text("projected_event_id"),
    projectionStatus: text("projection_status", { enum: ["active", "stalled"] })
        .notNull()
        .default("active"),
    projectionError: text("projection_error"),
    projectionStallCause: text("projection_stall_cause", {
        enum: ["capacity", "event_too_large", "gap"],
    }),
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
        deferred: integer("deferred", { mode: "boolean" }).notNull().default(false),
    },
    (table) => [
        unique().on(table.sessionId, table.localId),
        index("happy_outbox_session_seq").on(table.sessionId, table.seq),
        index("happy_outbox_session_deferred_seq").on(table.sessionId, table.deferred, table.seq),
    ],
);

export const happyCloudEnrollment = sqliteTable("happy_cloud_enrollment", {
    singletonId: integer("singleton_id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    version: integer("version").notNull(),
    enrollmentState: text("enrollment_state").notNull(),
    enrollmentChangedAtMs: integer("enrollment_changed_at_ms").notNull(),
    groupChatsConsent: text("group_chats_consent").notNull(),
    groupChatsChangedAtMs: integer("group_chats_changed_at_ms").notNull(),
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

export const applets = sqliteTable("applets", {
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

export const appletVersions = sqliteTable(
    "applet_versions",
    {
        appletName: text("applet_name")
            .notNull()
            .references(() => applets.name, { onDelete: "cascade" }),
        version: integer("version").notNull(),
        changeDescription: text("change_description").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
    },
    (table) => [primaryKey({ columns: [table.appletName, table.version] })],
);

export const worklets = sqliteTable("worklets", {
    name: text("name").primaryKey(),
    authorSessionId: text("author_session_id").notNull(),
    sourceDescription: text("source_description"),
    currentVersion: integer("current_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    iconThumbhash: text("icon_thumbhash").notNull(),
});

export const workletVersions = sqliteTable(
    "worklet_versions",
    {
        workletName: text("worklet_name")
            .notNull()
            .references(() => worklets.name, { onDelete: "cascade" }),
        version: integer("version").notNull(),
        changeDescription: text("change_description").notNull(),
        createdAtMs: integer("created_at_ms").notNull(),
        description: text("description").notNull(),
        permissionsJson: text("permissions_json").notNull(),
    },
    (table) => [primaryKey({ columns: [table.workletName, table.version] })],
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

export const sharingProfileBinding = sqliteTable("sharing_profile_binding", {
    singletonId: integer("singleton_id").notNull().primaryKey(),
    profileId: text("profile_id")
        .notNull()
        .unique()
        .references(() => rigProfiles.id, { onDelete: "restrict" }),
    createdAtMs: integer("created_at_ms").notNull(),
    murmurIdentity: text("murmur_identity"),
});

export const sharingSettings = sqliteTable("sharing_settings", {
    singletonId: integer("singleton_id").notNull().primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
});
