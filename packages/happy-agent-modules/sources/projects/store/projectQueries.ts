import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";

import { PROJECTS_TABLE, PROJECT_SETTINGS_TABLE } from "../ProjectMigrations.js";
import {
    parseProjectSettings,
    projectFromRow,
    type ProjectRow,
    type ProjectSettingsRow,
} from "../ProjectRow.js";
import type { ProjectStore } from "../ProjectStore.js";
import { databaseFor, readProject, readProjectByPath } from "./projectRecords.js";
import { queryProjectAvatar } from "./projectAvatars.js";

const DEFAULT_PAGE_LIMIT = 50;

/** Every read the catalog offers: by identity, by folder, by avatar, and by page. */
export function createProjectQueries(): Pick<
    ProjectStore,
    "list" | "get" | "findByPath" | "readAvatar" | "readSettings"
> {
    return {
        list: async (ctx, query) => {
            const database = databaseFor(ctx);
            const offset = query.cursor === undefined ? 0 : Number(query.cursor);
            const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
            // One row past the page is how the catalog knows whether there is a next page. Without
            // it a page that ends exactly on the limit offers a cursor onto nothing.
            const window = limit + 1;
            const rows = await agentDatabaseRows<ProjectRow>(
                database,
                query.status === undefined
                    ? query.includeArchived === true
                        ? sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                               ORDER BY order_key, id LIMIT ${window} OFFSET ${offset}`
                        : sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                               WHERE status <> 'archived'
                               ORDER BY order_key, id LIMIT ${window} OFFSET ${offset}`
                    : sql`SELECT * FROM ${sql.raw(PROJECTS_TABLE)}
                           WHERE status = ${query.status}
                           ORDER BY order_key, id LIMIT ${window} OFFSET ${offset}`,
            );
            const projects = rows.slice(0, limit).map(projectFromRow);
            return {
                projects,
                ...(rows.length > limit ? { nextCursor: String(offset + projects.length) } : {}),
            };
        },
        get: async (ctx, projectId) => await readProject(databaseFor(ctx), projectId),
        findByPath: async (ctx, repositoryRef, runnerId) =>
            await readProjectByPath(databaseFor(ctx), repositoryRef, runnerId),
        readAvatar: queryProjectAvatar,
        readSettings: async (ctx, projectId) => {
            const database = databaseFor(ctx);
            const rows = await agentDatabaseRows<ProjectSettingsRow>(
                database,
                sql`SELECT project_id, settings_json
                    FROM ${sql.raw(PROJECT_SETTINGS_TABLE)}
                    WHERE project_id = ${projectId} LIMIT 1`,
            );
            const row = rows[0];
            if (row === undefined) {
                if ((await readProject(database, projectId)) === undefined) {
                    throw new Error(`Project "${projectId}" was not found.`);
                }
                return {};
            }
            return parseProjectSettings(row.settings_json);
        },
    };
}
