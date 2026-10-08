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
import { ComputeModule } from "../compute/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import {
    archivedMetadataSchema,
    archiveSubtaskInputSchema,
    orderedSubtaskMetadataSchema,
    restoredMetadataSchema,
    versionedMetadataSchema,
    SUBTASK_ARCHIVE_FUNCTION,
    createSubtaskInputSchema,
    SUBTASK_START_FUNCTION,
    subtaskIdSchema,
    subtaskMetadataSchema,
    subtaskStartSchema,
    SubtaskInputError,
    workspaceSubtaskMetadataSchema,
    type CreateSubtaskInput,
    type ArchiveSubtaskInput,
    type SubtaskResult,
    type SubtaskStart,
} from "./Subtask.js";
import { subtaskOrderKeyBetween } from "./subtaskOrderKeyBetween.js";
import { createSubtaskTool } from "./tools/create_subtask.js";
import { archiveSubtaskTool } from "./tools/archive_subtask.js";

/** User-interactive delegation, with ordinary Agent Base ancestry and durable initial delivery. */
export class SubtasksModule implements AgentModule {
    readonly name = "subtasks";
    readonly #bots: BotsModule;
    readonly #abort: AbortModule;
    readonly #collaboration: CollaborationModule;
    readonly #compute: ComputeModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #workspaces: WorkspacesModule;
    #agents: AgentSystemRef | undefined;

    constructor(
        bots: BotsModule,
        collaboration: CollaborationModule,
        workspaces: WorkspacesModule,
        durableFunctions: DurableFunctionsModule,
        abort: AbortModule,
        compute: ComputeModule,
    ) {
        this.#bots = bots;
        this.#abort = abort;
        this.#compute = compute;
        this.#collaboration = collaboration;
        this.#workspaces = workspaces;
        this.#durableFunctions = durableFunctions;
        durableFunctions.register({
            name: SUBTASK_ARCHIVE_FUNCTION,
            argumentsSchema: archiveSubtaskInputSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await backoff(ctx, async (attemptCtx) => {
                    const config = await this.#requireAgents().config(
                        attemptCtx,
                        call.arguments.agentId,
                    );
                    if (Value.Check(archivedMetadataSchema, config?.metadata)) {
                        await this.#compute.archiveAgent(attemptCtx, call.arguments.agentId);
                    }
                });
                return null;
            },
        });
        durableFunctions.register({
            name: SUBTASK_START_FUNCTION,
            argumentsSchema: subtaskStartSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#start(ctx, call.arguments);
                return null;
            },
        });
        // A workspace-bound subtask and its workspace archive together, in one transaction. This
        // half covers every workspace archival, including descendants and project archival.
        workspaces.onEventTransactional(async (txCtx, event) => {
            if (event.type !== "workspace_updated" || event.change !== "begin_archive") return;
            const agentId = event.workspace.subtaskAgentId;
            if (agentId === undefined) return;
            const agents = this.#requireAgents();
            const config = await agents.config(txCtx, agentId);
            if (
                !Value.Check(workspaceSubtaskMetadataSchema, config?.metadata) ||
                config.metadata.subtaskWorkspaceId !== event.workspace.id ||
                Value.Check(archivedMetadataSchema, config.metadata)
            ) {
                return;
            }
            const now = Date.now();
            await this.#updateVersionedMetadata(txCtx, agentId, config, now, { archivedAt: now });
        });
    }

    isSubtask(config: AgentConfig | AgentModuleAgent | undefined): boolean {
        return Value.Check(subtaskMetadataSchema, config?.metadata);
    }

    /** The subtask's place among its siblings, or `null` for a non-subtask or an unordered one. */
    siblingOrderKey(config: AgentConfig | undefined): string | null {
        return Value.Check(orderedSubtaskMetadataSchema, config?.metadata)
            ? config.metadata.subtaskOrderKey
            : null;
    }

    /**
     * Sibling order: keyed subtasks by ascending key, then unkeyed ones newest first. A new
     * subtask is keyed before every sibling, so unreordered siblings keep newest-first order.
     */
    sortSiblings<Sibling extends { readonly id: string; readonly config: AgentConfig }>(
        siblings: readonly Sibling[],
    ): Sibling[] {
        return [...siblings].sort((a, b) => {
            const aKey = this.siblingOrderKey(a.config);
            const bKey = this.siblingOrderKey(b.config);
            if (aKey !== bKey) {
                if (aKey === null) return 1;
                if (bKey === null) return -1;
                return aKey < bKey ? -1 : 1;
            }
            // Equal keys, reachable when a restored subtask meets one moved onto its old key,
            // fall straight to the identifier; only unkeyed siblings use creation time.
            const byCreation =
                aKey === null
                    ? (b.config.provenance?.createdAt ?? 0) - (a.config.provenance?.createdAt ?? 0)
                    : 0;
            return byCreation || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
    }

    /**
     * Move an active subtask after an active sibling, or first for `null`. Returns whether the
     * order changed. Unkeyed or tied siblings are first keyed in their current order, so the
     * result is exactly the requested order; the parent records the move so it can publish
     * its new subtask list.
     */
    async reorder(ctx: Context, agentId: string, afterId: string | null): Promise<boolean> {
        if (
            !Value.Check(subtaskIdSchema, agentId) ||
            (afterId !== null && !Value.Check(subtaskIdSchema, afterId))
        ) {
            throw new SubtaskInputError("The subtask reorder request is invalid.");
        }
        const agents = this.#requireAgents();
        return await ctx.inTx(async (txCtx) => {
            const target = await agents.config(txCtx, agentId);
            if (!this.isSubtask(target) || Value.Check(archivedMetadataSchema, target?.metadata)) {
                throw new SubtaskInputError("Only an active subtask can be reordered.");
            }
            const parentAgentId = await agents.parentOf(txCtx, agentId);
            if (parentAgentId === null) {
                throw new SubtaskInputError("Only an active subtask can be reordered.");
            }
            const siblings = this.sortSiblings(
                (await this.#subtaskChildren(txCtx, parentAgentId)).filter(
                    (sibling) => !Value.Check(archivedMetadataSchema, sibling.config.metadata),
                ),
            );
            if (
                afterId !== null &&
                (afterId === agentId || !siblings.some((sibling) => sibling.id === afterId))
            ) {
                throw new SubtaskInputError(
                    "A subtask can only be placed after an active sibling subtask.",
                );
            }
            const others = siblings.filter((sibling) => sibling.id !== agentId);
            const insertAt =
                afterId === null ? 0 : others.findIndex((sibling) => sibling.id === afterId) + 1;
            const moved = [
                ...others.slice(0, insertAt),
                siblings.find((sibling) => sibling.id === agentId)!,
                ...others.slice(insertAt),
            ];
            if (moved.every((sibling, index) => sibling.id === siblings[index]?.id)) return false;

            const keys = new Map(
                siblings.map((sibling) => [sibling.id, this.siblingOrderKey(sibling.config)]),
            );
            const strictlyOrdered = siblings.every((sibling, index) => {
                const key = keys.get(sibling.id) ?? null;
                const previous = index === 0 ? "" : (keys.get(siblings[index - 1]!.id) ?? null);
                return key !== null && previous !== null && previous < key;
            });
            if (!strictlyOrdered) {
                let previous: string | null = null;
                for (const sibling of siblings) {
                    previous = subtaskOrderKeyBetween(previous, null);
                    keys.set(sibling.id, previous);
                }
            }
            const before = insertAt === 0 ? null : keys.get(moved[insertAt - 1]!.id)!;
            const after = insertAt + 1 < moved.length ? keys.get(moved[insertAt + 1]!.id)! : null;
            keys.set(agentId, subtaskOrderKeyBetween(before, after));

            const now = Date.now();
            for (const sibling of siblings) {
                const key = keys.get(sibling.id)!;
                if (key === this.siblingOrderKey(sibling.config)) continue;
                await this.#updateVersionedMetadata(txCtx, sibling.id, sibling.config, now, {
                    subtaskOrderKey: key,
                });
            }
            const parent = await agents.config(txCtx, parentAgentId);
            if (parent !== undefined) {
                await this.#updateVersionedMetadata(txCtx, parentAgentId, parent, now, {
                    subtasksOrderedAt: now,
                });
            }
            return true;
        });
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
            // Archived siblings keep their keys for restoration, so a new subtask goes before them too.
            const siblingKeys = (await this.#subtaskChildren(txCtx, parentAgentId))
                .map((sibling) => this.siblingOrderKey(sibling.config))
                .filter((key) => key !== null)
                .sort();
            const subtaskOrderKey = subtaskOrderKeyBetween(null, siblingKeys[0] ?? null);
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
                                  ...(workspace.runnerId === undefined
                                      ? {}
                                      : { runnerId: workspace.runnerId }),
                                  ...(workspace.dockerImage === undefined
                                      ? {}
                                      : { docker: { image: workspace.dockerImage } }),
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
                    subtaskOrderKey,
                    updatedAt: now,
                    version: 1,
                    ...(workspaceId === undefined ? {} : { subtaskWorkspaceId: workspaceId }),
                },
            };
            await agents.create(txCtx, config, { id: agentId, parent: parentAgentId });
            if (workspace !== undefined) {
                await this.#workspaces.attachSubtaskAgent(txCtx, workspace.id, agentId);
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

    async archive(
        ctx: Context,
        actingAgentId: string,
        agentId: string,
    ): Promise<ArchiveSubtaskInput> {
        if (
            !Value.Check(subtaskIdSchema, actingAgentId) ||
            !Value.Check(subtaskIdSchema, agentId)
        ) {
            throw new SubtaskInputError("The subtask archival request is invalid.");
        }
        const agents = this.#requireAgents();
        return await ctx.inTx(async (txCtx) => {
            const actor = await agents.config(txCtx, actingAgentId);
            const bot = await this.#bots.forAgent(txCtx, actingAgentId);
            const target = await agents.config(txCtx, agentId);
            if (
                actor === undefined ||
                Value.Check(archivedMetadataSchema, actor.metadata) ||
                (!this.isSubtask(actor) && bot?.status !== "active") ||
                !this.isSubtask(target) ||
                (await agents.parentOf(txCtx, agentId)) !== actingAgentId
            ) {
                throw new SubtaskInputError(
                    "Only a subtask's direct coordinating bot or subtask may archive it.",
                );
            }
            if (Value.Check(archivedMetadataSchema, target?.metadata)) return { agentId };
            const now = Date.now();
            const version = Value.Check(versionedMetadataSchema, target?.metadata)
                ? target.metadata.version
                : 1;
            await agents.updateMetadata(txCtx, agentId, {
                archivedAt: now,
                updatedAt: now,
                version: version + 1,
            });
            return { agentId };
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
                    await this.#durableFunctions.invoke(ctx, {
                        function: SUBTASK_ARCHIVE_FUNCTION,
                        arguments: { agentId: scope.agent.id },
                        operationId: `subtask-archive:${scope.agent.id}`,
                        lockKeys: [`subtask:${scope.agent.id}`],
                    });
                    // The other half of the pairing: the resident subtask takes its workspace
                    // with it. A shared-filesystem subtask names no workspace and archives none.
                    if (Value.Check(workspaceSubtaskMetadataSchema, change.metadata)) {
                        const workspace = await this.#workspaces.get(
                            ctx,
                            change.metadata.subtaskWorkspaceId,
                        );
                        if (
                            workspace?.subtaskAgentId === scope.agent.id &&
                            workspace.status !== "archiving" &&
                            workspace.status !== "archived"
                        ) {
                            await this.#workspaces.archive(ctx, workspace.id);
                        }
                    }
                } else if (
                    this.isSubtask(scope.agent) &&
                    Value.Check(restoredMetadataSchema, change.update) &&
                    Value.Check(archivedMetadataSchema, change.previousMetadata)
                ) {
                    // Archival is final for a subtask. Refusing here covers every path that
                    // clears archival, and rolls the whole restoration back.
                    throw new SubtaskInputError("An archived subtask cannot be restored.");
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
                archiveSubtaskTool(this, scope.agent.id),
            ],
            instructions: async (ctx, scope) => {
                if (this.isSubtask(await agents.config(ctx, scope.agent.id))) {
                    return "You are a user-visible subtask managed by your parent; users may talk to you directly. Keep your assigned work in this subtask and its workspace, and report progress, findings, diffs, and verification to your parent through send_agent_message. Prefer create_subtask by default only for substantial, distinct workstreams, such as changes across projects; handle small steps inline. Usually create second-level subtasks only on explicit user request. If the user explicitly asks for a subtask, use create_subtask within the two-level limit below your bot; explain if blocked. Use create_agent for internal research. Coordinate via send_agent_message and archive_subtask; do not wait for subtasks. Keep delegated work in the child subtask: ask its agent for progress, findings, diffs, verification, or follow-up changes instead of directly inspecting or modifying its files or running commands in its workspace. Direct access to another workspace often requires elevated permissions and review by the reviewer model; talking to its agent avoids unnecessary permission reviews. Archival stops the task and descendants and archives the task with its own workspace, if it has one; a shared folder stays. History is kept, but archival is final.";
                }
                if ((await this.#bots.forAgent(ctx, scope.agent.id)) !== undefined) {
                    return "Reserve subtasks for substantial, distinct workstreams, such as changes across projects; handle small steps inline. Usually create second-level subtasks only on explicit user request. Subtasks share your folder or use new project workspaces. Only bots and subtasks create them: at most two levels below a bot, not two siblings. Coordinate via send_agent_message and archive_subtask; do not wait. Keep delegated work in its subtask: ask its agent for progress, findings, diffs, verification, or follow-up changes instead of directly inspecting or modifying its files or running commands in its workspace. Direct access to another workspace often requires elevated permissions and review by the reviewer model; talking to its agent avoids unnecessary permission reviews. Archival stops the task and descendants and archives the task with its own workspace, if it has one; a shared folder stays. History is kept, but archival is final.";
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

    /** Every direct subtask child of one agent, archived ones included, read in this context. */
    async #subtaskChildren(
        ctx: Context,
        parentAgentId: string,
    ): Promise<{ readonly id: string; readonly config: AgentConfig }[]> {
        const agents = this.#requireAgents();
        const children: { readonly id: string; readonly config: AgentConfig }[] = [];
        for (const id of await agents.childOf(ctx, parentAgentId)) {
            const config = await agents.config(ctx, id);
            if (config !== undefined && this.isSubtask(config)) children.push({ id, config });
        }
        return children;
    }

    async #updateVersionedMetadata(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
        now: number,
        update: Record<string, unknown>,
    ): Promise<void> {
        const version = Value.Check(versionedMetadataSchema, config.metadata)
            ? config.metadata.version
            : 1;
        await this.#requireAgents().updateMetadata(ctx, agentId, {
            ...update,
            updatedAt: now,
            version: version + 1,
        });
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The subtasks module has not started.");
        return this.#agents;
    }
}
