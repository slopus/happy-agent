import { sql } from "drizzle-orm";
import { agentDatabaseRun } from "@slopus/happy-agent-base";

import type { Project } from "../Project.js";
import { PROJECTS_TABLE } from "../ProjectMigrations.js";
import {
    HOME_PROJECT_STORAGE_KEY,
    projectStorageKey,
    uniqueProjectStorageKey,
} from "../projectIdentity.js";
import type { ProjectStore, ProjectStoreCreateInput } from "../ProjectStore.js";
import {
    databaseFor,
    insertProjectRow,
    nextProjectOrderKey,
    readHomeProject,
    readProject,
    readProjectByPath,
    takenStorageKeys,
} from "./projectRecords.js";

/** Registering a folder, once. Ensure converges on the row the folder already has. */
export function createProjectRegistration(): Pick<ProjectStore, "create" | "ensure"> {
    return {
        create: async (ctx, input) => {
            const database = databaseFor(ctx);
            const project = await newProjectRow(ctx, input);
            await insertProjectRow(database, project);
            return { operation: "create", changed: true, project };
        },
        ensure: async (ctx, input) => {
            const database = databaseFor(ctx);
            const existing = await readProjectByPath(database, input.repositoryRef, input.runnerId);
            if (existing === undefined) {
                const project = await newProjectRow(ctx, input);
                await insertProjectRow(database, project);
                return {
                    operation: "ensure",
                    changed: true,
                    created: true,
                    project,
                };
            }
            if (existing.status !== "archived") {
                return {
                    operation: "ensure",
                    changed: false,
                    created: false,
                    project: existing,
                };
            }
            const updatedAt = Date.now();
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(PROJECTS_TABLE)}
                    SET status = 'active', archived_at = ${null},
                        updated_at = ${updatedAt}, version = version + 1
                    WHERE id = ${existing.id} AND status = 'archived'`,
            );
            const restored = await readProject(database, existing.id);
            if (restored === undefined || restored.status !== "active") {
                throw new Error("Project ensure could not restore the archived project.");
            }
            return {
                operation: "ensure",
                changed: true,
                created: false,
                project: restored,
            };
        },
    };
}

async function newProjectRow(
    ctx: Parameters<ProjectStore["create"]>[0],
    input: ProjectStoreCreateInput,
): Promise<Project> {
    const database = databaseFor(ctx);
    // There is one home directory, so there is one home project. A second folder registered as
    // home would leave the catalog with two rows nothing can tell apart.
    if (input.kind === "home") {
        const home = await readHomeProject(database);
        if (home !== undefined) {
            throw new Error(
                `The catalog keeps a single home project, and "${home.repositoryRef}" already is it.`,
            );
        }
    }
    const taken = await takenStorageKeys(database);
    const storageKey = uniqueProjectStorageKey(
        input.kind === "home" ? HOME_PROJECT_STORAGE_KEY : projectStorageKey(input.name),
        (candidate) => taken.has(candidate.toLocaleLowerCase("en-US")),
    );
    const at = Date.now();
    return {
        id: input.id,
        repositoryRef: input.repositoryRef,
        ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
        kind: input.kind,
        storageKey,
        name: input.name,
        nameSource: input.nameSource,
        status: "active",
        // A project whose folder still has to be cloned is not on disk yet.
        presence: input.remoteSource === undefined ? "present" : "missing",
        // The home directory is always there; nothing initializes it.
        initializationStatus: input.kind === "home" ? "ready" : "initializing",
        initializationAttempt: 0,
        worktreeSupport: "unknown",
        ...(input.remoteSource === undefined ? {} : { remoteSource: input.remoteSource }),
        ...(input.requiredSecretKind === undefined
            ? {}
            : { requiredSecretKind: input.requiredSecretKind }),
        gitAhead: 0,
        gitBehind: 0,
        gitDetached: false,
        orderKey: await nextProjectOrderKey(database),
        version: 1,
        ...(input.description === undefined ? {} : { description: input.description }),
        createdAt: at,
        updatedAt: at,
    };
}
