import type { AgentSystemRef } from "@slopus/happy-agent-base";
import type { HappyReference } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { ArtifactNotFoundError, type ArtifactsModule } from "../artifacts/index.js";
import type { BotsModule } from "../bots/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { SurfacesModule } from "../surfaces/index.js";
import type { TasksModule } from "../tasks/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";

/** The catalogs a reference's label is read from. */
export interface HappyReferenceCatalogs {
    readonly agents: AgentSystemRef<LibSQLDatabase>;
    readonly artifacts: ArtifactsModule;
    readonly bots: BotsModule;
    readonly projects: ProjectsModule;
    readonly surfaces: SurfacesModule;
    readonly tasks: TasksModule;
    readonly workspaces: WorkspacesModule;
}

/**
 * The words the phone shows in place of an entity link: the entity's current name, the same
 * title a client would put on its link. Nothing when the reference would render inert — an
 * unknown kind, or an entity that is gone, deleted, or archived — so the caller shows the
 * label the agent wrote, or the shared placeholder, instead. Services stay unresolved until
 * clients render them.
 */
export async function resolveHappyReferenceLabel(
    ctx: Context,
    catalogs: HappyReferenceCatalogs,
    reference: HappyReference,
): Promise<string | undefined> {
    switch (reference.kind) {
        case "artifact": {
            const artifact = await catalogs.artifacts.get(ctx, reference.id);
            if (artifact === undefined || artifact.status === "deleted") return undefined;
            if (reference.version === undefined) return artifact.title;
            try {
                return (await catalogs.artifacts.getVersion(ctx, artifact.id, reference.version))
                    .title;
            } catch (error) {
                if (error instanceof ArtifactNotFoundError) return undefined;
                throw error;
            }
        }
        case "agent": {
            const config = await catalogs.agents.config(ctx, reference.id);
            if (config === undefined || typeof config.metadata?.archivedAt === "number") {
                return undefined;
            }
            const bot = await catalogs.bots.forAgent(ctx, reference.id);
            if (bot !== undefined) return bot.name;
            const task = await catalogs.tasks.forAgent(ctx, reference.id);
            if (task !== undefined) return task.name;
            return typeof config.metadata?.title === "string"
                ? config.metadata.title
                : "an untitled conversation";
        }
        case "workspace": {
            const workspace = await catalogs.workspaces.get(ctx, reference.id);
            // A project's root workspace has the project's own ID.
            if (workspace === undefined) return await projectLabel(ctx, catalogs, reference.id);
            return workspace.status === "archived" ? undefined : workspace.name;
        }
        case "project":
            return await projectLabel(ctx, catalogs, reference.id);
        case "surface":
            return (await catalogs.surfaces.get(ctx, reference.id))?.name;
        default:
            return undefined;
    }
}

async function projectLabel(
    ctx: Context,
    catalogs: HappyReferenceCatalogs,
    projectId: string,
): Promise<string | undefined> {
    const project = await catalogs.projects.get(ctx, projectId);
    return project === undefined || project.status === "archived" ? undefined : project.name;
}
