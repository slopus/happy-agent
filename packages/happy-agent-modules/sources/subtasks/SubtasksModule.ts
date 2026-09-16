import {
    currentAgentEnvironment,
    type AgentConfig,
    type AgentModule,
    type AgentModuleAgent,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { backoff, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { AbortModule } from "../abort/index.js";
import { CollaborationModule } from "../collaboration/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import {
    archivedMetadataSchema,
    createSubtaskInputSchema,
    SUBTASK_START_FUNCTION,
    subtaskIdSchema,
    subtaskMetadataSchema,
    subtaskStartSchema,
    SubtaskInputError,
    workspaceSubtaskMetadataSchema,
    type CreateSubtaskInput,
    type SubtaskResult,
    type SubtaskStart,
} from "./Subtask.js";
import { createSubtaskTool } from "./tools/create_subtask.js";

/** User-interactive delegation, with ordinary Agent Base ancestry and durable initial delivery. */
export class SubtasksModule implements AgentModule {
    readonly name = "subtasks";
    readonly #bots: BotsModule;
    readonly #abort: AbortModule;
    readonly #collaboration: CollaborationModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #workspaces: WorkspacesModule;
    #agents: AgentSystemRef | undefined;

    constructor(
        bots: BotsModule,
        collaboration: CollaborationModule,
        workspaces: WorkspacesModule,
        durableFunctions: DurableFunctionsModule,
        abort: AbortModule,
    ) {
        this.#bots = bots;
        this.#abort = abort;
        this.#collaboration = collaboration;
        this.#workspaces = workspaces;
        this.#durableFunctions = durableFunctions;
        durableFunctions.register({
            name: SUBTASK_START_FUNCTION,
            argumentsSchema: subtaskStartSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#start(ctx, call.arguments);
                return null;
            },
        });
    }

    isSubtask(config: AgentConfig | AgentModuleAgent | undefined): boolean {
        return Value.Check(subtaskMetadataSchema, config?.metadata);
    }

    modelDescription(): string {
        return this.#collaboration
            .availableModels()
            .map(
                (model) =>
                    `- ${model.providerId} + ${model.id} (${model.name}; effort: ${model.effortLevels.join(", ")}${model.serviceTiers === undefined ? "" : `; tiers: ${model.serviceTiers.join(", ")}`})`,
            )
            .join("\n");
    }

    async create(
        ctx: Context,
        parentAgentId: string,
        input: CreateSubtaskInput,
        agentId: string,
        workspaceId?: string,
        currentProviderId?: string,
    ): Promise<SubtaskResult> {
        if (
            !Value.Check(createSubtaskInputSchema, input) ||
            !Value.Check(subtaskIdSchema, parentAgentId) ||
            !Value.Check(subtaskIdSchema, agentId) ||
            (workspaceId !== undefined && !Value.Check(subtaskIdSchema, workspaceId))
        ) {
            throw new Error("The subtask creation request is invalid.");
        }
        if ((input.workspace === undefined) !== (workspaceId === undefined)) {
            throw new Error("A workspace-bound subtask needs its own workspace identity.");
        }
        const { workspace: requestedWorkspace, ...task } = input;
        const agents = this.#requireAgents();
        return await ctx.inTx(async (txCtx) => {
            const existing = await agents.config(txCtx, agentId);
            if (existing !== undefined) {
                if (
                    !this.isSubtask(existing) ||
                    (await agents.parentOf(txCtx, agentId)) !== parentAgentId ||
                    existing.metadata?.["subtaskWorkspaceId"] !== workspaceId
                ) {
                    throw new Error("That agent identity already belongs to another task.");
                }
                return { agentId, ...(workspaceId === undefined ? {} : { workspaceId }) };
            }
            const parent = await this.#assertCanCreate(txCtx, parentAgentId);
            const selection = this.#collaboration.selectModel(task, currentProviderId);
            const resolvedInput = { ...input, ...selection };
            const workspace =
                requestedWorkspace === undefined
                    ? undefined
                    : await this.#workspaces.createWorkspace(
                          txCtx,
                          requestedWorkspace.projectId,
                          {
                              id: workspaceId!,
                              name: requestedWorkspace.name,
                              nameConfigured: true,
                              ...(requestedWorkspace.baseRef === undefined
                                  ? {}
                                  : { baseRef: requestedWorkspace.baseRef }),
                          },
                          parentAgentId,
                          { operationId: agentId, subtaskAgentId: agentId },
                      );
            if (requestedWorkspace !== undefined && workspace === undefined) {
                throw new Error("The subtask's project was not found.");
            }
            const now = Date.now();
            const config: AgentConfig = {
                provenance: { createdAt: now },
                ...(parent.environment === undefined ? {} : { environment: parent.environment }),
                ...(parent.modules === undefined ? {} : { modules: parent.modules }),
                ...(workspace === undefined
                    ? {}
                    : {
                          environment: {
                              ...(parent.environment ?? currentAgentEnvironment()),
                              workingDirectory: workspace.path,
                          },
                          modules: {
                              ...parent.modules,
                              compute: {
                                  cwd: workspace.path,
                                  secretScope: {
                                      projectId: workspace.projectRef,
                                      workspaceId: workspace.id,
                                  },
                              },
                          },
                      }),
                metadata: {
                    title: input.title,
                    subtask: true,
                    updatedAt: now,
                    version: 1,
                    ...(workspaceId === undefined ? {} : { subtaskWorkspaceId: workspaceId }),
                },
            };
            await agents.create(txCtx, config, { id: agentId, parent: parentAgentId });
            if (workspace !== undefined) {
                await this.#workspaces.attachManagedRootAgent(txCtx, workspace.id, agentId);
            }
            await this.#durableFunctions.invoke(txCtx, {
                function: SUBTASK_START_FUNCTION,
                arguments: {
                    agentId,
                    parentAgentId,
                    input: resolvedInput,
                    ...(workspaceId === undefined ? {} : { workspaceId }),
                },
                operationId: `subtask-start:${agentId}`,
                lockKeys: [`subtask:${agentId}`],
            });
            return { agentId, ...(workspaceId === undefined ? {} : { workspaceId }) };
        });
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            metadataChangedTransact: async (ctx, scope, change) => {
                if (
                    this.isSubtask(scope.agent) &&
                    Value.Check(archivedMetadataSchema, change.update)
                ) {
                    await this.#durableFunctions.cancel(ctx, `subtask-start:${scope.agent.id}`);
                    await this.#abort.abort(ctx, scope.agent.id);
                }
            },
            beforeAgentLoop: async (ctx, scope) => {
                if (!this.isSubtask(scope.agent)) return;
                // User messages may arrive while a newly reserved workspace is still being built.
                // They remain durable, but no inference or tool may run against an unready folder.
                let currentId = scope.agent.id;
                for (let depth = 0; depth < 3; depth += 1) {
                    const config = await agents.config(ctx, currentId);
                    if (Value.Check(workspaceSubtaskMetadataSchema, config?.metadata)) {
                        const workspaceId = config.metadata.subtaskWorkspaceId;
                        const ready = await backoff(
                            ctx,
                            async (attemptCtx) => {
                                const workspace = await this.#workspaces.get(
                                    attemptCtx,
                                    workspaceId,
                                );
                                if (workspace?.status === "initializing")
                                    throw new Error(
                                        "The subtask workspace is still being prepared.",
                                    );
                                return workspace?.status === "ready";
                            },
                            { initialDelay: 50, maxDelay: 1_000 },
                        );
                        if (!ready)
                            throw new SubtaskInputError("The subtask workspace is unavailable.");
                        return;
                    }
                    const parentId = await agents.parentOf(ctx, currentId);
                    if (parentId === null) return;
                    currentId = parentId;
                }
            },
            tools: (_toolCtx, scope) => [
                createSubtaskTool(this, scope.agent.id, scope.agent.provider),
            ],
            instructions: async (ctx, scope) => {
                if (this.isSubtask(await agents.config(ctx, scope.agent.id))) {
                    return "You are a subtask: a user-visible agent managed by your parent agent. The user may also talk to you directly. Coordinate through send_agent_message. You may create another subtask only within the two-level limit below your bot. Subtasks cannot be awaited; the user can archive them through the agent API.";
                }
                if ((await this.#bots.forAgent(ctx, scope.agent.id)) !== undefined) {
                    return "Use create_subtask to delegate a task the user may open and interact with. Subtasks can share your folder or use new workspaces in different projects. Coordinate with send_agent_message; do not wait for subtasks.";
                }
                return "";
            },
        };
    };

    async #assertCanCreate(ctx: Context, agentId: string): Promise<AgentConfig> {
        const agents = this.#requireAgents();
        const parent = await agents.config(ctx, agentId);
        if (parent === undefined)
            throw new SubtaskInputError("The subtask's parent was not found.");
        let currentId = agentId;
        // Only bot -> subtask -> subtask is legal; hidden intermediaries cannot extend it.
        for (let depth = 0; depth < 2; depth += 1) {
            const config = await agents.config(ctx, currentId);
            if (config === undefined || Value.Check(archivedMetadataSchema, config.metadata)) {
                throw new SubtaskInputError("An archived agent cannot create subtasks.");
            }
            if (
                Value.Check(workspaceSubtaskMetadataSchema, config.metadata) &&
                (await this.#workspaces.get(ctx, config.metadata.subtaskWorkspaceId))?.status !==
                    "ready"
            ) {
                throw new SubtaskInputError(
                    "The parent subtask's workspace must be active and ready.",
                );
            }
            const bot = await this.#bots.forAgent(ctx, currentId);
            if (bot !== undefined && bot.status === "active") return parent;
            if (!this.isSubtask(config))
                throw new SubtaskInputError("Only a bot or another subtask can create a subtask.");
            const ancestor = await agents.parentOf(ctx, currentId);
            if (ancestor === null) throw new SubtaskInputError("A subtask must belong to a bot.");
            currentId = ancestor;
        }
        throw new SubtaskInputError("Subtasks are limited to two levels below a bot.");
    }

    async #start(ctx: Context, request: SubtaskStart): Promise<void> {
        const agents = this.#requireAgents();
        // Read domain readiness, never another durable function's result. No caller lifetime is retained.
        const ready = await backoff(
            ctx,
            async (attemptCtx) => {
                const config = await agents.config(attemptCtx, request.agentId);
                if (config === undefined || Value.Check(archivedMetadataSchema, config.metadata))
                    return false;
                try {
                    await this.#assertCanCreate(attemptCtx, request.parentAgentId);
                } catch (error) {
                    if (error instanceof SubtaskInputError) return false;
                    throw error;
                }
                if (request.workspaceId === undefined) return true;
                const workspace = await this.#workspaces.get(attemptCtx, request.workspaceId);
                if (
                    workspace === undefined ||
                    workspace.status === "archived" ||
                    workspace.status === "archiving" ||
                    workspace.status === "failed"
                )
                    return false;
                if (workspace.status !== "ready")
                    throw new Error("The subtask workspace is still being prepared.");
                return true;
            },
            { initialDelay: 50, maxDelay: 1_000 },
        );
        if (!ready) return;
        await ctx.inTx(async (txCtx) => {
            const config = await agents.config(txCtx, request.agentId);
            if (config === undefined || Value.Check(archivedMetadataSchema, config.metadata))
                return;
            await this.#assertCanCreate(txCtx, request.parentAgentId);
            if (
                request.workspaceId !== undefined &&
                (await this.#workspaces.get(txCtx, request.workspaceId))?.status !== "ready"
            )
                return;
            const { workspace: _workspace, ...task } = request.input;
            await this.#collaboration.createAgent(
                txCtx,
                request.parentAgentId,
                task,
                request.agentId,
            );
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The subtasks module has not started.");
        return this.#agents;
    }
}
