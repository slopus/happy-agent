import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

import type { SessionDatabase } from "./openSessionDatabase.js";
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
import { sessionHostedCapabilities } from "./migrations/29-session-hosted-capabilities.js";

interface MigrationContext {
    createDataEpoch: () => string;
}

type SessionDatabaseMigration = (database: SessionDatabase, context: MigrationContext) => void;

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
    (database, context) => rigDataIdentity(database, context.createDataEpoch()),
    rigDataIdentityFormat,
    rigDataIdentityNamedChecks,
    createHappyCloudEnrollmentTables,
    scopeSharing,
    sessionShareToolOutput,
    sessionSharePeerCapabilities,
    sessionWorkspaceWaiting,
    p2pPeerTrust,
    sessionHostedCapabilities,
];
export const SESSION_DATABASE_APPLICATION_ID = 0x52494732;
export const RIG_DATA_IDENTITY_MIGRATION_INDEX = 19;
/** First schema version whose committed transaction contains a stable data epoch. */
export const RIG_DATA_IDENTITY_SCHEMA_VERSION = RIG_DATA_IDENTITY_MIGRATION_INDEX + 1;

export const CURRENT_SESSION_DATABASE_VERSION = migrations.length;

export function migrateSessionDatabase(
    database: SessionDatabase,
    options: { createDataEpoch?: () => string } = {},
): void {
    const createDataEpoch = options.createDataEpoch ?? createId;
    database.run(sql.raw("PRAGMA journal_mode = WAL"));
    database.run(sql.raw("PRAGMA synchronous = FULL"));
    database.run(sql.raw("PRAGMA busy_timeout = 5000"));
    database.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
        database.transaction(
            (transaction) => {
                const applicationId =
                    transaction.get<{ application_id: number }>(sql.raw("PRAGMA application_id"))
                        ?.application_id ?? 0;
                let currentVersion =
                    transaction.get<{ user_version: number }>(sql.raw("PRAGMA user_version"))
                        ?.user_version ?? 0;
                if (applicationId !== SESSION_DATABASE_APPLICATION_ID) {
                    resetDatabase(transaction);
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
                    migrations[version]!(transaction, { createDataEpoch });
                    transaction.run(sql.raw(`PRAGMA user_version = ${String(version + 1)}`));
                }
                transaction.run(
                    sql.raw(`PRAGMA application_id = ${String(SESSION_DATABASE_APPLICATION_ID)}`),
                );
            },
            { behavior: "immediate" },
        );
    } finally {
        database.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
}

function resetDatabase(database: SessionDatabase): void {
    const tables = database.all<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"),
    );
    for (const table of tables) {
        database.run(sql.raw(`DROP TABLE ${quoteIdentifier(table.name)}`));
    }
    database.run(sql.raw("PRAGMA user_version = 0"));
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}
