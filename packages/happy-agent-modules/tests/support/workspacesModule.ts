import type { Context } from "@steve.kite/stdlib";

import type { AbortModule } from "../../sources/abort/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { GitModule } from "../../sources/git/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { WorkspacesModule } from "../../sources/workspaces/index.js";

import { temporaryTestConfig, testConfigRootedAt } from "./configModule.js";
import { projectsCatalogFor, type TestAgentCollection } from "./projectsModule.js";

/**
 * The three modules a workspace test drives, built the way the composition root builds them.
 *
 * Nothing here is a stand-in: the catalog runs real Git and reads the real filesystem, and where it
 * puts folders is whatever the configuration it was given says. `workspacesDirectory` is that
 * answer as the catalog itself resolves it, so a test can say where a folder should be without
 * repeating how the path was decided.
 */
export interface WorkspacesCatalog {
    readonly abort: AbortModule;
    /** What the shared abort module was asked to cancel, in the order it was asked. */
    readonly agents: TestAgentCollection;
    readonly config: ConfigModule;
    readonly durableFunctions: DurableFunctionsModule;
    readonly git: GitModule;
    readonly projects: ProjectsModule;
    /**
     * Starts both catalogs from a root context, the way the composition root does.
     *
     * The workspaces catalog takes the lifetime and database its background work runs on at
     * startup, and refuses background work when it was never started, so a world that creates or
     * archives has to call this before it does.
     */
    readonly start: (ctx: Context) => Promise<void>;
    readonly workspaces: WorkspacesModule;
    readonly workspacesDirectory: string;
}

export function workspacesCatalogFrom(
    config: ConfigModule,
    git: GitModule = new GitModule(),
): WorkspacesCatalog {
    // One abort module across both catalogs, exactly as production wires it. With two, each
    // catalog would cancel into an instance the other cannot see, and a test could pass while
    // the arrangement it claims to mirror was never built.
    const { abort, agents, durableFunctions, projects } = projectsCatalogFor(config, git);
    const workspaces = new WorkspacesModule(config, projects, git, abort, durableFunctions);
    return {
        abort,
        agents,
        config,
        durableFunctions,
        git,
        projects,
        start: async (ctx: Context) => {
            const durableHooks = durableFunctions.beforeStart(ctx);
            projects.beforeStart(ctx, agents.asRef());
            workspaces.beforeStart(ctx, agents.asRef());
            projects.open("test-instance");
            await durableHooks.afterStart?.(ctx, agents.asRef());
        },
        workspaces,
        workspacesDirectory: git.normalizeFuturePath(config.workspacesHome),
    };
}

/** A catalog over a temporary Happy root nobody else is using. */
export async function temporaryWorkspacesCatalog(toml?: string): Promise<WorkspacesCatalog> {
    return workspacesCatalogFrom(await temporaryTestConfig(toml));
}

/** The same, over a folder the test made itself so it can look at what Git left there. */
export async function workspacesCatalogRootedAt(
    root: string,
    toml?: string,
): Promise<WorkspacesCatalog> {
    return workspacesCatalogFrom(await testConfigRootedAt(root, toml));
}
