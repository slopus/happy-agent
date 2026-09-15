import { createId } from "@paralleldrive/cuid2";
import type { Socket } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import {
    cuid2Schema,
    withAgentConfig,
    withAgentDatabase,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleSystemScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    workspaceServiceListQuerySchema,
    type WorkspaceService,
    type WorkspaceServiceChanges,
    type WorkspaceServiceListQuery,
} from "@slopus/happy-agent-client";
import {
    computePermissions,
    type ComputeService,
    type ComputeServiceStartOptions,
} from "@slopus/happy-agent-compute";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, backoff, detach, type Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../bots/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import type { DurableFunctionsModule } from "../durableFunctions/index.js";
import type { EventsModule } from "../events/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import { ServiceRecords, type ServiceRecord } from "./persistence/ServiceRecords.js";
import { servicePageCursor, readServicePageCursor } from "./impl/ServicePageCursor.js";
import { ServiceAccessTokens } from "./impl/ServiceAccessTokens.js";
import {
    serviceDefinitionSchema,
    serviceExecutionCallSchema,
    serviceEventSchema,
    ServiceError,
    type ServiceDefinition,
    type ServiceEvent,
    type ServiceEventListener,
    type ServiceExecutionCall,
} from "./Service.js";

const EXECUTE_SERVICE = "services.execution";
const archivedAgentSchema = Type.Object(
    { archived: Type.Literal(true) },
    { additionalProperties: true },
);
const callableSchema = Type.Function([], Type.Any());
interface ServiceWorkspace {
    workspaceId: string;
    path: string;
    available: boolean;
}
interface LiveService {
    service: ComputeService;
    workspaceId: string;
    endedAt?: number;
    retirement?: NodeJS.Timeout;
}

/** Agent-owned executions, with management shared only inside their exact owning workspace. */
export class ServicesModule implements AgentModule {
    readonly name = "services";
    readonly #daemonId = createId();
    readonly #tokens = new ServiceAccessTokens();
    readonly #listeners = new Set<ServiceEventListener>();
    readonly #live = new Map<string, LiveService>();
    #records: ServiceRecords | undefined;
    #agents: AgentSystemRef | undefined;
    #lifetime: Context | undefined;
    #closed = false;

    constructor(
        readonly config: ConfigModule,
        readonly compute: ComputeModule,
        readonly workspaces: WorkspacesModule,
        readonly projects: ProjectsModule,
        readonly bots: BotsModule,
        readonly durableFunctions: DurableFunctionsModule,
        readonly events: EventsModule,
    ) {
        durableFunctions.register({
            name: EXECUTE_SERVICE,
            argumentsSchema: serviceExecutionCallSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                // Transient metadata failures must not make Durable Functions discard cleanup
                // ownership. A persisted spawn claim below prevents retries from replaying commands.
                await backoff(
                    ctx,
                    async (retryCtx) => await this.#execute(retryCtx, call.arguments, call.kv),
                );
                return null;
            },
        });
        compute.onAgentAbortTransactional(
            async (ctx, agentId) => await this.stopOwner(ctx, agentId),
        );
        compute.onServiceStopTransactional(async (ctx, agentId, execution) => {
            const workspaceId = await this.#records?.ownerWorkspace(ctx, agentId);
            if (workspaceId === undefined) return;
            const record = await this.#records?.query(ctx, workspaceId, execution.id);
            if (
                record?.service.agentId === agentId &&
                record.execution.directory === execution.directory
            ) {
                await this.stop(ctx, workspaceId, record.service.id);
            }
        });
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        this.#lifetime = withAgentDatabase(detach(ctx).named("workspace-services"), ctx.db);
        ctx.lifetime?.addEventListener(
            "abort",
            () => {
                this.#closed = true;
                for (const live of this.#live.values()) this.#revoke(live);
            },
            { once: true },
        );
        const capture = (_ctx: Context, scope: AgentModuleSystemScope) => {
            this.#records ??= new ServiceRecords(scope.sharedKV);
        };
        return {
            agentCreatedTransact: capture,
            agentRestoredTransact: capture,
            agentArchivedTransact: async (hookCtx, scope, agent) => {
                capture(hookCtx, scope);
                await this.stopOwner(hookCtx, agent.id);
            },
        };
    };

    onEvent(listener: ServiceEventListener): () => void {
        if (!Value.Check(callableSchema, listener))
            throw new Error("A service subscriber must be a function.");
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Resolve membership from durable placement, never a workspace ID supplied by a model. */
    async workspaceForAgent(ctx: Context, agentId: string): Promise<ServiceWorkspace> {
        if (!Value.Check(cuid2Schema, agentId))
            throw new ServiceError("not_found", "The service owner was not found.");
        const agents = this.#requireAgents();
        const visited = new Set<string>();
        let current: string | null = agentId;
        while (current !== null) {
            if (visited.has(current) || visited.size >= 64)
                throw new ServiceError(
                    "invalid_request",
                    "The service owner's ancestry is invalid or too deep.",
                );
            visited.add(current);
            const bot = await this.bots.forAgent(ctx, current);
            if (bot !== undefined)
                return {
                    workspaceId: bot.workspaceId,
                    path: bot.path,
                    available: bot.status === "active",
                };
            if (this.config.configuration.values.features.workspaces) {
                const workspaceId = await this.workspaces.workspaceForAgent(ctx, current);
                if (workspaceId !== undefined) return await this.workspace(ctx, workspaceId);
            }
            const project = await this.projects.projectForAgent(ctx, current);
            if (project !== undefined)
                return {
                    workspaceId: project.id,
                    path: project.repositoryRef,
                    available:
                        project.status === "active" && project.initializationStatus === "ready",
                };
            current = await agents.parentOf(ctx, current);
        }
        throw new ServiceError("not_found", "This agent does not belong to a service workspace.");
    }

    async workspace(ctx: Context, workspaceId: string): Promise<ServiceWorkspace> {
        if (!Value.Check(cuid2Schema, workspaceId))
            throw new ServiceError("not_found", "The workspace was not found.");
        const bot = await this.bots.forWorkspace(ctx, workspaceId);
        if (bot !== undefined)
            return { workspaceId, path: bot.path, available: bot.status === "active" };
        const project = await this.projects.get(ctx, workspaceId);
        if (project !== undefined)
            return {
                workspaceId,
                path: project.repositoryRef,
                available: project.status === "active" && project.initializationStatus === "ready",
            };
        if (this.config.configuration.values.features.workspaces) {
            const workspace = await this.workspaces.get(ctx, workspaceId);
            if (workspace !== undefined) {
                const owner = await this.projects.get(ctx, workspace.projectRef);
                return {
                    workspaceId,
                    path: workspace.path,
                    available: workspace.status === "ready" && owner?.status === "active",
                };
            }
        }
        throw new ServiceError("not_found", "The workspace was not found.");
    }

    async start(
        ctx: Context,
        agentId: string,
        definition: ServiceDefinition,
    ): Promise<WorkspaceService> {
        if (!Value.Check(serviceDefinitionSchema, definition))
            throw new ServiceError("invalid_request", "The service definition is invalid.");
        if (this.#closed) throw new Error("Workspace services are shutting down.");
        const permissions = this.compute.permissionsForContext(ctx);
        if (permissions.mode !== "auto" && permissions.mode !== "full_access")
            throw new Error("Starting a sandboxed service requires Auto or Full access.");
        const owner = await this.workspaceForAgent(ctx, agentId);
        if (!owner.available) throw new Error("This workspace is not available for new services.");
        const agentConfig = await this.#requireAgents().config(ctx, agentId);
        if (agentConfig === undefined || Value.Check(archivedAgentSchema, agentConfig.metadata))
            throw new Error("This agent is not available for new services.");
        const compute = await this.compute.resolve(withAgentConfig(ctx, agentConfig), agentId);
        if (compute?.services === undefined)
            throw new Error("This compute cannot enforce sandboxed services.");
        if (compute.cwd !== owner.path)
            throw new Error("The service compute does not match its owning workspace directory.");
        const id = createId();
        const execution = this.config.serviceExecution(id);
        const networkPolicy = await this.config.serviceNetworkPolicy(owner.path);
        const sandbox = structuredClone(definition.sandbox);
        sandbox.outbound = [
            ...new Map(
                sandbox.outbound.map((destination) => {
                    const hostname = destination.hostname.toLowerCase().replace(/\.$/u, "");
                    return [
                        `${hostname}:${String(destination.port)}`,
                        { hostname, port: destination.port },
                    ];
                }),
            ).values(),
        ];
        const options: ComputeServiceStartOptions = {
            execution,
            command: definition.command,
            cwd: definition.cwd,
            port: definition.port,
            tty: definition.tty,
            sandbox,
            // Auto reviews this exact dedicated action. The SDK still intersects these requested
            // destinations with user policy and enforces its mandatory private-network sandbox.
            permissions:
                permissions.mode === "full_access"
                    ? permissions
                    : computePermissions(permissions.mode, {
                          network: {
                              egress: sandbox.outbound.length > 0,
                              localBinding: false,
                              allowedHosts: sandbox.outbound.map(({ hostname }) => hostname),
                          },
                      }),
            ...(networkPolicy === undefined ? {} : { networkPolicy }),
        };
        const records = this.#requireRecords();
        return await records.kv.transaction(ctx, async (_, txCtx) => {
            // Archive and creation use the same transactional admission boundary.
            if (!(await this.workspace(txCtx, owner.workspaceId)).available)
                throw new Error("This workspace is closed to new services.");
            const currentAgent = await this.#requireAgents().config(txCtx, agentId);
            if (
                currentAgent === undefined ||
                Value.Check(archivedAgentSchema, currentAgent.metadata)
            )
                throw new Error("This agent is closed to new services.");
            const now = Date.now();
            const record = await records.create(txCtx, {
                execution,
                service: {
                    id,
                    workspaceId: owner.workspaceId,
                    agentId,
                    processId: null,
                    name: definition.name,
                    command: options.command,
                    cwd: options.cwd,
                    port: options.port,
                    tty: options.tty,
                    protocol: "http",
                    access: "workspace",
                    sandbox,
                    status: "starting",
                    endpointStatus: "waiting",
                    exitCode: null,
                    error: null,
                    version: this.events.resourceVersion(),
                    createdAt: now,
                    updatedAt: now,
                    startedAt: null,
                    endedAt: null,
                },
            });
            await this.durableFunctions.invoke(txCtx, {
                function: EXECUTE_SERVICE,
                operationId: `service.execution.${id}`,
                lockKeys: [`service.${id}`],
                arguments: {
                    workspaceId: owner.workspaceId,
                    serviceId: id,
                    daemonId: this.#daemonId,
                    options,
                },
            });
            this.#publish(txCtx, { type: "service.created", service: record.service });
            return record.service;
        });
    }

    async list(
        ctx: Context,
        workspaceId: string,
        query: WorkspaceServiceListQuery = {},
    ): Promise<{ services: WorkspaceService[]; nextPageCursor: string | null }> {
        await this.workspace(ctx, workspaceId);
        if (!Value.Check(workspaceServiceListQuerySchema, query))
            throw new ServiceError("invalid_request", "The service list query is invalid.");
        const includeStopped = query.includeStopped ?? false;
        const before = readServicePageCursor(workspaceId, includeStopped, query.pageCursor);
        const page = await this.#records?.queryPage(ctx, workspaceId, {
            includeStopped,
            limit: query.limit ?? 50,
            ...(before === undefined ? {} : { before }),
        });
        return {
            services: page?.records.map(({ service }) => service) ?? [],
            nextPageCursor: servicePageCursor(
                workspaceId,
                includeStopped,
                page?.nextBefore ?? null,
            ),
        };
    }

    async get(ctx: Context, workspaceId: string, serviceId: string): Promise<WorkspaceService> {
        return (await this.#record(ctx, workspaceId, serviceId)).service;
    }

    /** Commit revocation now; the durable execution records terminal state only after teardown. */
    async stop(ctx: Context, workspaceId: string, serviceId: string): Promise<WorkspaceService> {
        return await this.#change(
            ctx,
            workspaceId,
            serviceId,
            (service) =>
                terminal(service) || service.status === "stopping"
                    ? undefined
                    : {
                          status: "stopping",
                          endpointStatus: "unavailable",
                          updatedAt: Math.max(Date.now(), service.updatedAt),
                      },
            false,
            true,
        );
    }

    async stopOwner(ctx: Context, agentId: string): Promise<void> {
        const workspaceId = await this.#records?.ownerWorkspace(ctx, agentId);
        if (workspaceId === undefined) return;
        const page = await this.#requireRecords().queryPage(ctx, workspaceId, {
            includeStopped: false,
            limit: 32,
        });
        for (const { service } of page.records) {
            if (service.agentId === agentId) await this.stop(ctx, workspaceId, service.id);
        }
    }

    /** A recovered durable call proves teardown but never replays its stored command. */
    async #execute(ctx: Context, call: ServiceExecutionCall, callKV: AgentKV): Promise<void> {
        const record = await this.#record(ctx, call.workspaceId, call.serviceId);
        if (terminal(record.service)) return;
        const agentConfig = await this.#requireAgents().config(ctx, record.service.agentId);
        if (agentConfig === undefined)
            throw new Error("Service cleanup cannot resolve its owning agent configuration.");
        const ownerCtx = withAgentConfig(ctx, agentConfig);
        const attempted = await callKV.read(ctx, "spawn-attempted!");
        if (attempted !== undefined && !Value.Check(Type.Literal(true), attempted))
            throw new Error("The service spawn claim is invalid.");
        if (
            attempted === true ||
            call.daemonId !== this.#daemonId ||
            record.service.status !== "starting" ||
            this.#closed ||
            ctx.lifetime?.aborted
        ) {
            const live = this.#live.get(call.serviceId);
            if (live !== undefined) this.#revoke(live);
            await this.#reconcile(
                ctx,
                ownerCtx,
                record,
                "runtime_lost",
                "The service was interrupted and was not restarted.",
            );
            return;
        }
        let live: LiveService | undefined;
        const probeLifetime = new AbortController();
        let probing: Promise<void> | undefined;
        const stopOnShutdown = () => {
            probeLifetime.abort();
            if (live !== undefined) this.#revoke(live);
        };
        ctx.lifetime?.addEventListener("abort", stopOnShutdown, { once: true });
        try {
            await this.config.prepareServiceControls();
            // Recheck the durable stop decision after preparation, before asking Compute to spawn.
            if (
                (await this.get(ctx, call.workspaceId, call.serviceId)).status !== "starting" ||
                ctx.lifetime?.aborted ||
                this.#closed
            ) {
                await this.#reconcile(
                    ctx,
                    ownerCtx,
                    record,
                    "stopped_before_start",
                    "The service was stopped before startup.",
                );
                return;
            }
            // A failure after this write can only reconcile. Even a process that started before
            // its next metadata update can never cause this invocation to spawn a second command.
            await callKV.write(ctx, "spawn-attempted!", true);
            const started = await this.compute.startService(
                ownerCtx,
                record.service.agentId,
                call.options,
            );
            live = { service: started.service, workspaceId: call.workspaceId };
            this.#live.set(call.serviceId, live);
            await this.#change(ctx, call.workspaceId, call.serviceId, (service) => ({
                processId: started.process.id,
                updatedAt: Math.max(Date.now(), service.updatedAt),
            }));
            if (
                ctx.lifetime?.aborted ||
                this.#closed ||
                (await this.get(ctx, call.workspaceId, call.serviceId)).status === "stopping"
            )
                this.#revoke(live);
            const admitted = await started.service.admitted;
            if (admitted) {
                await this.#change(ctx, call.workspaceId, call.serviceId, (service) => ({
                    ...(service.status === "starting" ? { status: "running" as const } : {}),
                    startedAt: started.process.startedAt,
                    updatedAt: Math.max(Date.now(), service.updatedAt),
                }));
                probing = this.#probe(ctx, call.serviceId, live, probeLifetime.signal).catch(
                    () => undefined,
                );
            }
            const exit = await started.service.completion;
            await this.#change(
                ctx,
                call.workspaceId,
                call.serviceId,
                (service) => ({
                    status: exit.startupFailed
                        ? "failed"
                        : exit.killed || service.status === "stopping"
                          ? "killed"
                          : "completed",
                    endpointStatus: "unavailable",
                    exitCode: exit.exitCode,
                    error: exit.startupFailed
                        ? {
                              code: "startup_failed",
                              message: "The service sandbox or command could not be started.",
                          }
                        : null,
                    endedAt: Math.max(Date.now(), service.updatedAt),
                    updatedAt: Math.max(Date.now(), service.updatedAt),
                }),
                true,
            );
        } catch (error: unknown) {
            if (live !== undefined) this.#revoke(live);
            if (ctx.lifetime?.aborted) throw error;
            await this.#reconcile(
                ctx,
                ownerCtx,
                record,
                "startup_failed",
                "The service runtime could not be established or was lost.",
            );
        } finally {
            ctx.lifetime?.removeEventListener("abort", stopOnShutdown);
            probeLifetime.abort();
            await probing;
        }
    }

    /** Readiness is only a bounded connect probe, never an application health assertion. */
    async #probe(
        ctx: Context,
        serviceId: string,
        live: LiveService,
        signal: AbortSignal,
    ): Promise<void> {
        while (!signal.aborted && !this.#closed) {
            const current = await this.get(ctx, live.workspaceId, serviceId);
            if (current.status !== "running") return;
            let endpointStatus: "waiting" | "reachable" = "waiting";
            try {
                const socket = await live.service.connect(ctx);
                socket.destroy();
                endpointStatus = "reachable";
            } catch {
                /* A running process need not have opened its declared endpoint yet. */
            }
            if (signal.aborted) return;
            if (current.endpointStatus !== endpointStatus) {
                await this.#change(ctx, live.workspaceId, serviceId, (service) =>
                    service.status !== "running" || service.endpointStatus === endpointStatus
                        ? undefined
                        : {
                              endpointStatus,
                              updatedAt: Math.max(Date.now(), service.updatedAt),
                          },
                );
            }
            await pause(500, undefined, { signal });
        }
    }

    async #reconcile(
        ctx: Context,
        ownerCtx: Context,
        record: ServiceRecord,
        code: string,
        message: string,
    ): Promise<void> {
        await backoff(
            ctx,
            async (retryCtx) => {
                const config = await this.#requireAgents().config(ownerCtx, record.service.agentId);
                if (config === undefined)
                    throw new Error(
                        "Service cleanup cannot resolve its owning agent configuration.",
                    );
                await this.compute.reconcileService(
                    withAgentConfig(retryCtx, config),
                    record.service.agentId,
                    record.execution,
                );
            },
            {
                onError: async (retryCtx) => {
                    await this.#change(
                        retryCtx,
                        record.service.workspaceId,
                        record.service.id,
                        (service) =>
                            terminal(service)
                                ? undefined
                                : {
                                      status: "stopping",
                                      endpointStatus: "unavailable",
                                      error: {
                                          code: "cleanup_unconfirmed",
                                          message:
                                              "The service sandbox cleanup is not confirmed. Its workspace files must be retained.",
                                      },
                                      updatedAt: Math.max(Date.now(), service.updatedAt),
                                  },
                    );
                },
            },
        );
        await this.#change(
            ctx,
            record.service.workspaceId,
            record.service.id,
            (service) =>
                terminal(service)
                    ? undefined
                    : {
                          status: "failed",
                          endpointStatus: "unavailable",
                          error: { code, message },
                          endedAt: Math.max(Date.now(), service.updatedAt),
                          updatedAt: Math.max(Date.now(), service.updatedAt),
                      },
            true,
        );
    }

    async #record(ctx: Context, workspaceId: string, serviceId: string): Promise<ServiceRecord> {
        if (!Value.Check(cuid2Schema, workspaceId) || !Value.Check(cuid2Schema, serviceId))
            throw new ServiceError("not_found", "The service was not found.");
        const record = await this.#records?.query(ctx, workspaceId, serviceId);
        if (record === undefined) throw new ServiceError("not_found", "The service was not found.");
        return record;
    }

    async #change(
        ctx: Context,
        workspaceId: string,
        serviceId: string,
        update: (service: WorkspaceService) => WorkspaceServiceChanges | undefined,
        confirmedTeardown = false,
        revoke = false,
    ): Promise<WorkspaceService> {
        const records = this.#requireRecords();
        return await records.kv.transaction(ctx, async (_, txCtx) => {
            const { service } = await this.#record(txCtx, workspaceId, serviceId);
            const changes = update(service);
            if (revoke)
                afterCommit(txCtx, () => {
                    const live = this.#live.get(serviceId);
                    if (live !== undefined) this.#revoke(live);
                });
            if (changes === undefined) return service;
            const next: WorkspaceService = {
                ...service,
                ...changes,
                version: this.events.resourceVersion(),
            };
            await records.replace(txCtx, next, service.version, confirmedTeardown);
            if (confirmedTeardown && terminal(next))
                afterCommit(txCtx, () => {
                    const live = this.#live.get(serviceId);
                    if (live !== undefined) {
                        live.endedAt = next.endedAt!;
                        this.#trimCompleted();
                    }
                });
            this.#publish(txCtx, {
                type: "service.updated",
                serviceId,
                workspaceId,
                previousVersion: service.version,
                version: next.version,
                changes,
            });
            return next;
        });
    }

    async accessToken(
        ctx: Context,
        principalId: string,
        workspaceId: string,
        serviceId: string,
    ): Promise<{ accessToken: string; expiresAt: number }> {
        const record = await this.#record(ctx, workspaceId, serviceId);
        this.#running(record.service);
        return this.#tokens.issue({
            principalId,
            workspaceId,
            serviceId,
            executionId: record.execution.id,
        });
    }

    /** This fixed endpoint is for the authenticated HTTP gateway, never an arbitrary dial tool. */
    async connect(
        ctx: Context,
        principalId: string,
        workspaceId: string,
        serviceId: string,
        accessToken: string | undefined,
    ): Promise<Socket> {
        const record = await this.#record(ctx, workspaceId, serviceId);
        this.#tokens.authorize(accessToken, {
            principalId,
            workspaceId,
            serviceId,
            executionId: record.execution.id,
        });
        const live = this.#running(record.service);
        try {
            return await live.service.connect(ctx);
        } catch {
            throw new ServiceError(
                "service_unavailable",
                "The service endpoint is not accepting connections yet.",
            );
        }
    }

    /** Strong barrier for agent stops and workspace removal; logical archival need not await it. */
    async stopAndWait(
        ctx: Context,
        workspaceId: string,
        serviceId: string,
    ): Promise<{ service: WorkspaceService; stopped: boolean }> {
        const before = await this.get(ctx, workspaceId, serviceId);
        if (terminal(before)) return { service: before, stopped: false };
        await this.stop(ctx, workspaceId, serviceId);
        const deadline = performance.now() + 12_000;
        for (;;) {
            const service = await this.get(ctx, workspaceId, serviceId);
            if (terminal(service)) return { service, stopped: true };
            if (performance.now() >= deadline)
                throw new Error(
                    "Service teardown is not confirmed. Its workspace files must be retained.",
                );
            await pause(50, undefined, { signal: ctx.lifetime });
        }
    }

    async closeWorkspaceAdmission(ctx: Context, workspaceId: string): Promise<readonly string[]> {
        if (this.#records === undefined) return [];
        return await this.#records.kv.transaction(ctx, async (_, txCtx) => {
            const ids = await this.#requireRecords().closeAdmission(txCtx, workspaceId);
            for (const id of ids) await this.stop(txCtx, workspaceId, id);
            return ids;
        });
    }

    async confirmWorkspaceStopped(ctx: Context, workspaceId: string): Promise<void> {
        const page = await this.#records?.queryPage(ctx, workspaceId, {
            includeStopped: false,
            limit: 32,
        });
        const results = await Promise.allSettled(
            (page?.records ?? []).map(({ service }) =>
                this.stopAndWait(ctx, workspaceId, service.id),
            ),
        );
        const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
            throw new AggregateError(failures, "Workspace service teardown is not confirmed.");
    }

    #running(service: WorkspaceService): LiveService {
        const live = this.#live.get(service.id);
        if (
            this.#closed ||
            service.status !== "running" ||
            live === undefined ||
            live.endedAt !== undefined
        )
            throw new ServiceError("service_not_running", "The service is not running.");
        return live;
    }

    #revoke(live: LiveService): void {
        // stop() revokes synchronously. The durable execution, not this detached notification,
        // owns recording completion or retaining the cleanup error.
        void live.service.stop(this.#requireLifetime()).catch(() => undefined);
    }

    #trimCompleted(): void {
        const now = Date.now();
        const completed = [...this.#live.entries()]
            .filter(([, live]) => live.endedAt !== undefined)
            .sort((a, b) => a[1].endedAt! - b[1].endedAt!);
        const counts = new Map<string, number>();
        for (const [, live] of completed)
            counts.set(live.workspaceId, (counts.get(live.workspaceId) ?? 0) + 1);
        let retained = completed.length;
        for (const [id, live] of completed) {
            if (
                live.endedAt! + 3_600_000 <= now ||
                retained > 4096 ||
                counts.get(live.workspaceId)! > 256
            ) {
                if (live.retirement !== undefined) clearTimeout(live.retirement);
                this.#live.delete(id);
                counts.set(live.workspaceId, counts.get(live.workspaceId)! - 1);
                retained -= 1;
            } else if (live.retirement === undefined) {
                live.retirement = setTimeout(
                    () => {
                        this.#live.delete(id);
                    },
                    live.endedAt! + 3_600_000 - now,
                );
                live.retirement.unref();
            }
        }
    }

    #publish(ctx: Context, event: ServiceEvent): void {
        if (!Value.Check(serviceEventSchema, event))
            throw new Error("The service lifecycle event is invalid.");
        const snapshot = structuredClone(event);
        afterCommit(ctx, async () => {
            for (const listener of this.#listeners) {
                try {
                    await listener(structuredClone(snapshot));
                } catch {
                    this.#requireLifetime().log.warn("A service lifecycle subscriber failed.");
                }
            }
        });
    }

    #requireRecords(): ServiceRecords {
        if (this.#records === undefined)
            throw new Error("The service module has no supplied shared store yet.");
        return this.#records;
    }
    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The service module has not started.");
        return this.#agents;
    }
    #requireLifetime(): Context {
        if (this.#lifetime === undefined) throw new Error("The service module has not started.");
        return this.#lifetime;
    }
}

function terminal(service: WorkspaceService): boolean {
    return (
        service.status === "completed" || service.status === "killed" || service.status === "failed"
    );
}
