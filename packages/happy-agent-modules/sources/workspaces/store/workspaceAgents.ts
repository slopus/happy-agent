import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

import {
    workspaceAgentAssociationSchema,
    type WorkspaceAgentAssociation,
} from "../WorkspaceAgent.js";
import { WORKSPACE_AGENTS_TABLE } from "../WorkspaceMigrations.js";

type WorkspaceAgentRow = {
    readonly workspace_id: string;
    readonly agent_id: string;
    readonly order_key: string;
};

export async function readWorkspaceAgent(
    database: AgentDatabase,
    agentId: string,
): Promise<WorkspaceAgentAssociation | undefined> {
    const rows = await agentDatabaseRows<WorkspaceAgentRow>(
        database,
        sql`SELECT workspace_id, agent_id, order_key
            FROM ${sql.raw(WORKSPACE_AGENTS_TABLE)}
            WHERE agent_id = ${agentId}
            LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? undefined : workspaceAgentFromRow(row);
}

export async function readWorkspaceAgents(
    database: AgentDatabase,
    workspaceId: string,
): Promise<readonly WorkspaceAgentAssociation[]> {
    const rows = await agentDatabaseRows<WorkspaceAgentRow>(
        database,
        sql`SELECT workspace_id, agent_id, order_key
            FROM ${sql.raw(WORKSPACE_AGENTS_TABLE)}
            WHERE workspace_id = ${workspaceId}
            ORDER BY order_key, agent_id`,
    );
    return rows.map(workspaceAgentFromRow);
}

export async function insertWorkspaceAgent(
    database: AgentDatabase,
    association: WorkspaceAgentAssociation,
): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`INSERT INTO ${sql.raw(WORKSPACE_AGENTS_TABLE)} (
                workspace_id, agent_id, order_key
            ) VALUES (
                ${association.workspaceId}, ${association.agentId}, ${association.orderKey}
            )`,
    );
}

/** Removes an agent from whichever workspace it was placed in. */
export async function deleteWorkspaceAgent(
    database: AgentDatabase,
    agentId: string,
): Promise<void> {
    await agentDatabaseRun(
        database,
        sql`DELETE FROM ${sql.raw(WORKSPACE_AGENTS_TABLE)} WHERE agent_id = ${agentId}`,
    );
}

export async function updateWorkspaceAgentOrder(
    database: AgentDatabase,
    workspaceId: string,
    agentId: string,
    orderKey: string,
): Promise<void> {
    const changed = await agentDatabaseRows<{ readonly agent_id: string }>(
        database,
        sql`UPDATE ${sql.raw(WORKSPACE_AGENTS_TABLE)}
            SET order_key = ${orderKey}
            WHERE workspace_id = ${workspaceId}
              AND agent_id = ${agentId}
            RETURNING agent_id`,
    );
    if (changed.length !== 1) {
        throw new Error(`Agent "${agentId}" is not attached to that workspace.`);
    }
}

function workspaceAgentFromRow(row: WorkspaceAgentRow): WorkspaceAgentAssociation {
    const association: WorkspaceAgentAssociation = {
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        orderKey: row.order_key,
    };
    if (!Value.Check(workspaceAgentAssociationSchema, association)) {
        throw new Error("Workspace agent association is invalid.");
    }
    return association;
}
