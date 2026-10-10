import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
    agentDatabaseRows,
    ensureAgentDatabaseConnection,
    type AgentConfig,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { vi } from "vitest";

import {
    ARTIFACT_UPLOADS_TABLE,
    artifactMigrations,
    ArtifactsModule,
    type ArtifactEvent,
} from "../../../sources/artifacts/index.js";
import type { BotsModule } from "../../../sources/bots/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import type { ProjectsModule } from "../../../sources/projects/index.js";
import type { TasksModule } from "../../../sources/tasks/index.js";
import type { WorkspacesModule } from "../../../sources/workspaces/index.js";
import { FakeCompute } from "../../compute/support/FakeCompute.js";
import { temporaryTestConfig } from "../../support/configModule.js";
import { scriptedComputeModule } from "../../support/computeModule.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";

/** The agents an artifact test talks about, each with the parent it was started from. */
class ArtifactAgents {
    readonly parents = new Map<string, string | null>();

    add(agentId: string, parent: string | null = null): void {
        this.parents.set(agentId, parent);
    }

    async config(_ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return this.parents.has(agentId) ? ({} as AgentConfig) : undefined;
    }

    async parentOf(_ctx: Context, agentId: string): Promise<string | null> {
        return this.parents.get(agentId) ?? null;
    }

    asRef(): AgentSystemRef {
        return this as unknown as AgentSystemRef;
    }
}

/**
 * Where agents work, as the catalogs owning bots, tasks, projects, and workspaces answer it.
 *
 * Only the lookups the artifacts module asks are scripted; those catalogs are tested on their own.
 */
class ArtifactPlaces {
    readonly botAgents = new Map<string, string>();
    readonly taskAgents = new Map<string, string>();
    readonly projectAgents = new Map<string, string>();
    readonly workspaceAgents = new Map<string, string>();
    readonly projects = new Set<string>();
    readonly workspaces = new Map<string, string>();

    readonly bots = {
        forAgent: async (_ctx: Context, agentId: string) => {
            const id = this.botAgents.get(agentId);
            return id === undefined ? undefined : { id };
        },
        get: async (_ctx: Context, botId: string) =>
            [...this.botAgents.values()].includes(botId) ? { id: botId } : undefined,
    } as unknown as BotsModule;

    readonly tasks = {
        forAgent: async (_ctx: Context, agentId: string) => {
            const id = this.taskAgents.get(agentId);
            return id === undefined ? undefined : { id };
        },
        get: async (_ctx: Context, taskId: string) =>
            [...this.taskAgents.values()].includes(taskId) ? { id: taskId } : undefined,
    } as unknown as TasksModule;

    readonly projectsModule = {
        get: async (_ctx: Context, projectId: string) =>
            this.projects.has(projectId) ? { id: projectId } : undefined,
        projectForAgent: async (_ctx: Context, agentId: string) => {
            const id = this.projectAgents.get(agentId);
            return id === undefined ? undefined : { id };
        },
    } as unknown as ProjectsModule;

    readonly workspacesModule = {
        workspaceForAgent: async (_ctx: Context, agentId: string) =>
            this.workspaceAgents.get(agentId),
        get: async (_ctx: Context, workspaceId: string) => {
            const projectRef = this.workspaces.get(workspaceId);
            return projectRef === undefined ? undefined : { id: workspaceId, projectRef };
        },
    } as unknown as WorkspacesModule;
}

export type ArtifactsWorld = Awaited<ReturnType<typeof artifactsWorld>>;

/**
 * One artifacts module over its own database and configuration, with the real Durable Functions
 * module beside it, never started, so every owed upload removal stays a row a test can count and
 * run by hand.
 */
export async function artifactsWorld(
    name: string,
    options: { readonly workspaces?: boolean } = {},
) {
    const config = await temporaryTestConfig(
        ["[features]", `workspaces = ${String(options.workspaces ?? false)}`, ""].join("\n"),
    );
    const durableFunctions = new DurableFunctionsModule();
    const database = moduleDatabase([...durableFunctions.migrations, ...artifactMigrations], name);
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    const register = vi.spyOn(durableFunctions, "register");
    const machine = new FakeCompute();
    const places = new ArtifactPlaces();
    const agents = new ArtifactAgents();
    const artifacts = new ArtifactsModule(
        config,
        durableFunctions,
        scriptedComputeModule(async () => machine),
        places.projectsModule,
        places.workspacesModule,
        places.bots,
        places.tasks,
    );
    const definition = register.mock.calls[0]?.[0];
    if (definition === undefined) throw new Error("The upload expiry was not registered.");
    const hooks = artifacts.beforeStart(database.context, agents.asRef());
    const events: ArtifactEvent[] = [];
    artifacts.onEvent((_ctx, event) => {
        events.push(event);
    });
    const ctx = database.context;
    const tools = async (agentId: string): Promise<readonly AnyAgentTool[]> =>
        (await hooks.tools?.(ctx, {
            agent: { id: agentId, provider: "scripted" },
        } as AgentModuleScope)) ?? [];
    return {
        agents,
        artifacts,
        config,
        ctx,
        database,
        events,
        machine,
        places,
        tools,
        tool: async (agentId: string, toolName: string): Promise<AnyAgentTool> => {
            const found = (await tools(agentId)).find((candidate) => candidate.name === toolName);
            if (found === undefined) throw new Error(`The ${toolName} tool is missing.`);
            return found;
        },
        /** Run one upload's owed removal now, as though its lifetime had already passed. */
        expire: async (uploadId: string): Promise<void> => {
            await definition.executor(ctx, {
                callId: `expiry${uploadId}`,
                operationId: `artifact-upload:${uploadId}`,
                arguments: { uploadId, expiresAt: 0 },
                kv: undefined as never,
            });
        },
        pendingRemovals: async (): Promise<number> =>
            (
                await agentDatabaseRows<{ readonly count: number }>(
                    ctx.db,
                    sql`SELECT COUNT(*) AS count FROM durable_function_calls`,
                )
            )[0]?.count ?? 0,
        uploadRows: async (): Promise<number> =>
            (
                await agentDatabaseRows<{ readonly count: number }>(
                    ctx.db,
                    sql`SELECT COUNT(*) AS count FROM ${sql.identifier(ARTIFACT_UPLOADS_TABLE)}`,
                )
            )[0]?.count ?? 0,
        uploadFiles: async (): Promise<readonly string[]> =>
            await readdir(dirname(config.artifactUploadPath("probeupload"))).catch(() => []),
        close: async (): Promise<void> => {
            durableFunctions.stop();
            database.close();
            await rm(dirname(config.configuration.paths.publicHome), {
                force: true,
                recursive: true,
            });
        },
    };
}

export function sha256(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** A few bytes standing in for a picture; artifacts never decode what they store. */
export function imageBytes(seed: string): Uint8Array {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, ...new TextEncoder().encode(seed)]);
}
