import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    secretEnvironmentVariableNameSchema,
    secretHostEnvironmentSchema,
    type SecretHostEnvironment,
} from "./Secret.js";
import {
    secretApiAttachmentPageSchema,
    secretApiAttachmentSchema,
    secretApiIdSchema,
    secretApiPageSchema,
    secretApiRecordSchema,
    SecretApiInputError,
    type SecretApiAttachment,
    type SecretApiAttachmentListQuery,
    type SecretApiAttachmentPage,
    type SecretApiCreateInput,
    type SecretApiListQuery,
    type SecretApiPage,
    type SecretApiRecord,
    type SecretApiTarget,
    type SecretApiUpdateInput,
} from "./SecretApi.js";
import { createSecretVersion } from "./createSecretVersion.js";

export const SECRETS_API_MIGRATION_KEY = "002-secrets-api";
export const SECRETS_NAMES_MIGRATION_KEY = "003-secret-names";
const SECRETS_TABLE = "happy_agent_secrets";
const LEGACY_ATTACHMENTS_TABLE = "happy_agent_secret_attachments";
const ATTACHMENTS_TABLE = "happy_agent_secret_api_attachments";
const MAX_RESOLVED_SECRET_ROWS = 256;

export const secretsApiMigrations: readonly AgentModuleMigration[] = [
    [
        SECRETS_API_MIGRATION_KEY,
        async (ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE happy_agent_secrets ADD COLUMN public_version TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE happy_agent_secrets ADD COLUMN created_at INTEGER`,
            );
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE happy_agent_secrets ADD COLUMN updated_at INTEGER`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_secret_api_attachments (
                    id TEXT NOT NULL PRIMARY KEY,
                    owner_agent_id TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE (owner_agent_id, secret_id, target_type, target_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_secret_api_attachments_target
                    ON happy_agent_secret_api_attachments(
                        owner_agent_id, target_type, target_id, secret_id
                    )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX happy_agent_secret_api_attachments_secret
                    ON happy_agent_secret_api_attachments(owner_agent_id, secret_id, created_at, id)`,
            );

            const rows = await agentDatabaseRows<{ owner_agent_id: string; id: string }>(
                database,
                sql`SELECT owner_agent_id, id FROM happy_agent_secrets
                    WHERE public_version IS NULL OR created_at IS NULL OR updated_at IS NULL
                    ORDER BY owner_agent_id, id`,
            );
            const publicRows = rows.filter((row) =>
                Value.Check(secretApiRecordSchema.properties.id, row.id),
            );
            let previousVersion: string | undefined;
            for (const row of publicRows) {
                const at = Date.now();
                const version = createSecretVersion(previousVersion, () => at);
                previousVersion = version;
                await agentDatabaseRun(
                    database,
                    sql`UPDATE happy_agent_secrets
                        SET public_version = ${version}, created_at = ${at}, updated_at = ${at}
                        WHERE owner_agent_id = ${row.owner_agent_id} AND id = ${row.id}`,
                );
            }
            ctx.log.info(
                {
                    migratedSecrets: publicRows.length,
                    skippedLegacySecrets: rows.length - publicRows.length,
                },
                "Secrets API storage is ready.",
            );
        },
    ],
    [
        SECRETS_NAMES_MIGRATION_KEY,
        async (ctx, database) => {
            const rows = await agentDatabaseRows<{ owner_agent_id: string; id: string }>(
                database,
                sql`SELECT owner_agent_id, id FROM happy_agent_secrets
                    WHERE (public_version IS NULL OR created_at IS NULL OR updated_at IS NULL)
                      AND length(id) BETWEEN 2 AND 32
                      AND substr(id, 1, 1) GLOB '[a-z]'
                      AND id NOT GLOB '*[^a-z0-9_-]*'
                    ORDER BY owner_agent_id, id`,
            );
            const publicRows = rows.filter((row) => Value.Check(secretApiIdSchema, row.id));
            let previousVersion: string | undefined;
            for (const row of publicRows) {
                const at = Date.now();
                const version = createSecretVersion(previousVersion, () => at);
                previousVersion = version;
                await agentDatabaseRun(
                    database,
                    sql`UPDATE happy_agent_secrets
                        SET public_version = ${version}, created_at = ${at}, updated_at = ${at}
                        WHERE owner_agent_id = ${row.owner_agent_id} AND id = ${row.id}
                          AND (public_version IS NULL OR created_at IS NULL OR updated_at IS NULL)`,
                );
            }
            ctx.log.info(
                { migratedSecrets: publicRows.length },
                "Expanded secret names are available to the public catalog.",
            );
        },
    ],
];

export type SecretApiUpdateResult =
    | { readonly type: "not_found" }
    | { readonly type: "conflict"; readonly current: SecretApiRecord }
    | { readonly type: "managed"; readonly current: SecretApiRecord }
    | { readonly type: "attached"; readonly current: SecretApiRecord }
    | { readonly type: "empty"; readonly current: SecretApiRecord }
    | {
          readonly type: "updated";
          readonly changed: boolean;
          readonly previous: SecretApiRecord;
          readonly secret: SecretApiRecord;
      };

export type SecretApiRemoveManagedResult =
    | { readonly type: "not_found" }
    | { readonly type: "not_owned"; readonly current: SecretApiRecord }
    | { readonly type: "removed"; readonly previous: SecretApiRecord };

export interface SecretApiDatabase {
    readonly get: (
        ctx: Context,
        ownerId: string,
        secretId: string,
    ) => Promise<SecretApiRecord | undefined>;
    readonly list: (
        ctx: Context,
        ownerId: string,
        query: SecretApiListQuery,
    ) => Promise<SecretApiPage>;
    readonly create: (
        ctx: Context,
        ownerId: string,
        input: SecretApiCreateInput & { readonly id: string },
    ) => Promise<{ readonly created: boolean; readonly secret: SecretApiRecord | undefined }>;
    readonly update: (
        ctx: Context,
        ownerId: string,
        secretId: string,
        expectedVersion: string,
        input: SecretApiUpdateInput,
    ) => Promise<SecretApiUpdateResult>;
    readonly removeManaged: (
        ctx: Context,
        ownerId: string,
        secretId: string,
        managedKind: string,
    ) => Promise<SecretApiRemoveManagedResult>;
    readonly listAttachments: (
        ctx: Context,
        ownerId: string,
        secretId: string,
        query: SecretApiAttachmentListQuery,
    ) => Promise<SecretApiAttachmentPage>;
    readonly attach: (
        ctx: Context,
        ownerId: string,
        attachment: SecretApiAttachment,
    ) => Promise<{ readonly attachment: SecretApiAttachment; readonly created: boolean }>;
    readonly detach: (
        ctx: Context,
        ownerId: string,
        secretId: string,
        target: SecretApiTarget,
    ) => Promise<SecretApiAttachment | undefined>;
    readonly effectiveSecretIds: (
        ctx: Context,
        ownerId: string,
        targets: readonly SecretApiTarget[],
    ) => Promise<readonly string[]>;
    readonly resolveByIds: (
        ctx: Context,
        ownerId: string,
        secretIds: readonly string[],
    ) => Promise<SecretHostEnvironment>;
    readonly environmentVariableNamesByIds: (
        ctx: Context,
        ownerId: string,
        secretIds: readonly string[],
    ) => Promise<readonly string[]>;
}

export function createSecretApiDatabase(): SecretApiDatabase {
    const rowFor = async (ctx: Context, ownerId: string, secretId: string) =>
        (
            await agentDatabaseRows<SecretApiRow>(
                ctx.db,
                sql`SELECT owner_agent_id, id, description, environment_json, revision,
                           available_to_model, kind, public_version, created_at, updated_at
                    FROM ${sql.raw(SECRETS_TABLE)}
                    WHERE owner_agent_id = ${ownerId} AND id = ${secretId}
                    LIMIT 1`,
            )
        )[0];

    return {
        get: async (ctx, ownerId, secretId) => {
            const row = await rowFor(ctx, ownerId, secretId);
            return row === undefined || !publicRowAvailable(row) ? undefined : publicRecord(row);
        },
        list: async (ctx, ownerId, query) => {
            const cursor = await cursorPosition(ctx, ownerId, query.cursor, SECRETS_TABLE);
            const clauses = [sql`s.owner_agent_id = ${ownerId}`, sql`s.public_version IS NOT NULL`];
            if (cursor !== undefined) {
                clauses.push(
                    sql`(s.created_at > ${cursor.createdAt} OR
                        (s.created_at = ${cursor.createdAt} AND s.id > ${cursor.id}))`,
                );
            }
            if (query.target !== undefined) {
                clauses.push(sql`EXISTS (
                    SELECT 1 FROM ${sql.raw(ATTACHMENTS_TABLE)} a
                    WHERE a.owner_agent_id = s.owner_agent_id
                      AND a.secret_id = s.id
                      AND a.target_type = ${query.target.type}
                      AND a.target_id = ${query.target.id}
                )`);
            }
            const rows = await agentDatabaseRows<SecretApiRow>(
                ctx.db,
                sql`SELECT s.owner_agent_id, s.id, s.description, s.environment_json,
                           s.available_to_model, s.kind, s.public_version, s.created_at, s.updated_at
                    FROM ${sql.raw(SECRETS_TABLE)} s
                    WHERE ${sql.join(clauses, sql` AND `)}
                    ORDER BY s.created_at, s.id
                    LIMIT ${query.limit + 1}`,
            );
            const hasMore = rows.length > query.limit;
            const visible = rows.slice(0, query.limit).map(publicRecord);
            const page = {
                secrets: visible,
                nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null,
            };
            if (!Value.Check(secretApiPageSchema, page)) {
                throw new Error("Secrets API database produced an invalid page.");
            }
            return page;
        },
        create: async (ctx, ownerId, input) => {
            const current = await rowFor(ctx, ownerId, input.id);
            if (current !== undefined) {
                return {
                    created: false,
                    secret: publicRowAvailable(current) ? publicRecord(current) : undefined,
                };
            }
            const at = Date.now();
            const version = createSecretVersion(undefined, () => at);
            const inserted = await agentDatabaseRows<{ id: string }>(
                ctx.db,
                sql`INSERT INTO ${sql.raw(SECRETS_TABLE)}
                    (owner_agent_id, id, description, environment_json, revision,
                     available_to_model, kind, public_version, created_at, updated_at)
                    VALUES (
                        ${ownerId}, ${input.id}, ${input.description},
                        ${JSON.stringify(input.environment)}, ${"1"},
                        ${input.availableToAgents === false ? 0 : 1}, ${null},
                        ${version}, ${at}, ${at}
                    )
                    ON CONFLICT (owner_agent_id, id) DO NOTHING
                    RETURNING id`,
            );
            const created = await rowFor(ctx, ownerId, input.id);
            if (created === undefined) throw new Error("Secrets API database lost a new secret.");
            return {
                created: inserted.length === 1,
                secret: publicRowAvailable(created) ? publicRecord(created) : undefined,
            };
        },
        update: async (ctx, ownerId, secretId, expectedVersion, input) => {
            const row = await rowFor(ctx, ownerId, secretId);
            if (row === undefined) return { type: "not_found" };
            const previous = publicRecord(row);
            if (previous.version !== expectedVersion)
                return { type: "conflict", current: previous };
            if (previous.managed) return { type: "managed", current: previous };

            const environment = parseEnvironment(row.environment_json);
            let environmentChanged = false;
            for (const [requestedName, value] of Object.entries(input.environment ?? {})) {
                const name = storedEnvironmentName(environment, requestedName) ?? requestedName;
                if (value === null) {
                    if (Object.hasOwn(environment, name)) {
                        delete environment[name];
                        environmentChanged = true;
                    }
                } else if (environment[name] !== value) {
                    environment[name] = value;
                    environmentChanged = true;
                }
            }
            if (Object.keys(environment).length === 0) {
                return { type: "empty", current: previous };
            }
            const availableToAgents = input.availableToAgents ?? previous.availableToAgents;
            if (!availableToAgents && previous.availableToAgents) {
                const counts = await agentDatabaseRows<{ count: number | string }>(
                    ctx.db,
                    sql`SELECT (
                            (SELECT COUNT(*) FROM ${sql.raw(ATTACHMENTS_TABLE)}
                             WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId}) +
                            (SELECT COUNT(*) FROM ${sql.raw(LEGACY_ATTACHMENTS_TABLE)}
                             WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId})
                        ) AS count`,
                );
                if (Number(counts[0]?.count ?? 0) > 0)
                    return { type: "attached", current: previous };
            }
            const description = input.description ?? previous.description;
            const changed =
                description !== previous.description ||
                environmentChanged ||
                availableToAgents !== previous.availableToAgents;
            if (!changed) {
                return { type: "updated", changed: false, previous, secret: previous };
            }
            const updatedAt = Math.max(Date.now(), previous.updatedAt + 1);
            const version = createSecretVersion(previous.version, () => updatedAt);
            const revision = environmentChanged ? incrementRevision(row.revision) : row.revision;
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(SECRETS_TABLE)}
                    SET description = ${description}, environment_json = ${JSON.stringify(environment)},
                        revision = ${revision}, available_to_model = ${availableToAgents ? 1 : 0},
                        public_version = ${version}, updated_at = ${updatedAt}
                    WHERE owner_agent_id = ${ownerId} AND id = ${secretId}
                      AND public_version = ${expectedVersion}`,
            );
            const updated = await rowFor(ctx, ownerId, secretId);
            if (updated === undefined)
                throw new Error("Secrets API database lost an updated secret.");
            const secret = publicRecord(updated);
            if (secret.version !== version) return { type: "conflict", current: secret };
            return { type: "updated", changed: true, previous, secret };
        },
        removeManaged: async (ctx, ownerId, secretId, managedKind) => {
            const row = await rowFor(ctx, ownerId, secretId);
            if (row === undefined || !publicRowAvailable(row)) return { type: "not_found" };
            const previous = publicRecord(row);
            if (row.kind !== managedKind) return { type: "not_owned", current: previous };
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId}`,
            );
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(LEGACY_ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId}`,
            );
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(SECRETS_TABLE)}
                    WHERE owner_agent_id = ${ownerId} AND id = ${secretId}
                      AND kind = ${managedKind}`,
            );
            const after = await rowFor(ctx, ownerId, secretId);
            if (after !== undefined) {
                throw new Error("Secrets API database did not retire the managed secret.");
            }
            return { type: "removed", previous };
        },
        listAttachments: async (ctx, ownerId, secretId, query) => {
            const cursor = await attachmentCursorPosition(ctx, ownerId, secretId, query.cursor);
            const clauses = [sql`owner_agent_id = ${ownerId}`, sql`secret_id = ${secretId}`];
            if (cursor !== undefined) {
                clauses.push(
                    sql`(created_at > ${cursor.createdAt} OR
                        (created_at = ${cursor.createdAt} AND id > ${cursor.id}))`,
                );
            }
            const rows = await agentDatabaseRows<SecretApiAttachmentRow>(
                ctx.db,
                sql`SELECT id, secret_id, target_type, target_id, created_at
                    FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE ${sql.join(clauses, sql` AND `)}
                    ORDER BY created_at, id
                    LIMIT ${query.limit + 1}`,
            );
            const hasMore = rows.length > query.limit;
            const attachments = rows.slice(0, query.limit).map(publicAttachment);
            const page = {
                attachments,
                nextCursor: hasMore ? (attachments.at(-1)?.id ?? null) : null,
            };
            if (!Value.Check(secretApiAttachmentPageSchema, page)) {
                throw new Error("Secrets API database produced an invalid attachment page.");
            }
            return page;
        },
        attach: async (ctx, ownerId, attachment) => {
            const existing = await attachmentFor(
                ctx,
                ownerId,
                attachment.secretId,
                attachment.target,
            );
            if (existing !== undefined) return { attachment: existing, created: false };
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(ATTACHMENTS_TABLE)}
                    (id, owner_agent_id, secret_id, target_type, target_id, created_at)
                    VALUES (
                        ${attachment.id}, ${ownerId}, ${attachment.secretId},
                        ${attachment.target.type}, ${attachment.target.id}, ${attachment.createdAt}
                    )
                    ON CONFLICT (owner_agent_id, secret_id, target_type, target_id) DO NOTHING`,
            );
            const stored = await attachmentFor(
                ctx,
                ownerId,
                attachment.secretId,
                attachment.target,
            );
            if (stored === undefined)
                throw new Error("Secrets API database lost a new attachment.");
            return { attachment: stored, created: stored.id === attachment.id };
        },
        detach: async (ctx, ownerId, secretId, target) => {
            const rows = await agentDatabaseRows<SecretApiAttachmentRow>(
                ctx.db,
                sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId}
                      AND target_type = ${target.type} AND target_id = ${target.id}
                    RETURNING id, secret_id, target_type, target_id, created_at`,
            );
            return rows[0] === undefined ? undefined : publicAttachment(rows[0]);
        },
        effectiveSecretIds: async (ctx, ownerId, targets) => {
            if (targets.length === 0) return [];
            const pairs = targets.map(
                (target) => sql`(target_type = ${target.type} AND target_id = ${target.id})`,
            );
            const rows = await agentDatabaseRows<{ secret_id: string }>(
                ctx.db,
                sql`SELECT DISTINCT secret_id
                    FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${ownerId} AND (${sql.join(pairs, sql` OR `)})
                    ORDER BY secret_id
                    LIMIT ${MAX_RESOLVED_SECRET_ROWS + 1}`,
            );
            if (rows.length > MAX_RESOLVED_SECRET_ROWS) {
                throw new Error("Too many secrets are effectively attached to this agent.");
            }
            return rows.map((row) => row.secret_id);
        },
        resolveByIds: async (ctx, ownerId, secretIds) =>
            resolveEnvironment(await secretRowsByIds(ctx, ownerId, secretIds)),
        environmentVariableNamesByIds: async (ctx, ownerId, secretIds) => {
            const names = new Map<string, string>();
            for (const row of await secretRowsByIds(ctx, ownerId, secretIds)) {
                for (const name of Object.keys(parseEnvironment(row.environment_json))) {
                    if (!names.has(name.toUpperCase())) names.set(name.toUpperCase(), name);
                }
            }
            return [...names.values()].sort((left, right) => left.localeCompare(right));
        },
    };
}

interface SecretApiRow {
    readonly owner_agent_id: string;
    readonly id: string;
    readonly description: string;
    readonly environment_json: string;
    readonly revision: string;
    readonly available_to_model: number | string | null;
    readonly kind: string | null;
    readonly public_version: string | null;
    readonly created_at: number | string | null;
    readonly updated_at: number | string | null;
}

interface SecretApiAttachmentRow {
    readonly id: string;
    readonly secret_id: string;
    readonly target_type: string;
    readonly target_id: string;
    readonly created_at: number | string;
}

function publicRecord(row: SecretApiRow): SecretApiRecord {
    const environment = parseEnvironment(row.environment_json);
    const record = {
        id: row.id,
        description: row.description,
        environmentVariables: Object.keys(environment).sort((left, right) =>
            left.localeCompare(right),
        ),
        managed: row.kind !== null,
        availableToAgents: availableToAgents(row.available_to_model),
        version: row.public_version,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
    if (!Value.Check(secretApiRecordSchema, record)) {
        throw new Error("Secrets API database contains invalid safe metadata.");
    }
    return structuredClone(record);
}

function publicRowAvailable(row: SecretApiRow): boolean {
    return (
        Value.Check(secretApiRecordSchema.properties.id, row.id) &&
        row.public_version !== null &&
        row.created_at !== null &&
        row.updated_at !== null
    );
}

function publicAttachment(row: SecretApiAttachmentRow): SecretApiAttachment {
    const attachment = {
        id: row.id,
        secretId: row.secret_id,
        target: { type: row.target_type, id: row.target_id },
        createdAt: Number(row.created_at),
    };
    if (!Value.Check(secretApiAttachmentSchema, attachment)) {
        throw new Error("Secrets API database contains an invalid attachment.");
    }
    return structuredClone(attachment);
}

async function attachmentFor(
    ctx: Context,
    ownerId: string,
    secretId: string,
    target: SecretApiTarget,
): Promise<SecretApiAttachment | undefined> {
    const rows = await agentDatabaseRows<SecretApiAttachmentRow>(
        ctx.db,
        sql`SELECT id, secret_id, target_type, target_id, created_at
            FROM ${sql.raw(ATTACHMENTS_TABLE)}
            WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId}
              AND target_type = ${target.type} AND target_id = ${target.id}
            LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : publicAttachment(rows[0]);
}

async function cursorPosition(
    ctx: Context,
    ownerId: string,
    cursor: string | undefined,
    table: string,
): Promise<{ readonly createdAt: number; readonly id: string } | undefined> {
    if (cursor === undefined) return undefined;
    const rows = await agentDatabaseRows<{ created_at: number | string; id: string }>(
        ctx.db,
        sql`SELECT id, created_at FROM ${sql.raw(table)}
            WHERE owner_agent_id = ${ownerId} AND id = ${cursor} LIMIT 1`,
    );
    if (rows[0] === undefined) throw new SecretApiInputError("The secret page cursor is unknown.");
    return { createdAt: Number(rows[0].created_at), id: rows[0].id };
}

async function attachmentCursorPosition(
    ctx: Context,
    ownerId: string,
    secretId: string,
    cursor: string | undefined,
): Promise<{ readonly createdAt: number; readonly id: string } | undefined> {
    if (cursor === undefined) return undefined;
    const rows = await agentDatabaseRows<{ created_at: number | string; id: string }>(
        ctx.db,
        sql`SELECT id, created_at FROM ${sql.raw(ATTACHMENTS_TABLE)}
            WHERE owner_agent_id = ${ownerId} AND secret_id = ${secretId} AND id = ${cursor}
            LIMIT 1`,
    );
    if (rows[0] === undefined) {
        throw new SecretApiInputError("The secret attachment cursor is unknown.");
    }
    return { createdAt: Number(rows[0].created_at), id: rows[0].id };
}

async function secretRowsByIds(
    ctx: Context,
    ownerId: string,
    secretIds: readonly string[],
): Promise<readonly Pick<SecretApiRow, "id" | "environment_json">[]> {
    if (secretIds.length === 0) return [];
    if (
        secretIds.length > MAX_RESOLVED_SECRET_ROWS ||
        new Set(secretIds).size !== secretIds.length
    ) {
        throw new Error("Secrets API database received an invalid resolution selection.");
    }
    return await agentDatabaseRows<Pick<SecretApiRow, "id" | "environment_json">>(
        ctx.db,
        sql`SELECT id, environment_json FROM ${sql.raw(SECRETS_TABLE)}
            WHERE owner_agent_id = ${ownerId}
              AND id IN (${sql.join(
                  secretIds.map((id) => sql`${id}`),
                  sql`, `,
              )})
            ORDER BY id`,
    );
}

function resolveEnvironment(
    rows: readonly Pick<SecretApiRow, "id" | "environment_json">[],
): SecretHostEnvironment {
    const environment = Object.create(null) as Record<string, string>;
    const owners = new Map<string, string>();
    for (const row of rows) {
        for (const [name, value] of Object.entries(parseEnvironment(row.environment_json))) {
            const normalized = name.toUpperCase();
            const owner = owners.get(normalized);
            if (owner !== undefined) {
                throw new Error(
                    `Secrets '${owner}' and '${row.id}' both define ${name}. Select only one of them for this command.`,
                );
            }
            owners.set(normalized, row.id);
            environment[name] = value;
        }
    }
    if (!Value.Check(secretHostEnvironmentSchema, environment)) {
        throw new Error("Secrets API database produced an invalid host environment.");
    }
    return structuredClone(environment);
}

function parseEnvironment(value: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("Secrets API database contains invalid environment JSON.");
    }
    const schema = Type.Record(
        secretEnvironmentVariableNameSchema,
        Type.String({ maxLength: 65_536, pattern: "^[^\\u0000]*$" }),
        { additionalProperties: false, maxProperties: 256 },
    );
    if (!Value.Check(schema, parsed))
        throw new Error("Secrets API database contains an invalid environment.");
    return structuredClone(parsed) as Record<string, string>;
}

function storedEnvironmentName(
    environment: Record<string, string>,
    name: string,
): string | undefined {
    if (Object.hasOwn(environment, name)) return name;
    const normalized = name.toUpperCase();
    return Object.keys(environment).find((stored) => stored.toUpperCase() === normalized);
}

function availableToAgents(value: number | string | null): boolean {
    if (value === null || value === 1 || value === "1") return true;
    if (value === 0 || value === "0") return false;
    throw new Error("Secrets API database contains an invalid availability flag.");
}

function incrementRevision(value: string): string {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? String(number + 1) : `${value}:next`;
}
