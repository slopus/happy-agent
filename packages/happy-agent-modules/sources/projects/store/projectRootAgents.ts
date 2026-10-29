import { sql } from "drizzle-orm";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    projectAgentAssociationSchema,
    type ProjectAgentAttachment,
    type ProjectAgentAssociation,
} from "../ProjectAgentAssociation.js";
import { projectAgentIdSchema, projectIdSchema, type Project } from "../Project.js";
import { PROJECT_ROOT_AGENTS_TABLE } from "../ProjectMigrations.js";
import { databaseFor, readProject } from "./projectRecords.js";
import { projectOrderKeyBetween } from "./projectRootAgentOrdering.js";

type ProjectAgentAssociationRow = {
    readonly agent_id: string;
    readonly order_key: string;
    readonly project_id: string;
};

/** Attaches an agent once. A root agent never changes projects. */
export async function attachProjectRootAgent(
    ctx: Context,
    association: ProjectAgentAttachment,
): Promise<ProjectAgentAssociation | undefined> {
    const database = databaseFor(ctx);
    if ((await readProject(database, association.projectId)) === undefined) {
        throw new Error(`Project "${association.projectId}" was not found.`);
    }
    const existing = await readProjectAgentAssociation(database, association.agentId);
    if (existing !== undefined) {
        if (existing.projectId === association.projectId) return undefined;
        throw new Error(
            `Agent "${association.agentId}" already belongs to project "${existing.projectId}".`,
        );
    }
    const ordered = await listProjectRootAgents(ctx, association.projectId);
    const orderedAssociation: ProjectAgentAssociation = {
        ...association,
        orderKey: projectOrderKeyBetween(ordered.at(-1)?.orderKey ?? null, null),
    };
    await agentDatabaseRun(
        database,
        sql`INSERT INTO ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)} (project_id, agent_id, order_key)
            VALUES (
                ${orderedAssociation.projectId},
                ${orderedAssociation.agentId},
                ${orderedAssociation.orderKey}
            )`,
    );
    return orderedAssociation;
}

/** Removes an agent from whichever project it was a root agent of. */
export async function detachProjectRootAgent(ctx: Context, agentId: string): Promise<void> {
    await agentDatabaseRun(
        databaseFor(ctx),
        sql`DELETE FROM ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)} WHERE agent_id = ${agentId}`,
    );
}

/** Root-agent associations in durable order. */
export async function listProjectRootAgents(
    ctx: Context,
    projectId: string,
): Promise<readonly ProjectAgentAssociation[]> {
    if (!Value.Check(projectIdSchema, projectId)) {
        throw new Error("The project ID is invalid.");
    }
    const rows = await agentDatabaseRows<ProjectAgentAssociationRow>(
        databaseFor(ctx),
        sql`SELECT project_id, agent_id, order_key FROM ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)}
            WHERE project_id = ${projectId}
            ORDER BY order_key, agent_id`,
    );
    return rows.map(projectAgentAssociationFromRow);
}

/** Root-agent IDs in durable order, derived from the association records. */
export async function listProjectRootAgentIds(
    ctx: Context,
    projectId: string,
): Promise<readonly string[]> {
    return (await listProjectRootAgents(ctx, projectId)).map((association) => association.agentId);
}

/** Reorders one root agent within its project. */
export async function reorderProjectRootAgent(
    ctx: Context,
    projectId: string,
    agentId: string,
    afterAgentId: string | null,
): Promise<ProjectAgentAssociation | undefined> {
    const attached = await listProjectRootAgents(ctx, projectId);
    const current = attached.find((association) => association.agentId === agentId);
    if (current === undefined) {
        throw new Error(`Agent "${agentId}" does not belong to project "${projectId}".`);
    }
    if (agentId === afterAgentId) throw new Error("An agent cannot be placed after itself.");
    const remaining = attached.filter((association) => association.agentId !== agentId);
    const afterIndex =
        afterAgentId === null
            ? -1
            : remaining.findIndex((association) => association.agentId === afterAgentId);
    if (afterAgentId !== null && afterIndex < 0) {
        throw new Error("The agent to place after does not belong to that project.");
    }
    const orderKey = projectOrderKeyBetween(
        afterIndex === -1 ? null : (remaining[afterIndex]?.orderKey ?? null),
        remaining[afterIndex + 1]?.orderKey ?? null,
    );
    if (orderKey === current.orderKey) return undefined;
    const database = databaseFor(ctx);
    await agentDatabaseRun(
        database,
        sql`UPDATE ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)}
            SET order_key = ${orderKey}
            WHERE project_id = ${projectId} AND agent_id = ${agentId}`,
    );
    return { ...current, orderKey };
}

/** The root project an agent belongs to, when it has one. */
export async function projectForProjectRootAgent(
    ctx: Context,
    agentId: string,
): Promise<Project | undefined> {
    if (!Value.Check(projectAgentIdSchema, agentId)) {
        throw new Error("The project agent ID is invalid.");
    }
    const association = await readProjectAgentAssociation(databaseFor(ctx), agentId);
    return association === undefined
        ? undefined
        : await readProject(databaseFor(ctx), association.projectId);
}

async function readProjectAgentAssociation(
    database: ReturnType<typeof databaseFor>,
    agentId: string,
): Promise<ProjectAgentAssociation | undefined> {
    const rows = await agentDatabaseRows<ProjectAgentAssociationRow>(
        database,
        sql`SELECT project_id, agent_id, order_key FROM ${sql.raw(PROJECT_ROOT_AGENTS_TABLE)}
            WHERE agent_id = ${agentId}
            LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return projectAgentAssociationFromRow(row);
}

function projectAgentAssociationFromRow(row: ProjectAgentAssociationRow): ProjectAgentAssociation {
    const association = {
        agentId: row.agent_id,
        projectId: row.project_id,
        orderKey: row.order_key,
    };
    if (!Value.Check(projectAgentAssociationSchema, association)) {
        throw new Error("Project agent storage returned an invalid association.");
    }
    return association;
}
