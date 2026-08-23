import type { AgentSystemRef } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";

import { AbortModule } from "../../sources/abort/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { GitModule } from "../../sources/git/index.js";
import { ProjectsModule } from "../../sources/projects/index.js";

/**
 * An agent collection for a catalog test: every agent is a person's own conversation, and an abort
 * is recorded rather than performed.
 *
 * The abort is registered on the caller's transaction, the way Agent Base registers a real one, so
 * a test can tell a cancellation that became durable from one whose transaction rolled back.
 */
export class TestAgentCollection {
    readonly aborted: string[] = [];

    async childOf(): Promise<readonly string[]> {
        return [];
    }

    async parentOf(): Promise<string | null> {
        return null;
    }

    async abort(ctx: Context, agentId: string): Promise<void> {
        ctx.afterCommit(() => {
            this.aborted.push(agentId);
        });
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

/**
 * A projects catalog built the way the composition root builds one, with the abort module it shares
 * with any workspaces catalog beside it.
 *
 * Nothing is stubbed out inside the catalog itself: it runs real Git and reads the real filesystem.
 * Only the agent collection is scripted, because a catalog test has no live agents to cancel. The
 * abort module is started here over that collection — it takes nothing from the context, so a root
 * one is enough, and a test that never meant to think about agents cannot trip over an unstarted
 * module when it archives something.
 */
export function projectsCatalogFor(
    config: ConfigModule,
    git: GitModule = new GitModule(),
): {
    readonly abort: AbortModule;
    readonly agents: TestAgentCollection;
    readonly projects: ProjectsModule;
} {
    const abort = new AbortModule(new ComputeModule(config));
    const agents = new TestAgentCollection();
    abort.beforeStart(createRootContext(), agents.asRef());
    return { abort, agents, projects: new ProjectsModule(config, git, abort) };
}

/** The catalog alone, for a test that only needs a projects module that works. */
export function projectsModuleFor(
    config: ConfigModule,
    git: GitModule = new GitModule(),
): ProjectsModule {
    return projectsCatalogFor(config, git).projects;
}
