import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "./inDatabase.js";
import { inTx } from "../inTx.js";
import type { DrizzleSessionTx } from "./SessionDatabase.js";
import { init } from "./migrations/01-init.js";
import { delegatedSessions } from "./migrations/02-delegated-sessions.js";
import { timelineIndex } from "./migrations/03-timeline-index.js";
import { scheduling } from "./migrations/04-scheduling.js";
import { projectDefaultBranch } from "./migrations/05-project-default-branch.js";
import { presenceDetachedQuestions } from "./migrations/06-presence-detached-questions.js";
import { presenceQuestionDeadlines } from "./migrations/07-presence-question-deadlines.js";
import { agentTreeUsage } from "./migrations/08-agent-tree-usage.js";
import { slots } from "./migrations/09-slots.js";
import { webappIcons } from "./migrations/10-webapp-icons.js";
import { projectSettings } from "./migrations/11-project-settings.js";
import { projectComputeGeneration } from "./migrations/12-project-compute-generation.js";
import { webappAllowedScopes } from "./migrations/13-webapp-allowed-scopes.js";
import { slotEntryAuthors } from "./migrations/14-slot-entry-authors.js";
import { sessionWorkspaceTransfer } from "./migrations/15-session-workspace-transfer.js";
import { projectUserMutationVersion } from "./migrations/16-project-user-mutation-version.js";
import { pendingContextMessages } from "./migrations/17-pending-context-messages.js";
import { agentSessionSharing } from "./migrations/18-agent-session-sharing.js";
import { sessionShareEntryLog } from "./migrations/19-session-share-entry-log.js";
import { rigDataIdentity } from "./migrations/20-rig-data-identity.js";
import { rigDataIdentityFormat } from "./migrations/21-rig-data-identity-format.js";
import { rigDataIdentityNamedChecks } from "./migrations/22-rig-data-identity-named-checks.js";
import { happyCloudEnrollment as createHappyCloudEnrollmentTables } from "./migrations/23-happy-cloud-enrollment.js";
import { scopeSharing } from "./migrations/24-scope-sharing.js";
import { sessionShareToolOutput } from "./migrations/25-session-share-tool-output.js";
import { sessionSharePeerCapabilities } from "./migrations/26-session-share-peer-capabilities.js";
import { sessionWorkspaceWaiting } from "./migrations/27-session-workspace-waiting.js";
import { p2pPeerTrust } from "./migrations/28-p2p-peer-trust.js";
import { removeFriendsAndSharing } from "./migrations/29-remove-friends-and-sharing.js";
import { applets } from "./migrations/30-applets.js";
import { workspaceBranchNaming } from "./migrations/31-workspace-branch-naming.js";
import { folders } from "./migrations/32-folders.js";
import { unsortedChats } from "./migrations/33-unsorted-chats.js";
import { worklets } from "./migrations/34-worklets.js";
import { rigProfiles } from "./migrations/35-rig-profiles.js";
import { sessionScopes } from "./migrations/36-session-scopes.js";
import { sessionMutations } from "./migrations/37-session-mutations.js";
import { p2pProvisionedProviders } from "./migrations/38-p2p-provisioned-providers.js";
import { sessionOwner } from "./migrations/39-session-owner.js";
import { p2pCredentialSnapshots } from "./migrations/40-p2p-credential-snapshots.js";
import { sessionCredentialBinding } from "./migrations/41-session-credential-binding.js";
import { remoteProjects } from "./migrations/42-remote-projects.js";
import { profileGitIdentity } from "./migrations/43-profile-git-identity.js";
import { remoteWorkspaces } from "./migrations/44-remote-workspaces.js";
import { folderItemsAndDocuments } from "./migrations/45-folder-items-and-documents.js";
import { folderItemMutationRetention } from "./migrations/46-folder-item-mutation-retention.js";
import { onboardingState } from "./migrations/47-onboarding-state.js";
import { sharingProfile } from "./migrations/48-sharing-profile.js";
import { sharingMurmurIdentity } from "./migrations/49-sharing-murmur-identity.js";
import { sharingSettings } from "./migrations/50-sharing-settings.js";
import { folderChildOrderSpace } from "./migrations/51-folder-child-order-space.js";
import { folderSharing } from "./migrations/52-folder-sharing.js";
import { happyHistoryBackfill } from "./migrations/53-happy-history-backfill.js";
import { happyProjectionProgress } from "./migrations/54-happy-projection-progress.js";
import { agentBaseStorage } from "./migrations/55-agent-base-storage.js";

interface MigrationContext {
    createDataEpoch: () => string;
    localInstanceId: string;
}

type SessionDatabaseMigration = (
    database: DrizzleSessionTx,
    context: MigrationContext,
) => Promise<void>;

const migrations: readonly SessionDatabaseMigration[] = [
    init,
    delegatedSessions,
    timelineIndex,
    scheduling,
    projectDefaultBranch,
    presenceDetachedQuestions,
    presenceQuestionDeadlines,
    agentTreeUsage,
    slots,
    webappIcons,
    projectSettings,
    projectComputeGeneration,
    webappAllowedScopes,
    slotEntryAuthors,
    sessionWorkspaceTransfer,
    projectUserMutationVersion,
    pendingContextMessages,
    agentSessionSharing,
    sessionShareEntryLog,
    async (database, context) => rigDataIdentity(database, context.createDataEpoch()),
    rigDataIdentityFormat,
    rigDataIdentityNamedChecks,
    createHappyCloudEnrollmentTables,
    scopeSharing,
    sessionShareToolOutput,
    sessionSharePeerCapabilities,
    sessionWorkspaceWaiting,
    p2pPeerTrust,
    removeFriendsAndSharing,
    applets,
    workspaceBranchNaming,
    folders,
    unsortedChats,
    worklets,
    rigProfiles,
    sessionScopes,
    sessionMutations,
    p2pProvisionedProviders,
    async (database, context) => sessionOwner(database, context.localInstanceId),
    p2pCredentialSnapshots,
    sessionCredentialBinding,
    remoteProjects,
    profileGitIdentity,
    remoteWorkspaces,
    folderItemsAndDocuments,
    folderItemMutationRetention,
    onboardingState,
    sharingProfile,
    sharingMurmurIdentity,
    sharingSettings,
    folderChildOrderSpace,
    folderSharing,
    happyHistoryBackfill,
    happyProjectionProgress,
    agentBaseStorage,
];
export const SESSION_DATABASE_APPLICATION_ID = 0x52494732;
export const RIG_DATA_IDENTITY_MIGRATION_INDEX = 19;
/** First schema version whose committed transaction contains a stable data epoch. */
export const RIG_DATA_IDENTITY_SCHEMA_VERSION = RIG_DATA_IDENTITY_MIGRATION_INDEX + 1;

export const CURRENT_SESSION_DATABASE_VERSION = migrations.length;

export async function migrateSessionDatabase(
    ctx: Context,
    options: { createDataEpoch?: () => string; localInstanceId?: string } = {},
): Promise<void> {
    const createDataEpoch = options.createDataEpoch ?? createId;
    const localInstanceId = options.localInstanceId ?? createId();
    await inDatabase(ctx, "rig.sql.database.migrate.configure", async (ctx) => {
        const plainDatabase = ctx.tx;
        await plainDatabase.run(sql.raw("PRAGMA journal_mode = WAL"));
        await plainDatabase.run(sql.raw("PRAGMA synchronous = FULL"));
        await plainDatabase.run(sql.raw("PRAGMA busy_timeout = 5000"));
        await plainDatabase.run(sql.raw("PRAGMA foreign_keys = OFF"));
    });
    try {
        await inTx(ctx, "rig.sql.database.migrate", async (transactionCtx) => {
            const transaction = transactionCtx.tx;
            const applicationId =
                (
                    await transaction.get<{ application_id: number }>(
                        sql.raw("PRAGMA application_id"),
                    )
                )?.application_id ?? 0;
            let currentVersion =
                (await transaction.get<{ user_version: number }>(sql.raw("PRAGMA user_version")))
                    ?.user_version ?? 0;
            if (applicationId !== SESSION_DATABASE_APPLICATION_ID) {
                await resetDatabase(transactionCtx);
                currentVersion = 0;
            } else if (currentVersion > CURRENT_SESSION_DATABASE_VERSION) {
                throw new Error(
                    `The session database uses schema version ${String(currentVersion)}, but this Rig version supports up to ${String(CURRENT_SESSION_DATABASE_VERSION)}.`,
                );
            }
            for (
                let version = currentVersion;
                version < CURRENT_SESSION_DATABASE_VERSION;
                version += 1
            ) {
                await transactionCtx.span(
                    `rig.sql.database.migration.${String(version + 1)}`,
                    async () =>
                        migrations[version]!(transaction, {
                            createDataEpoch,
                            localInstanceId,
                        }),
                );
                await transaction.run(sql.raw(`PRAGMA user_version = ${String(version + 1)}`));
            }
            await transaction.run(
                sql.raw(`PRAGMA application_id = ${String(SESSION_DATABASE_APPLICATION_ID)}`),
            );
        });
    } finally {
        await inDatabase(ctx, "rig.sql.database.migrate.restore_foreign_keys", async (ctx) => {
            await ctx.tx.run(sql.raw("PRAGMA foreign_keys = ON"));
        });
    }
}

async function resetDatabase(ctx: Context): Promise<void> {
    const database = ctx.tx;
    const tables = await database.all<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"),
    );
    for (const table of tables) {
        await database.run(sql.raw(`DROP TABLE ${quoteIdentifier(table.name)}`));
    }
    await database.run(sql.raw("PRAGMA user_version = 0"));
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}
