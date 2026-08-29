import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    secretEnvironmentVariableNameSchema,
    secretEnvironmentVariableNamesSchema,
    secretHostEnvironmentSchema,
    secretIdSchema,
    secretPageSchema,
    secretReferenceSchema,
    type SecretAgentId,
    type SecretAttachInput,
    type SecretAttachment,
    type SecretHostEnvironment,
    type SecretId,
    type SecretListQuery,
    type SecretPage,
    type SecretReference,
    type SecretRegistration,
    type SecretUpdateInput,
} from "./Secret.js";
import {
    type SecretStoreAttachResult,
    type SecretStoreDetachResult,
    type SecretStoreRegisterResult,
    type SecretStoreRemoveResult,
    type SecretStoreUpdateResult,
} from "./SecretStore.js";
import { secretsApiMigrations } from "./SecretApiDatabase.js";

export const SECRETS_MIGRATION_KEY = "001-secrets";

const SECRETS_TABLE = "happy_agent_secrets";
const ATTACHMENTS_TABLE = "happy_agent_secret_attachments";
const MAX_RESOLVED_SECRET_ROWS = 256;

export const secretsMigrations: readonly AgentModuleMigration[] = [
    [
        SECRETS_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_secrets (
                    owner_agent_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    description TEXT NOT NULL,
                    environment_json TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    available_to_model INTEGER,
                    kind TEXT,
                    PRIMARY KEY (owner_agent_id, id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_agent_secret_attachments (
                    owner_agent_id TEXT NOT NULL,
                    scope_ref TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    PRIMARY KEY (owner_agent_id, scope_ref, secret_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_secrets_owner
                    ON happy_agent_secrets(owner_agent_id, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_agent_secret_attachments_scope
                    ON happy_agent_secret_attachments(owner_agent_id, scope_ref, secret_id)`,
            );
        },
    ],
    ...secretsApiMigrations,
];

export interface SecretDatabase {
    readonly list: (
        ctx: Context,
        agentId: SecretAgentId,
        query: SecretListQuery,
    ) => Promise<SecretPage>;
    readonly reference: (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
    ) => Promise<SecretReference | undefined>;
    readonly attachment: (
        ctx: Context,
        agentId: SecretAgentId,
        input: SecretAttachInput,
    ) => Promise<SecretAttachment | undefined>;
    readonly register: (
        ctx: Context,
        agentId: SecretAgentId,
        registration: SecretRegistration,
    ) => Promise<SecretStoreRegisterResult>;
    readonly update: (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
        input: SecretUpdateInput,
    ) => Promise<SecretStoreUpdateResult>;
    readonly remove: (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
    ) => Promise<SecretStoreRemoveResult>;
    readonly attach: (
        ctx: Context,
        agentId: SecretAgentId,
        input: SecretAttachInput,
    ) => Promise<SecretStoreAttachResult>;
    readonly detach: (
        ctx: Context,
        agentId: SecretAgentId,
        input: SecretAttachInput,
    ) => Promise<SecretStoreDetachResult>;
    readonly resolveForHost: (
        ctx: Context,
        agentId: SecretAgentId,
        scopeRef: string,
        secretIds?: readonly string[],
    ) => Promise<SecretHostEnvironment>;
    readonly environmentVariableNamesForScope: (
        ctx: Context,
        agentId: SecretAgentId,
        scopeRef: string,
    ) => Promise<readonly string[]>;
    readonly attachedSecretIdsForScope: (
        ctx: Context,
        agentId: SecretAgentId,
        scopeRef: string,
    ) => Promise<readonly SecretId[]>;
}

export function createSecretDatabase(): SecretDatabase {
    const rowReference = (row: SecretRow): SecretReference => {
        const environment = parseEnvironment(row.environment_json);
        const availableToModel = registrationAvailableToModel(row);
        const reference = {
            id: row.id,
            description: row.description,
            environmentVariables: Object.keys(environment).sort((left, right) =>
                left.localeCompare(right),
            ),
            revision: row.revision,
            ...(availableToModel === undefined ? {} : { availableToModel }),
            ...(row.kind === null ? {} : { kind: row.kind }),
        };
        if (!Value.Check(secretReferenceSchema, reference)) {
            throw new Error("Secrets database contains an invalid reference.");
        }
        return structuredClone(reference);
    };

    const rowFor = async (
        ctx: Context,
        agentId: SecretAgentId,
        secretId: string,
    ): Promise<SecretRow | undefined> => {
        const rows = await agentDatabaseRows<SecretRow>(
            ctx.db,
            sql`SELECT owner_agent_id, id, description, environment_json, revision,
                       available_to_model, kind
                FROM ${sql.raw(SECRETS_TABLE)}
                WHERE owner_agent_id = ${agentId} AND id = ${secretId}
                LIMIT 1`,
        );
        return rows[0];
    };

    return {
        list: async (ctx, agentId, query) => {
            const cursor = query.cursor ?? 0;
            const clauses = [sql`owner_agent_id = ${agentId}`];
            if (query.scopeRef !== undefined) {
                clauses.push(
                    sql`EXISTS (
                        SELECT 1 FROM ${sql.raw(ATTACHMENTS_TABLE)} a
                        WHERE a.owner_agent_id = ${agentId}
                          AND a.scope_ref = ${query.scopeRef}
                          AND a.secret_id = s.id
                    )`,
                );
            }
            const rows = await agentDatabaseRows<SecretRow>(
                ctx.db,
                sql`SELECT s.owner_agent_id, s.id, s.description, s.environment_json,
                           s.revision, s.available_to_model, s.kind
                    FROM ${sql.raw(SECRETS_TABLE)} s
                    WHERE ${sql.join(clauses, sql` AND `)}
                    ORDER BY s.id
                    LIMIT ${query.limit} OFFSET ${cursor}`,
            );
            const secrets = rows.map(rowReference);
            const page = {
                secrets,
                limit: query.limit,
                ...(rows.length === query.limit ? { nextCursor: cursor + rows.length } : {}),
            };
            if (!Value.Check(secretPageSchema, page)) {
                throw new Error("Secrets database produced an invalid page.");
            }
            return page;
        },
        reference: async (ctx, agentId, secretId) => {
            const row = await rowFor(ctx, agentId, secretId);
            return row === undefined ? undefined : rowReference(row);
        },
        attachment: async (ctx, agentId, input) => {
            const rows = await agentDatabaseRows<{ secret_id: string }>(
                ctx.db,
                sql`SELECT secret_id FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${input.scopeRef}
                      AND secret_id = ${input.secretId}
                    LIMIT 1`,
            );
            return rows.length === 0 ? undefined : structuredClone(input);
        },
        register: async (ctx, agentId, registration) => {
            const previous = await rowFor(ctx, agentId, registration.id);
            const existingEnvironment =
                previous === undefined ? undefined : parseEnvironment(previous.environment_json);
            const environmentChanged = !sameEnvironment(
                existingEnvironment,
                registration.environment,
            );
            const changed =
                previous === undefined ||
                previous.description !== registration.description ||
                environmentChanged ||
                registrationAvailableToModel(previous) !==
                    (registration.availableToModel ?? undefined);
            const revision =
                previous === undefined
                    ? "1"
                    : environmentChanged
                      ? incrementRevision(previous.revision)
                      : previous.revision;
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(SECRETS_TABLE)}
                    (owner_agent_id, id, description, environment_json, revision,
                     available_to_model, kind)
                    VALUES (
                        ${agentId}, ${registration.id}, ${registration.description},
                        ${JSON.stringify(registration.environment)}, ${revision},
                        ${
                            registration.availableToModel === undefined
                                ? null
                                : registration.availableToModel
                                  ? 1
                                  : 0
                        },
                        ${null}
                    )
                    ON CONFLICT (owner_agent_id, id) DO UPDATE SET
                        description = EXCLUDED.description,
                        environment_json = EXCLUDED.environment_json,
                        revision = EXCLUDED.revision,
                        available_to_model = EXCLUDED.available_to_model`,
            );
            const row = await rowFor(ctx, agentId, registration.id);
            if (row === undefined)
                throw new Error("Secrets database did not persist registration.");
            return {
                operation: "register",
                changed,
                reference: rowReference(row),
            };
        },
        update: async (ctx, agentId, secretId, input) => {
            const previous = await rowFor(ctx, agentId, secretId);
            if (previous === undefined) {
                return { operation: "update", changed: false, secretId };
            }
            const environment = parseEnvironment(previous.environment_json);
            let environmentChanged = false;
            for (const [name, value] of Object.entries(input.environment ?? {})) {
                // A process environment tells TOKEN and token apart on one machine and not on
                // another, so a variable already stored under one spelling is the same variable
                // whichever spelling names it here, and it keeps the name it was stored under.
                const storedName = storedEnvironmentName(environment, name) ?? name;
                if (value === null) {
                    if (Object.hasOwn(environment, storedName)) {
                        delete environment[storedName];
                        environmentChanged = true;
                    }
                } else if (environment[storedName] !== value) {
                    environment[storedName] = value;
                    environmentChanged = true;
                }
            }
            const description = input.description ?? previous.description;
            const previousAvailableToModel = registrationAvailableToModel(previous);
            const availableToModel = input.availableToModel ?? previousAvailableToModel;
            const changed =
                description !== previous.description ||
                environmentChanged ||
                availableToModel !== previousAvailableToModel;
            const revision = environmentChanged
                ? incrementRevision(previous.revision)
                : previous.revision;
            await agentDatabaseRun(
                ctx.db,
                sql`UPDATE ${sql.raw(SECRETS_TABLE)}
                    SET description = ${description},
                        environment_json = ${JSON.stringify(environment)},
                        revision = ${revision},
                        available_to_model = ${
                            availableToModel === undefined ? null : availableToModel ? 1 : 0
                        }
                    WHERE owner_agent_id = ${agentId} AND id = ${secretId}`,
            );
            const row = await rowFor(ctx, agentId, secretId);
            if (row === undefined) throw new Error("Secrets database lost updated secret.");
            return {
                operation: "update",
                changed,
                secretId,
                reference: rowReference(row),
            };
        },
        remove: async (ctx, agentId, secretId) => {
            const previous = await rowFor(ctx, agentId, secretId);
            if (previous === undefined) return { operation: "remove", removed: false, secretId };
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId} AND secret_id = ${secretId}`,
            );
            await agentDatabaseRun(
                ctx.db,
                sql`DELETE FROM ${sql.raw(SECRETS_TABLE)}
                    WHERE owner_agent_id = ${agentId} AND id = ${secretId}`,
            );
            return {
                operation: "remove",
                removed: true,
                secretId,
                reference: rowReference(previous),
            };
        },
        attach: async (ctx, agentId, input) => {
            const reference = await rowFor(ctx, agentId, input.secretId);
            if (reference === undefined) {
                throw new Error("The secret reference does not exist.");
            }
            const existing = await agentDatabaseRows<{ secret_id: string }>(
                ctx.db,
                sql`SELECT secret_id FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${input.scopeRef}
                      AND secret_id = ${input.secretId}
                    LIMIT 1`,
            );
            await agentDatabaseRun(
                ctx.db,
                sql`INSERT INTO ${sql.raw(ATTACHMENTS_TABLE)}
                    (owner_agent_id, scope_ref, secret_id)
                    VALUES (${agentId}, ${input.scopeRef}, ${input.secretId})
                    ON CONFLICT (owner_agent_id, scope_ref, secret_id) DO NOTHING`,
            );
            const attachment = structuredClone(input);
            return {
                operation: "attach",
                changed: existing.length === 0,
                attachment,
                reference: rowReference(reference),
            };
        },
        detach: async (ctx, agentId, input) => {
            const rows = await agentDatabaseRows<{ secret_id: string }>(
                ctx.db,
                sql`DELETE FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${input.scopeRef}
                      AND secret_id = ${input.secretId}
                    RETURNING secret_id`,
            );
            return rows.length === 0
                ? { operation: "detach", detached: false }
                : { operation: "detach", detached: true, attachment: structuredClone(input) };
        },
        resolveForHost: async (ctx, agentId, scopeRef, secretIds) => {
            if (
                secretIds !== undefined &&
                (secretIds.length > 256 ||
                    new Set(secretIds).size !== secretIds.length ||
                    secretIds.some((secretId) => !Value.Check(secretIdSchema, secretId)))
            ) {
                throw new Error("Secrets database received an invalid selection.");
            }
            const clauses = [sql`a.owner_agent_id = ${agentId}`, sql`a.scope_ref = ${scopeRef}`];
            if (secretIds !== undefined) {
                if (secretIds.length === 0) return {};
                clauses.push(
                    sql`a.secret_id IN (${sql.join(
                        secretIds.map((id) => sql`${id}`),
                        sql`, `,
                    )})`,
                );
            }
            const rows = await agentDatabaseRows<{
                secret_id: string;
                environment_json: string;
            }>(
                ctx.db,
                sql`SELECT a.secret_id, s.environment_json
                    FROM ${sql.raw(ATTACHMENTS_TABLE)} a
                    JOIN ${sql.raw(SECRETS_TABLE)} s
                      ON s.owner_agent_id = a.owner_agent_id AND s.id = a.secret_id
                    WHERE ${sql.join(clauses, sql` AND `)}
                    ORDER BY a.secret_id
                    LIMIT ${MAX_RESOLVED_SECRET_ROWS + 1}`,
            );
            if (rows.length > MAX_RESOLVED_SECRET_ROWS) {
                throw new Error("Secrets database returned too many attached secrets.");
            }
            const environment = Object.create(null) as Record<string, string>;
            const owners = new Map<string, string>();
            for (const row of rows) {
                for (const [name, value] of Object.entries(
                    parseEnvironment(row.environment_json),
                )) {
                    const normalizedName = name.toUpperCase();
                    const owner = owners.get(normalizedName);
                    if (owner !== undefined) {
                        throw new Error(
                            `Secrets '${owner}' and '${row.secret_id}' both define ${name}. Select only one of them for this command.`,
                        );
                    }
                    owners.set(normalizedName, row.secret_id);
                    environment[name] = value;
                }
            }
            if (!Value.Check(secretHostEnvironmentSchema, environment)) {
                throw new Error("Secrets database produced an invalid host environment.");
            }
            return structuredClone(environment);
        },
        environmentVariableNamesForScope: async (ctx, agentId, scopeRef) => {
            const rows = await agentDatabaseRows<{ environment_json: string }>(
                ctx.db,
                sql`SELECT s.environment_json
                    FROM ${sql.raw(ATTACHMENTS_TABLE)} a
                    JOIN ${sql.raw(SECRETS_TABLE)} s
                      ON s.owner_agent_id = a.owner_agent_id AND s.id = a.secret_id
                    WHERE a.owner_agent_id = ${agentId}
                      AND a.scope_ref = ${scopeRef}
                    ORDER BY a.secret_id
                    LIMIT ${MAX_RESOLVED_SECRET_ROWS + 1}`,
            );
            if (rows.length > MAX_RESOLVED_SECRET_ROWS) {
                throw new Error("Secrets database returned too many attached secrets.");
            }
            const namesByUppercase = new Map<string, string>();
            for (const row of rows) {
                for (const name of Object.keys(parseEnvironment(row.environment_json))) {
                    const normalizedName = name.toUpperCase();
                    if (namesByUppercase.has(normalizedName)) continue;
                    namesByUppercase.set(normalizedName, name);
                    if (namesByUppercase.size > 256) {
                        throw new Error(
                            "Secrets database returned too many environment variable names.",
                        );
                    }
                }
            }
            const names = [...namesByUppercase.values()].sort((left, right) =>
                left.localeCompare(right),
            );
            if (!Value.Check(secretEnvironmentVariableNamesSchema, names)) {
                throw new Error("Secrets database returned invalid environment variable names.");
            }
            return names;
        },
        attachedSecretIdsForScope: async (ctx, agentId, scopeRef) => {
            const rows = await agentDatabaseRows<{ secret_id: string }>(
                ctx.db,
                sql`SELECT secret_id
                    FROM ${sql.raw(ATTACHMENTS_TABLE)}
                    WHERE owner_agent_id = ${agentId}
                      AND scope_ref = ${scopeRef}
                    ORDER BY secret_id
                    LIMIT ${MAX_RESOLVED_SECRET_ROWS + 1}`,
            );
            if (rows.length > MAX_RESOLVED_SECRET_ROWS) {
                throw new Error("Secrets database returned too many attached secrets.");
            }
            const secretIds = rows.map(({ secret_id }) => secret_id);
            if (
                new Set(secretIds).size !== secretIds.length ||
                secretIds.some((secretId) => !Value.Check(secretIdSchema, secretId))
            ) {
                throw new Error("Secrets database returned invalid attached secret IDs.");
            }
            return structuredClone(secretIds) as SecretId[];
        },
    };
}

interface SecretRow {
    readonly owner_agent_id: string;
    readonly id: string;
    readonly description: string;
    readonly environment_json: string;
    readonly revision: string;
    readonly available_to_model: number | string | null;
    readonly kind: string | null;
}

function parseEnvironment(value: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("Secrets database contains invalid environment JSON.");
    }
    const schema = Type.Record(
        secretEnvironmentVariableNameSchema,
        Type.String({ maxLength: 65_536 }),
        { additionalProperties: false, maxProperties: 256 },
    );
    if (!Value.Check(schema, parsed)) {
        throw new Error("Secrets database contains an invalid environment.");
    }
    const environment = structuredClone(parsed) as Record<string, string>;
    const names = new Set<string>();
    for (const name of Object.keys(environment)) {
        const normalized = name.toUpperCase();
        if (names.has(normalized)) {
            throw new Error("Secrets database contains colliding environment variable names.");
        }
        names.add(normalized);
    }
    return environment;
}

/** The name this variable is already stored under, whatever case it was named with here. */
function storedEnvironmentName(
    environment: Record<string, string>,
    name: string,
): string | undefined {
    if (Object.hasOwn(environment, name)) return name;
    const normalized = name.toUpperCase();
    return Object.keys(environment).find((stored) => stored.toUpperCase() === normalized);
}

/**
 * Whether a registration holds exactly what is already stored.
 *
 * Two environments with the same variables and the same values are the same environment, however
 * the caller happened to order its keys; treating a reordered rewrite as a change would bump a
 * revision every host restart and tell every listener something happened when nothing did.
 */
function sameEnvironment(
    stored: Record<string, string> | undefined,
    incoming: Record<string, string>,
): boolean {
    if (stored === undefined) return false;
    const storedNames = Object.keys(stored);
    if (storedNames.length !== Object.keys(incoming).length) return false;
    return storedNames.every(
        (name) => Object.hasOwn(incoming, name) && stored[name] === incoming[name],
    );
}

function registrationAvailableToModel(row: SecretRow | undefined): boolean | undefined {
    if (row === undefined || row.available_to_model === null) return undefined;
    if (row.available_to_model === 0 || row.available_to_model === "0") return false;
    if (row.available_to_model === 1 || row.available_to_model === "1") return true;
    throw new Error("Secrets database contains an invalid model-availability flag.");
}

function incrementRevision(value: string): string {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? String(number + 1) : `${value}:next`;
}
