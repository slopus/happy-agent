import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import {
    AgentStorage,
    openAgentSQLiteDatabase,
    withAgentDatabase,
    withAgentPermissionMode,
    type AgentConfig,
    type AgentModuleSystemScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type {
    ComputeService,
    ComputeServiceExit,
    ComputeServiceStartOptions,
} from "@slopus/happy-agent-compute";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { vi } from "vitest";
import { AbortModule } from "../../../sources/abort/index.js";
import { BotsModule } from "../../../sources/bots/index.js";
import { ComputeModule } from "../../../sources/compute/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import { EventsModule } from "../../../sources/events/index.js";
import { GitModule } from "../../../sources/git/index.js";
import { HistoryModule } from "../../../sources/history/index.js";
import { ProjectsModule } from "../../../sources/projects/index.js";
import { SecretsModule } from "../../../sources/secrets/index.js";
import { ServicesModule, type ServiceDefinition } from "../../../sources/services/index.js";
import { TitlesModule } from "../../../sources/titles/index.js";
import { WorkspacesModule } from "../../../sources/workspaces/index.js";
import { FakeCompute } from "../../compute/support/FakeCompute.js";
import { testConfigRootedAt } from "../../support/configModule.js";
import {
    pendingCallCount,
    waitForCondition,
} from "../../durableFunctions/support/durableFunctionsHarness.js";

export const ownerId = "aaowner";
export const peerId = "aapeer";
export const childId = "aachild";
export const workspaceId = "aaworkspace";
export const definition: ServiceDefinition = {
    name: "Preview",
    command: "node server.js",
    cwd: ".",
    port: 4187,
    tty: false,
    sandbox: {
        inputs: ["server.js"],
        scratch: [],
        outbound: [],
        limits: { memoryMiB: 128, processes: 8 },
    },
};

/** Real module stores and durable dispatcher; only the compute execution is scripted here. */
export async function servicesHarness(dispatch = true) {
    const directory = await mkdtemp(join(tmpdir(), "svc-"));
    const connection = await openAgentSQLiteDatabase(join(directory, "state.db"));
    try {
        const ctx = withAgentPermissionMode(
            withAgentDatabase(
                createRootContext().named("service-module-tests"),
                connection.database,
            ),
            "auto",
        );
        const storage = new AgentStorage({
            database: connection.database,
            acquireLock: async () => ({ release: async () => {} }),
        });
        const config = await testConfigRootedAt(directory);
        if (process.platform !== "linux") {
            // The controller runs over a scripted Linux compute; platform-native path enforcement is
            // tested separately by Config and the real Linux supervisor lane.
            vi.spyOn(config, "serviceExecution").mockImplementation((id) => ({
                id,
                directory: `/scripted-services/${id}`,
            }));
        }
        const agentConfigs = new Map<string, AgentConfig>(
            [ownerId, peerId, childId].map((id) => [
                id,
                { modules: { compute: { cwd: directory } } },
            ]),
        );
        const parents = new Map([[childId, ownerId]]);
        const agents = {
            config: async (_ctx: Context, id: string) => agentConfigs.get(id),
            parentOf: async (_ctx: Context, id: string) => parents.get(id) ?? null,
            childOf: async (_ctx: Context, id: string) =>
                [...parents.entries()]
                    .filter(([, parent]) => parent === id)
                    .map(([child]) => child),
            abort: vi.fn(async () => {}),
        } as unknown as AgentSystemRef;
        let held = false;
        let endpointReachable = false;
        const running: {
            service: ComputeService;
            finish: () => void;
            output: { stdout: string; stderr: string };
        }[] = [];
        const start = vi.fn(
            async (_ctx: Context, options: ComputeServiceStartOptions): Promise<ComputeService> => {
                let resolve!: (exit: ComputeServiceExit) => void;
                const completion = new Promise<ComputeServiceExit>((done) => {
                    resolve = done;
                });
                const finish = () =>
                    resolve({ exitCode: null, killed: true, startupFailed: false });
                const output = { stdout: "", stderr: "" };
                const service: ComputeService = {
                    execution: options.execution,
                    processId: `native-${String(running.length)}`,
                    admitted: Promise.resolve(true),
                    completion,
                    read: (position) => ({
                        stdout: output.stdout.slice(position.stdout),
                        stderr: output.stderr.slice(position.stderr),
                        position: { stdout: output.stdout.length, stderr: output.stderr.length },
                        truncated: false,
                    }),
                    connect: async () => {
                        if (endpointReachable) return new Socket();
                        throw new Error("The test endpoint is not listening.");
                    },
                    write: vi.fn(async () => true),
                    stop: vi.fn(async () => {
                        if (!held) finish();
                        return await completion;
                    }),
                };
                running.push({ service, finish, output });
                return service;
            },
        );
        const reconcile = vi.fn(async () => {});
        const compute = ComputeModule.withProvider(config, new SecretsModule(), {
            id: "host",
            create: async (_ctx, options) =>
                Object.assign(new FakeCompute(options.cwd), {
                    services: {
                        start,
                        reconcile,
                        dispose: async () => {
                            for (const entry of running) entry.finish();
                        },
                    },
                    dispose: async () => {
                        for (const entry of running) entry.finish();
                    },
                }),
        });
        const durable = new DurableFunctionsModule();
        const abort = new AbortModule(compute);
        const git = new GitModule();
        const projects = new ProjectsModule(config, git, abort, durable);
        const workspaces = new WorkspacesModule(config, projects, git, abort, durable);
        const events = new EventsModule();
        const titles = new TitlesModule(config, new HistoryModule(events), workspaces);
        const bots = new BotsModule(config, abort, titles, projects, workspaces);
        const services = new ServicesModule(
            config,
            compute,
            workspaces,
            projects,
            bots,
            durable,
            events,
        );
        const scope = { sharedKV: storage.kv.scoped("services") } as AgentModuleSystemScope;
        await storage.migrate(ctx, [durable, projects, workspaces, bots, events]);
        const durableHooks = durable.beforeStart(ctx);
        abort.beforeStart(ctx, agents);
        projects.beforeStart(ctx, agents);
        workspaces.beforeStart(ctx, agents);
        bots.beforeStart(ctx, agents);
        await events.beforeStart(ctx);
        const hooks = services.beforeStart(ctx, agents);
        await hooks.agentCreatedTransact!(ctx, scope, { id: ownerId, metadata: undefined });
        const computeHooks = compute.beforeStart();
        await computeHooks.agentCreatedTransact!(
            ctx,
            { sharedKV: storage.kv.scoped("compute") } as AgentModuleSystemScope,
            { id: ownerId, metadata: undefined },
        );
        await projects.create(ctx, {
            id: workspaceId,
            repositoryRef: directory,
            name: "Test workspace",
            kind: "home",
        });
        await projects.attachAgent(ctx, workspaceId, ownerId);
        await projects.attachAgent(ctx, workspaceId, peerId);
        const beginDispatch = async () => await durableHooks.afterStart!(ctx, agents);
        if (dispatch) await beginDispatch();
        return {
            ctx,
            storage,
            config,
            services,
            abort,
            durable,
            compute,
            projects,
            workspaces,
            bots,
            events,
            agents,
            agentConfigs,
            scope,
            hooks,
            start,
            reconcile,
            running,
            beginDispatch,
            holdCleanup() {
                held = true;
            },
            setEndpointReachable(value: boolean) {
                endpointReachable = value;
            },
            finishCleanup() {
                held = false;
                for (const entry of running) entry.finish();
            },
            async close() {
                held = false;
                for (const entry of running) entry.finish();
                await services.closeWorkspaceAdmission(ctx, workspaceId);
                await beginDispatch();
                await services.confirmWorkspaceStopped(ctx, workspaceId);
                await waitForCondition(async () => (await pendingCallCount(ctx)) === 0);
                await compute.dispose(ctx);
                durable.stop();
                await workspaces.close(ctx);
                await titles.close();
                await bots.close();
                git.dispose();
                await connection.close();
                await rm(directory, { recursive: true, force: true });
            },
        };
    } catch (error: unknown) {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}
