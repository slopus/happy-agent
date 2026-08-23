import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    assertUserInputRequest,
    userInputListQuerySchema,
    type UserInputListQuery,
    type UserInputPage,
    type UserInputRequest,
    type UserInputRequestId,
} from "./UserInputRequest.js";
import { type UserInputStore } from "./UserInputStore.js";

/** UserInputModule owns these rows and installs them through AgentStorage migrations. */
export const userInputMigrations: readonly AgentModuleMigration[] = [
    [
        "001-user-input",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_user_input_requests (
                    id TEXT PRIMARY KEY,
                    asking_agent_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    request_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_user_input_requests_agent
                    ON happy_user_input_requests(asking_agent_id, created_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS happy_user_input_requests_status
                    ON happy_user_input_requests(status, updated_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_user_input_receipts (
                    acting_agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    receipt_json TEXT NOT NULL,
                    PRIMARY KEY (acting_agent_id, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS happy_user_input_proofs (
                    acting_agent_id TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (acting_agent_id, operation_id)
                )`,
            );
        },
    ],
    [
        "002-drop-user-input-idempotency",
        async (_ctx, database) => {
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS happy_user_input_receipts`);
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS happy_user_input_proofs`);
        },
    ],
];

export function createSqliteUserInputStorage(): UserInputStore {
    const text = (value: unknown): string => JSON.stringify(value);
    const parse = (value: unknown, label: string): unknown => {
        if (typeof value !== "string") throw new Error(`User input ${label} is not JSON text.`);
        try {
            return JSON.parse(value) as unknown;
        } catch {
            throw new Error(`User input ${label} contains invalid JSON.`);
        }
    };
    const readRequestRow = (row: RequestRow): UserInputRequest => {
        const request = parse(row.request_json, "request");
        assertUserInputRequest(request);
        return request;
    };
    const readRequest = async (
        ctx: Context,
        requestId: UserInputRequestId,
    ): Promise<UserInputRequest | undefined> => {
        const rows = await agentDatabaseRows<RequestRow>(
            ctx.db,
            sql`SELECT request_json FROM happy_user_input_requests
                WHERE id = ${requestId} LIMIT 1`,
        );
        return rows[0] === undefined ? undefined : readRequestRow(rows[0]);
    };
    const writeRequest = async (ctx: Context, request: UserInputRequest): Promise<void> => {
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO happy_user_input_requests
                (id, asking_agent_id, status, created_at, updated_at, request_json)
                VALUES (
                    ${request.id}, ${request.askingAgentId}, ${request.status},
                    ${request.createdAt}, ${request.updatedAt}, ${text(request)}
                )
                ON CONFLICT(id) DO UPDATE SET
                    asking_agent_id = excluded.asking_agent_id,
                    status = excluded.status,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    request_json = excluded.request_json`,
        );
    };
    const listRequests = async (
        ctx: Context,
        _agentId: string,
        query: UserInputListQuery,
    ): Promise<UserInputPage> => {
        if (!Value.Check(userInputListQuerySchema, query)) {
            throw new Error("User input list query is invalid.");
        }
        const limit = query.limit ?? 50;
        const offset = cursorOffset(query.cursor);
        const asking =
            query.askingAgentId === undefined
                ? sql``
                : sql` AND asking_agent_id = ${query.askingAgentId}`;
        const status =
            query.status === undefined
                ? sql``
                : query.status === "pending"
                  ? sql` AND status = 'pending'`
                  : sql` AND status <> 'pending'`;
        const rows = await agentDatabaseRows<RequestRow>(
            ctx.db,
            sql`SELECT request_json FROM happy_user_input_requests
                WHERE 1 = 1${asking}${status}
                ORDER BY created_at, id
                LIMIT ${limit + 1} OFFSET ${offset}`,
        );
        const requests = rows.slice(0, limit).map(readRequestRow);
        return {
            requests,
            cursor: String(offset),
            limit,
            ...(offset > 0 ? { previousCursor: String(Math.max(0, offset - limit)) } : {}),
            ...(rows.length > limit ? { nextCursor: String(offset + requests.length) } : {}),
        };
    };
    const latestQuestionAt = async (ctx: Context, agentId: string): Promise<number | undefined> => {
        const rows = await agentDatabaseRows<RequestRow>(
            ctx.db,
            sql`SELECT request_json FROM happy_user_input_requests
                WHERE asking_agent_id = ${agentId}
                ORDER BY created_at DESC, id DESC
                LIMIT 1`,
        );
        const row = rows[0];
        return row === undefined ? undefined : readRequestRow(row).createdAt;
    };
    return {
        latestQuestionAt,
        readRequest,
        writeRequest,
        listRequests,
    } as UserInputStore;
}

interface RequestRow {
    readonly request_json: string;
}

function cursorOffset(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error("User input cursor is invalid.");
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset)) throw new Error("User input cursor is too large.");
    return offset;
}
