import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabase,
    cuid2Schema,
    currentAgentEnvironment,
    type AgentKV,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { computePermissions } from "@slopus/happy-agent-compute";
import {
    createSurfaceRequestSchema,
    surfaceDocumentRevisionSchema,
    surfaceDocumentVersionSummarySchema,
    createTodoRequestSchema,
    surfaceSchema,
    surfaceMemberSchema,
    surfaceIdSchema,
    todoSchema,
    todoRevisionSchema,
    updateSurfaceRequestSchema,
    updateTodoRequestSchema,
    todoListScopeSchema,
    surfaceCreatedPayloadSchema,
    surfaceUpdatedPayloadSchema,
    todoCreatedPayloadSchema,
    todoUpdatedPayloadSchema,
    calendarEventCreatedPayloadSchema,
    calendarEventUpdatedPayloadSchema,
    resourceVersionSchema,
    type CalendarEvent,
    type CalendarEventRevision,
    type CalendarEventVersionListResponse,
    type CreateCalendarEventRequest,
    type UpdateCalendarEventRequest,
    type CreateSurfaceRequest,
    type CreateTodoRequest,
    type UpdateSurfaceRequest,
    type UpdateTodoRequest,
    type Surface,
    type SurfaceTarget,
    type SurfacePromptDocument,
    type Todo,
    type TodoRevision,
    type TodoListScope,
    type SurfaceDocumentChangeListResponse,
    type SurfaceDocumentRevision,
    type SurfaceDocumentStateResponse,
    type SurfaceDocumentVersionListResponse,
    type SystemMonitorSnapshot,
} from "@slopus/happy-agent-client";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, backoff, type Context } from "@steve.kite/stdlib";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { createUuidV7Factory } from "../utils/createUuidV7.js";
import { TeamModule } from "../team/index.js";
import { BotsModule } from "../bots/index.js";
import { TasksModule } from "../tasks/index.js";
import { ArtifactsModule } from "../artifacts/index.js";
import { ComputeModule } from "../compute/index.js";
import { ConfigModule } from "../config/index.js";
import type { RunnersModule } from "../runners/index.js";
import { apiResourceVersion } from "../utils/apiResourceVersion.js";
import { isUserOriginMetadata } from "../impl/messageOrigin.js";
import { SurfacesPersistence, surfacesMigrations } from "./persistence/SurfacesPersistence.js";
import {
    clearSurfaceLeave,
    queryAutomaticSurfaceIds,
    queryLastSurfaceOrderKey,
    saveSurfaceLeave,
} from "./persistence/surfaceAutomaticMembership.js";
import { SurfaceError } from "./SurfaceError.js";
import { compareStrings, surfaceOrderKey } from "./impl/surfaceOrderKey.js";
import {
    normalizeManagedImage,
    MAX_MANAGED_IMAGE_BYTES as MAX_SURFACE_IMAGE_BYTES,
} from "../impl/images/normalizeManagedImage.js";
import { surfaceImageAssetSchema, type SurfaceImageAsset } from "./SurfaceImageAsset.js";
import { surfaceReferenceSchema, type SurfaceReference } from "./SurfaceReference.js";
import { surfaceChatSchema, type SurfaceChat } from "./SurfaceChat.js";
import { formatSurfaceChatPrompt } from "./impl/formatSurfaceChatPrompt.js";
import { SURFACE_REFERENCE_INSTRUCTIONS } from "./impl/surfaceReferenceInstructions.js";
import { surfaceTools } from "./tools/surfaceTools.js";
import {
    SurfaceDocumentLive,
    type DocumentFrameListener,
} from "./documents/SurfaceDocumentLive.js";
import { SurfaceDocuments, type DocumentProjection } from "./documents/SurfaceDocuments.js";
import { SurfaceCalendars, type CalendarRange } from "./calendar/SurfaceCalendars.js";
import { SystemMonitorSampler } from "./systemMonitor/SystemMonitorSampler.js";
import { SurfacePromptDocuments } from "./promptDocuments/SurfacePromptDocuments.js";
import { formatPromptDocumentsInstructions } from "./promptDocuments/formatPromptDocumentsInstructions.js";
import type {
    MarkPromptDocumentInput,
    PromptDocument,
    PromptDocumentChange,
    PromptDocumentList,
} from "./promptDocuments/PromptDocument.js";

const eventSchema = Type.Union([
    Type.Object({ type: Type.Literal("surface.created"), payload: surfaceCreatedPayloadSchema }),
    Type.Object({ type: Type.Literal("surface.updated"), payload: surfaceUpdatedPayloadSchema }),
    Type.Object({ type: Type.Literal("todo.created"), payload: todoCreatedPayloadSchema }),
    Type.Object({ type: Type.Literal("todo.updated"), payload: todoUpdatedPayloadSchema }),
    Type.Object({
        type: Type.Literal("calendar_event.created"),
        payload: calendarEventCreatedPayloadSchema,
    }),
    Type.Object({
        type: Type.Literal("calendar_event.updated"),
        payload: calendarEventUpdatedPayloadSchema,
    }),
]);
export type SurfaceEvent = Static<typeof eventSchema>;
type Listener = (ctx: Context, event: SurfaceEvent) => void | Promise<void>;
export type SurfaceActor = TodoRevision["actor"];
/**
 * Types an earlier daemon stored that are no longer part of the catalog. Their rows stay in
 * storage unchanged, but no list, route, or event ever reaches them again.
 */
const WITHDRAWN_TYPES: ReadonlySet<string> = new Set(["separator"]);
/** Types whose content a shared conversation can work on. */
const CHAT_TYPES: ReadonlySet<string> = new Set([
    "todo",
    "document",
    "calendar",
    "system_monitor",
    "artifact",
    "bot",
    "task",
]);
const PREPARE_CHAT = "surfaces.prepareChat";
const DOCUMENT_CHANGED = "surfaces.documentChanged";
/** How long a person's request waits for a chat's folder and agent before reporting 503. */
const CHAT_READY_TIMEOUT_MS = 20_000;
/** The catalog manages chat folders; the agent sandbox does not apply to that work. */
const PRODUCT = computePermissions("full_access");
const documentHistoryCursorSchema = Type.String({
    minLength: 36,
    maxLength: 36,
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

/** Shared list instances. Every decision and revision commits under the database transaction lock. */
export class SurfacesModule implements AgentModule {
    readonly name = "surfaces";
    readonly migrations = surfacesMigrations;
    readonly #listeners = new Set<Listener>();
    readonly #transactional = new Set<Listener>();
    readonly #documentChanged = new Set<
        (ctx: Context, surfaceId: string) => Promise<void> | void
    >();
    readonly #chatWaiters = new Map<string, Set<() => void>>();
    readonly #live = new SurfaceDocumentLive();
    #store!: SurfacesPersistence;
    #kv!: AgentKV;
    #documents!: SurfaceDocuments;
    #calendars!: SurfaceCalendars;
    readonly #promptDocuments = new SurfacePromptDocuments((ctx, surfaceId) =>
        this.get(ctx, surfaceId),
    );
    #systemMonitor!: SystemMonitorSampler;
    #agents: AgentSystemRef | undefined;
    constructor(
        readonly durable: DurableFunctionsModule,
        readonly team: TeamModule,
        readonly bots: BotsModule,
        readonly tasks: TasksModule,
        readonly artifacts: ArtifactsModule,
        readonly compute: ComputeModule,
        readonly config: ConfigModule,
        readonly runners: RunnersModule,
    ) {
        durable.register({
            name: "surfaces.notify",
            argumentsSchema: eventSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                for (const listener of this.#listeners) await listener(ctx, call.arguments);
                return null;
            },
        });
        // Folder preparation belongs to the daemon's lifetime and survives a restart; the
        // association commits only once the folder exists.
        durable.register({
            name: PREPARE_CHAT,
            argumentsSchema: Type.Object({ surfaceId: surfaceIdSchema }),
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#prepareChat(ctx, call.arguments.surfaceId);
                return null;
            },
        });
        durable.register({
            name: DOCUMENT_CHANGED,
            argumentsSchema: Type.Object({ surfaceId: surfaceIdSchema }),
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                for (const listener of this.#documentChanged)
                    await listener(ctx, call.arguments.surfaceId);
                return null;
            },
        });
    }
    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#systemMonitor = new SystemMonitorSampler(ctx);
        this.#store = new SurfacesPersistence(agentDatabase(ctx)!);
        this.#kv = this.#store.kv();
        this.#documents = new SurfaceDocuments(this.#store, this.#kv, this.#live);
        this.#calendars = new SurfaceCalendars(this.#store, this.#kv, (eventCtx, event) =>
            this.#event(eventCtx, event),
        );
        this.#agents = agents;
        return {
            instructions: async (hookCtx, scope) => {
                const chat = await this.chatForAgent(hookCtx, scope.agent.id);
                const important = formatPromptDocumentsInstructions(
                    await this.promptDocuments(hookCtx),
                );
                return [
                    chat === undefined
                        ? undefined
                        : formatSurfaceChatPrompt(await this.#surface(hookCtx, chat.surfaceId)),
                    SURFACE_REFERENCE_INSTRUCTIONS,
                    important,
                ]
                    .filter((part) => part !== undefined && part.length > 0)
                    .join("\n\n");
            },
            tools: async (toolCtx, scope) =>
                surfaceTools(this, scope, await this.isAdmin(toolCtx, scope.agent.id)),
            messageAcceptedTransact: async (hookCtx, scope, accepted) => {
                if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata))
                    return;
                const owner = accepted.metadata?.["userId"];
                await scope.kv.write(
                    hookCtx,
                    "owner",
                    Value.Check(cuid2Schema, owner) ? owner : null,
                );
            },
        };
    };
    onEvent(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
    onEventTransactional(listener: Listener): () => void {
        this.#transactional.add(listener);
        return () => {
            this.#transactional.delete(listener);
        };
    }
    /** Internal durable notification, independent of editor streams and the public API journal. */
    onDocumentChanged(
        listener: (ctx: Context, surfaceId: string) => Promise<void> | void,
    ): () => void {
        this.#documentChanged.add(listener);
        return () => {
            this.#documentChanged.delete(listener);
        };
    }
    /**
     * The installation's important documents as every agent's instructions list them, oldest
     * mark first. A marked Surface that is missing or no longer a document is left out.
     */
    async promptDocuments(ctx: Context): Promise<readonly PromptDocument[]> {
        return ctx.inTx(async (tx) =>
            (await this.#promptDocuments.list(tx)).filter((document) => document.readable),
        );
    }
    /** A document's important-document entry, or null when it is not marked. */
    async promptDocumentEntry(
        ctx: Context,
        surfaceId: string,
    ): Promise<SurfacePromptDocument | null> {
        checked(surfaceIdSchema, surfaceId);
        return ctx.inTx((tx) => this.#promptDocuments.entry(tx, surfaceId));
    }
    /** Every marked document, for an admin bot, including any agents can no longer read. */
    async listPromptDocuments(ctx: Context, agentId: string): Promise<PromptDocumentList> {
        return ctx.inTx(async (tx) => {
            await this.requirePromptDocumentsAdmin(tx, agentId);
            return { documents: await this.#promptDocuments.list(tx) };
        });
    }
    /** Mark a document Surface as important for every agent; only active admin bots may. */
    async markPromptDocument(
        ctx: Context,
        agentId: string,
        input: MarkPromptDocumentInput,
    ): Promise<PromptDocumentChange> {
        return ctx.inTx(async (tx) => {
            await this.requirePromptDocumentsAdmin(tx, agentId);
            return this.#promptDocuments.mark(tx, agentId, input);
        });
    }
    /** Stop listing a document as important; only active admin bots may. */
    async unmarkPromptDocument(
        ctx: Context,
        agentId: string,
        surfaceId: string,
    ): Promise<PromptDocumentChange> {
        checked(surfaceIdSchema, surfaceId);
        return ctx.inTx(async (tx) => {
            await this.requirePromptDocumentsAdmin(tx, agentId);
            return this.#promptDocuments.unmark(tx, surfaceId);
        });
    }
    async requirePromptDocumentsAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.isAdmin(ctx, agentId)))
            throw new SurfaceError(
                "forbidden",
                "Only an active admin bot can change this installation's important documents.",
            );
    }
    async owner(ctx: Context): Promise<string | null> {
        if (!this.team.enabled) return null;
        const owner = await this.team.currentUser(ctx);
        if (owner === undefined)
            throw new SurfaceError("forbidden", "Sign in and complete your profile first.");
        return owner.id;
    }
    async actor(ctx: Context, agentId: string, kv: AgentKV): Promise<SurfaceActor> {
        const owner = await kv.read(ctx, "owner");
        return {
            agentId,
            userId: this.team.enabled && Value.Check(cuid2Schema, owner) ? owner : null,
        };
    }
    async isAdmin(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }
    async requireAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.isAdmin(ctx, agentId)))
            throw new SurfaceError(
                "forbidden",
                "Only an active admin bot can manage Surfaces or their users.",
            );
    }
    async shouldElevateImage(ctx: Context, agentId: string, path?: string): Promise<boolean> {
        if (path === undefined) return false;
        const compute = await this.compute.resolve(ctx, agentId);
        return (
            compute === undefined ||
            (await this.compute.shouldReviewPath(ctx, compute, path, { write: false }))
        );
    }
    /** Reads through the agent's own filesystem boundary; callers check their own authority. */
    async imageFromPath(ctx: Context, agentId: string, path: string): Promise<string> {
        const compute = await this.compute.resolve(ctx, agentId);
        if (compute === undefined)
            throw new SurfaceError("invalid_request", "The agent filesystem is unavailable.");
        const permissions = this.compute.permissionsForContext(ctx);
        const facts = await compute.fs.stat(permissions, path);
        if (!facts.isFile || facts.size > MAX_SURFACE_IMAGE_BYTES)
            throw new SurfaceError(
                "invalid_request",
                "The Surface image must be a file no larger than 8 MiB.",
            );
        return Buffer.from(
            await compute.fs.readFileBuffer(permissions, path, {
                maxBytes: MAX_SURFACE_IMAGE_BYTES,
            }),
        ).toString("base64");
    }
    /** The catalog as its caller sees it, with each reference target resolved for that caller. */
    async list(ctx: Context): Promise<Surface[]> {
        return ctx.inTx(async (tx) =>
            Promise.all((await this.#stored(tx)).map((surface) => this.#present(tx, surface))),
        );
    }
    /**
     * One Surface of the catalog as `list` presents it, or undefined when the catalog has none
     * with this ID, including a malformed ID or a withdrawn type.
     */
    async get(ctx: Context, surfaceId: string): Promise<Surface | undefined> {
        if (!Value.Check(surfaceIdSchema, surfaceId)) return undefined;
        return ctx.inTx(async (tx) => {
            try {
                return await this.#present(tx, await this.#surface(tx, surfaceId));
            } catch (error) {
                if (error instanceof SurfaceError && error.code === "not_found") return undefined;
                throw error;
            }
        });
    }
    /** Whether this supported feature currently holds useful shared content. */
    async hasContent(ctx: Context, surfaceId: string): Promise<boolean> {
        return ctx.inTx(async (tx) => {
            const surface = await this.#surface(tx, surfaceId);
            switch (surface.type) {
                case "todo":
                    return this.#store.hasTodoContent(tx, surfaceId);
                case "document":
                    return (
                        (await this.#documents.projection(tx, surface)).document.text.trim()
                            .length > 0
                    );
                case "calendar":
                    return this.#store.hasCalendarContent(tx, surfaceId);
                default:
                    return false;
            }
        });
    }
    async create(
        ctx: Context,
        request: CreateSurfaceRequest,
        creatorUserId: string | null,
        adminAgentId?: string,
        actor?: SurfaceActor,
    ): Promise<Surface> {
        const input = checked(createSurfaceRequestSchema, request);
        const reference = referenceFor(input);
        if (reference !== undefined) checked(surfaceReferenceSchema, reference);
        const image = input.image === undefined ? null : await normalizedImage(input.image.data);
        return ctx.inTx(async (tx) => {
            if (adminAgentId !== undefined) await this.requireAdmin(tx, adminAgentId);
            await this.#validateUser(tx, creatorUserId);
            const id = input.id ?? createId();
            const old = await this.#kv.read(tx, `surface.${id}`);
            if (old !== undefined) return this.#present(tx, await this.#surface(tx, id));
            if (
                reference !== undefined &&
                (await this.#resolve(tx, reference)).state === "unavailable"
            )
                throw new SurfaceError("not_found", "The referenced item was not found.");
            const now = Date.now();
            const surface = {
                id,
                type: input.type,
                name: input.name,
                creatorUserId,
                chatAgentId: null,
                image: image === null ? null : { thumbhash: image.thumbhash },
                members:
                    this.team.enabled && creatorUserId === null
                        ? []
                        : [
                              {
                                  userId: creatorUserId,
                                  joinedAt: now,
                                  orderKey: await this.#memberTail(tx, creatorUserId),
                              },
                          ],
                updatedAt: now,
                version: createUuidV7Factory()(),
            } satisfies Surface;
            await this.#kv.write(tx, `surface.${id}`, surface);
            if (image !== null) await this.#kv.write(tx, `image.${id}`, image);
            if (reference !== undefined) await this.#kv.write(tx, `reference.${id}`, reference);
            if (input.type === "document")
                await this.#documents.create(
                    tx,
                    surface,
                    input.text,
                    actor ?? { userId: await this.owner(tx), agentId: adminAgentId ?? null },
                    input.mutationId ?? null,
                );
            await this.#event(tx, {
                type: "surface.created",
                payload: { surface, ...echo(input.mutationId) },
            });
            // Transactional participation may have added members after the creation snapshot.
            return this.#present(tx, await this.#surface(tx, id));
        });
    }
    /**
     * Record the intent to give this Surface its shared chat. Identities and the folder path are
     * reserved once, so every retry and restart resumes the same ones; the durable preparation
     * runs after the caller's transaction commits. An existing chat is returned unchanged.
     */
    async requestChat(ctx: Context, id: string, mutationId?: string): Promise<Surface> {
        return ctx.inTx(async (tx) => {
            const surface = await this.#surface(tx, id);
            if (!CHAT_TYPES.has(surface.type))
                throw new SurfaceError("conflict", "This kind of Surface has no chat.");
            if (surface.chatAgentId != null) return this.#present(tx, surface);
            if ((await this.#kv.read(tx, `chat.${id}`)) === undefined) {
                const runnerId = this.runners.enabled ? this.runners.defaultRunnerId : undefined;
                const chat: SurfaceChat = {
                    surfaceId: id,
                    agentId: createId(),
                    workspaceId: createId(),
                    path: this.#chatPath(runnerId, id),
                    ...(runnerId === undefined ? {} : { runnerId }),
                    ...(mutationId === undefined ? {} : { mutationId }),
                    reservedAt: Date.now(),
                };
                await this.#kv.write(tx, `chat.${id}`, chat);
            }
            await this.durable.invoke(tx, {
                function: PREPARE_CHAT,
                arguments: { surfaceId: id },
                operationId: `${PREPARE_CHAT}.${id}`,
                lockKeys: [`${PREPARE_CHAT}.${id}`],
            });
            return this.#present(tx, surface);
        });
    }
    /** Wait, bounded, for a requested chat to commit. The caller owns only this wait. */
    async awaitChat(ctx: Context, id: string): Promise<{ surface: Surface; chat: SurfaceChat }> {
        const deadline = Date.now() + CHAT_READY_TIMEOUT_MS;
        for (;;) {
            let wake!: () => void;
            const woken = new Promise<void>((resolve) => (wake = resolve));
            const waiters = this.#chatWaiters.get(id) ?? new Set();
            waiters.add(wake);
            this.#chatWaiters.set(id, waiters);
            try {
                const ready = await ctx.inTx(async (tx) => {
                    const surface = await this.#surface(tx, id);
                    if (surface.chatAgentId == null) return undefined;
                    return {
                        surface: await this.#present(tx, surface),
                        chat: checked(surfaceChatSchema, await this.#kv.read(tx, `chat.${id}`)),
                    };
                });
                if (ready !== undefined) return ready;
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    throw new SurfaceError(
                        "not_initialized",
                        "The Surface chat is still being prepared. Try again shortly.",
                    );
                let timer: NodeJS.Timeout | undefined;
                await Promise.race([
                    woken,
                    new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining))),
                ]);
                clearTimeout(timer);
            } finally {
                waiters.delete(wake);
                if (waiters.size === 0) this.#chatWaiters.delete(id);
            }
        }
    }
    /** The committed chat whose agent this is, if any. Reservations alone are never reported. */
    async chatForAgent(ctx: Context, agentId: string): Promise<SurfaceChat | undefined> {
        return this.#chatBy(ctx, `chat-agent.${agentId}`);
    }
    /** The committed chat whose dedicated workspace this is, if any. */
    async chatForWorkspace(ctx: Context, workspaceId: string): Promise<SurfaceChat | undefined> {
        return this.#chatBy(ctx, `chat-workspace.${workspaceId}`);
    }
    async image(ctx: Context, id: string): Promise<SurfaceImageAsset> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, id);
            const image = await this.#kv.read(tx, `image.${id}`);
            if (image === undefined)
                throw new SurfaceError("not_found", "This Surface has no image.");
            return checked(surfaceImageAssetSchema, image);
        });
    }
    /**
     * Rename a Surface or replace or remove its image. The image is normalized before the
     * transaction; values equal to the stored ones change nothing, and an edit that changes
     * nothing is an exact no-op. `settle` runs in the same transaction, so a durable tool commits
     * its result atomically with the edit.
     */
    async update(
        ctx: Context,
        id: string,
        request: UpdateSurfaceRequest,
        settle: (tx: Context, surface: Surface) => Promise<Surface> = async (_tx, surface) =>
            surface,
    ): Promise<Surface> {
        const input = checked(updateSurfaceRequestSchema, request);
        const image =
            input.image === undefined || input.image === null
                ? input.image
                : await normalizedImage(input.image.data);
        return ctx.inTx(async (tx) => {
            const current = await this.#surface(tx, id);
            const changes: Partial<Pick<Surface, "name" | "image">> = {};
            if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
            if (image === null && current.image !== null) changes.image = null;
            if (image != null) {
                const stored = await this.#kv.read(tx, `image.${id}`);
                if (!Value.Check(surfaceImageAssetSchema, stored) || stored.etag !== image.etag)
                    changes.image = { thumbhash: image.thumbhash };
            }
            if (Object.keys(changes).length === 0)
                return settle(tx, await this.#present(tx, current));
            const surface = {
                ...current,
                ...changes,
                updatedAt: Date.now(),
                version: createUuidV7Factory(Date.now, current.version)(),
            };
            await this.#kv.write(tx, `surface.${id}`, surface);
            if (changes.image === null) await this.#kv.delete(tx, `image.${id}`);
            else if (changes.image !== undefined) await this.#kv.write(tx, `image.${id}`, image);
            await this.#event(tx, {
                type: "surface.updated",
                payload: {
                    surfaceId: id,
                    previousVersion: current.version,
                    version: surface.version,
                    changes: { members: surface.members, updatedAt: surface.updatedAt, ...changes },
                    ...echo(input.mutationId),
                },
            });
            return settle(tx, await this.#present(tx, surface));
        });
    }
    /** One bounded batch; callers own the preference policy and repeated catch-up. */
    async joinAutomatically(ctx: Context, userId: string, surfaceId?: string): Promise<number> {
        if (!this.team.enabled) return 0;
        return ctx.inTx(async (tx) => {
            await this.#validateUser(tx, userId);
            const ids = await queryAutomaticSurfaceIds(tx, userId, surfaceId);
            for (const id of ids) await this.changeMember(tx, id, userId, "join");
            return ids.length;
        });
    }
    async changeMember(
        ctx: Context,
        id: string,
        userId: string | null,
        action: "join" | "leave" | "reorder",
        afterId: string | null = null,
        mutationId?: string,
    ): Promise<Surface> {
        return ctx.inTx(async (tx) => {
            await this.#validateUser(tx, userId);
            if (this.team.enabled && userId === null)
                throw new SurfaceError("not_found", "The Surface user was not found.");
            const current = await this.#surface(tx, id);
            if (this.team.enabled && userId !== null) {
                if (action === "join") await clearSurfaceLeave(tx, userId, id);
                else if (action === "leave") await saveSurfaceLeave(tx, userId, id);
            }
            const member = current.members.find((m) => m.userId === userId);
            if (
                (action === "join" && member !== undefined) ||
                (action === "leave" && member === undefined)
            )
                return this.#present(tx, current);
            let members = [...current.members];
            if (action === "join")
                members.push({
                    userId,
                    joinedAt: Date.now(),
                    orderKey: await this.#memberTail(tx, userId),
                });
            else if (action === "leave") members = members.filter((m) => m.userId !== userId);
            else {
                if (member === undefined)
                    throw new SurfaceError("conflict", "Join this Surface before reordering it.");
                const own = (await this.#stored(tx))
                    .flatMap((s) =>
                        s.members
                            .filter((m) => m.userId === userId)
                            .map((m) => ({ id: s.id, orderKey: m.orderKey })),
                    )
                    .sort(byOrder);
                const key = reorderedKey(own, id, afterId);
                if (key === undefined) return this.#present(tx, current);
                members = members.map((m) => (m.userId === userId ? { ...m, orderKey: key } : m));
            }
            members.sort((a, b) => compareStrings(a.userId ?? "", b.userId ?? ""));
            const surface = {
                ...current,
                members,
                updatedAt: Date.now(),
                version: createUuidV7Factory(Date.now, current.version)(),
            };
            await this.#kv.write(tx, `surface.${id}`, surface);
            await this.#event(tx, {
                type: "surface.updated",
                payload: {
                    surfaceId: id,
                    previousVersion: current.version,
                    version: surface.version,
                    changes: { members, updatedAt: surface.updatedAt },
                    ...echo(mutationId),
                },
            });
            return this.#present(tx, surface);
        });
    }
    async listTodos(
        ctx: Context,
        surfaceId: string,
        scope: TodoListScope = "active",
    ): Promise<Todo[]> {
        checked(todoListScopeSchema, scope);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "todo");
            const todos = (await this.#kv.list(tx, `todo.${surfaceId}.`))
                .map((row) => readTodo(row.value))
                .filter((t) => scope === "all" || t.status === scope);
            return todos.sort((a, b) => {
                const rank = { active: 0, completed: 1, deleted: 2 };
                if (a.status !== b.status) return rank[a.status] - rank[b.status];
                if (a.status === "active" && b.status === "active") return byOrder(a, b);
                return (
                    (b.deletedAt ?? b.completedAt ?? 0) - (a.deletedAt ?? a.completedAt ?? 0) ||
                    compareStrings(a.id, b.id)
                );
            });
        });
    }
    async getTodo(ctx: Context, surfaceId: string, id: string): Promise<Todo> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "todo");
            checked(cuid2Schema, id);
            const todo = await this.#kv.read(tx, `todo.${surfaceId}.${id}`);
            if (todo === undefined)
                throw new SurfaceError("not_found", "The todo was not found in this Surface.");
            return readTodo(todo);
        });
    }
    async createTodo(
        ctx: Context,
        surfaceId: string,
        input: CreateTodoRequest,
        actor: SurfaceActor,
        authorUserId: string | null,
    ): Promise<Todo> {
        checked(createTodoRequestSchema, input);
        if (input.id !== undefined) checked(cuid2Schema, input.id);
        return ctx.inTx(async (tx) => {
            await this.#validateUser(tx, authorUserId);
            await this.#surface(tx, surfaceId, "todo");
            const id = input.id ?? createId();
            const old = await this.#kv.read(tx, `todo.${surfaceId}.${id}`);
            if (old !== undefined) return readTodo(old);
            const now = Date.now();
            const todo: Todo = {
                id,
                surfaceId,
                text: input.text,
                authorUserId,
                status: "active",
                orderKey: surfaceOrderKey(
                    null,
                    (await this.listTodos(tx, surfaceId))[0]?.orderKey ?? null,
                ),
                createdAt: now,
                updatedAt: now,
                completedAt: null,
                deletedAt: null,
                version: createUuidV7Factory()(),
            };
            await this.#saveTodo(tx, todo, actor);
            await this.#event(tx, {
                type: "todo.created",
                payload: { todo, ...echo(input.mutationId) },
            });
            return todo;
        });
    }
    async mutateTodo(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
        operation: "update" | "reorder" | "delete",
        input: UpdateTodoRequest | { afterId: string | null } | {},
        actor: SurfaceActor,
        mutationId?: string,
    ): Promise<Todo> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            const current = await this.getTodo(tx, surfaceId, id);
            if (current.version !== version)
                throw new SurfaceError("conflict", "The todo has changed.", { todo: current });
            let candidate = { ...current } as Todo;
            if (operation === "update") {
                const edit = checked(updateTodoRequestSchema, input);
                if (edit.text !== undefined) candidate.text = edit.text;
                if (edit.status !== undefined && edit.status !== current.status) {
                    if (edit.status === "active")
                        candidate = {
                            ...candidate,
                            status: "active",
                            completedAt: null,
                            deletedAt: null,
                            orderKey: await this.#todoTail(tx, surfaceId),
                        };
                    else if (edit.status === "completed")
                        candidate = {
                            ...candidate,
                            status: "completed",
                            completedAt: Date.now(),
                            deletedAt: null,
                            orderKey: null,
                        };
                    else
                        candidate = {
                            ...candidate,
                            status: "deleted",
                            deletedAt: Date.now(),
                            orderKey: null,
                        };
                }
            } else if (operation === "delete" && current.status !== "deleted")
                candidate = {
                    ...current,
                    status: "deleted",
                    deletedAt: Date.now(),
                    orderKey: null,
                };
            else if (operation === "reorder") {
                if (current.status !== "active")
                    throw new SurfaceError("conflict", "Only active todos can be reordered.", {
                        todo: current,
                    });
                const { afterId } = checked(
                    Type.Object({ afterId: Type.Union([cuid2Schema, Type.Null()]) }),
                    input,
                );
                try {
                    const key = reorderedKey(
                        (await this.listTodos(tx, surfaceId, "active")) as (Todo & {
                            orderKey: string;
                        })[],
                        id,
                        afterId,
                    );
                    if (key !== undefined) candidate = { ...current, orderKey: key };
                } catch (error) {
                    if (error instanceof SurfaceError)
                        throw new SurfaceError(error.code, error.message, { todo: current });
                    throw error;
                }
            }
            if (JSON.stringify(candidate) === JSON.stringify(current)) return current;
            const todo = checked(todoSchema, {
                ...candidate,
                updatedAt: Date.now(),
                version: createUuidV7Factory(Date.now, current.version)(),
            });
            await this.#saveTodo(tx, todo, actor);
            await this.#event(tx, {
                type: "todo.updated",
                payload: {
                    surfaceId,
                    todoId: id,
                    previousVersion: current.version,
                    version: todo.version,
                    changes: {
                        text: todo.text,
                        status: todo.status,
                        orderKey: todo.orderKey,
                        completedAt: todo.completedAt,
                        deletedAt: todo.deletedAt,
                        updatedAt: todo.updatedAt,
                    },
                    ...echo(mutationId),
                },
            });
            return todo;
        });
    }
    async versions(
        ctx: Context,
        surfaceId: string,
        id: string,
        afterVersion?: string,
        limit = 100,
    ) {
        checked(Type.Integer({ minimum: 1, maximum: 200 }), limit);
        return ctx.inTx(async (tx) => {
            await this.getTodo(tx, surfaceId, id);
            if (afterVersion !== undefined) await this.getVersion(tx, surfaceId, id, afterVersion);
            const rows = (
                await this.#store.queryPage(
                    tx,
                    `revision.${surfaceId}.${id}.`,
                    afterVersion ?? "",
                    limit + 1,
                )
            ).map(readRevision);
            const versions = rows.slice(0, limit);
            return {
                versions,
                nextAfterVersion: rows.length > limit ? versions.at(-1)!.todo.version : null,
            };
        });
    }
    async getVersion(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
    ): Promise<TodoRevision> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            await this.getTodo(tx, surfaceId, id);
            const row = await this.#kv.read(tx, `revision.${surfaceId}.${id}.${version}`);
            if (row === undefined)
                throw new SurfaceError("not_found", "The todo revision was not found.");
            return readRevision(row);
        });
    }
    /** Occurrences overlapping `[from, to)`, expanded by the daemon, with their events. */
    async listCalendar(
        ctx: Context,
        surfaceId: string,
        range: { from: number; to: number; timeZone: string },
        maxOccurrences?: number,
    ): Promise<CalendarRange> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "calendar");
            return this.#calendars.range(
                tx,
                surfaceId,
                range.from,
                range.to,
                range.timeZone,
                maxOccurrences,
            );
        });
    }
    /** Validate the caller's catalog snapshot, then wait outside the database lock for telemetry. */
    async systemMonitor(ctx: Context, surfaceId: string): Promise<SystemMonitorSnapshot> {
        await this.#surfaceOf(ctx, surfaceId, "system_monitor");
        return this.#systemMonitor.read();
    }
    async getCalendarEvent(ctx: Context, surfaceId: string, id: string): Promise<CalendarEvent> {
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "calendar");
            checked(cuid2Schema, id);
            return this.#calendars.get(tx, surfaceId, id);
        });
    }
    async createCalendarEvent(
        ctx: Context,
        surfaceId: string,
        input: CreateCalendarEventRequest,
        actor: SurfaceActor,
        authorUserId: string | null,
    ): Promise<CalendarEvent> {
        if (input.id !== undefined) checked(cuid2Schema, input.id);
        return ctx.inTx(async (tx) => {
            await this.#validateUser(tx, authorUserId);
            await this.#surface(tx, surfaceId, "calendar");
            return this.#calendars.create(
                tx,
                surfaceId,
                input.id ?? createId(),
                input,
                actor,
                authorUserId,
            );
        });
    }
    /** Change or delete a whole series; `version` must be the one the caller read. */
    async mutateCalendarEvent(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
        edit: UpdateCalendarEventRequest | "delete",
        actor: SurfaceActor,
        mutationId?: string,
    ): Promise<CalendarEvent> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "calendar");
            checked(cuid2Schema, id);
            return this.#calendars.mutate(tx, surfaceId, id, version, edit, actor, mutationId);
        });
    }
    async calendarEventVersions(
        ctx: Context,
        surfaceId: string,
        id: string,
        afterVersion?: string,
        limit = 100,
    ): Promise<CalendarEventVersionListResponse> {
        checked(Type.Integer({ minimum: 1, maximum: 200 }), limit);
        if (afterVersion !== undefined) checked(resourceVersionSchema, afterVersion);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "calendar");
            checked(cuid2Schema, id);
            return this.#calendars.versions(tx, surfaceId, id, afterVersion, limit);
        });
    }
    async getCalendarEventVersion(
        ctx: Context,
        surfaceId: string,
        id: string,
        version: string,
    ): Promise<CalendarEventRevision> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "calendar");
            checked(cuid2Schema, id);
            return this.#calendars.version(tx, surfaceId, id, version);
        });
    }
    /** The document's Markdown projection, current or as of `seq`. */
    async document(ctx: Context, surfaceId: string, seq?: number): Promise<DocumentProjection> {
        return ctx.inTx(async (tx) =>
            this.#documents.projection(tx, await this.#surface(tx, surfaceId, "document"), seq),
        );
    }
    async documentState(
        ctx: Context,
        surfaceId: string,
        query: { stateVector?: string; seq?: number },
    ): Promise<SurfaceDocumentStateResponse> {
        return ctx.inTx(async (tx) =>
            this.#documents.state(tx, await this.#surface(tx, surfaceId, "document"), query),
        );
    }
    /** Store one person's or agent's Yjs change; changes merge, so no version guard applies. */
    async changeDocument(
        ctx: Context,
        surfaceId: string,
        update: string,
        actor: SurfaceActor,
        mutationId: string | null,
    ): Promise<{ seq: number }> {
        return ctx.inTx(async (tx) => {
            const surface = await this.#surface(tx, surfaceId, "document");
            const { seq, appended } = await this.#documents.change(
                tx,
                surface,
                new Uint8Array(Buffer.from(update, "base64")),
                actor,
                mutationId,
            );
            if (appended) await this.#notifyDocumentChanged(tx, surfaceId);
            return { seq };
        });
    }
    /** Apply an agent's Markdown, written against version `seq`, as the difference from it. */
    async changeDocumentFromMarkdown(
        ctx: Context,
        surfaceId: string,
        seq: number,
        text: string,
        actor: SurfaceActor,
    ): Promise<DocumentProjection & { changed: boolean }> {
        return ctx.inTx(async (tx) => {
            const surface = await this.#surface(tx, surfaceId, "document");
            const result = await this.#documents.agentChange(tx, surface, seq, text, actor);
            if (result.appended) await this.#notifyDocumentChanged(tx, surfaceId);
            return {
                ...(await this.#documents.projection(tx, surface)),
                changed: result.appended,
            };
        });
    }
    async documentChanges(
        ctx: Context,
        surfaceId: string,
        afterSeq = 0,
        limit = 100,
    ): Promise<SurfaceDocumentChangeListResponse> {
        checked(Type.Integer({ minimum: 1, maximum: 200 }), limit);
        return ctx.inTx(async (tx) =>
            this.#documents.entries(
                tx,
                await this.#surface(tx, surfaceId, "document"),
                afterSeq,
                limit,
            ),
        );
    }
    /**
     * Follow a document's changes and presence on one event stream. The subscription exists
     * before the current `seq` is read, so no change committed after that read is missed.
     */
    async subscribeDocument(
        ctx: Context,
        surfaceId: string,
        streamId: string,
    ): Promise<{ seq: number }> {
        await this.#surfaceOf(ctx, surfaceId, "document");
        const added = !this.#live.isSubscribed(surfaceId, streamId);
        this.#live.subscribe(surfaceId, streamId);
        try {
            const seq = await ctx.inTx(
                async (tx) =>
                    (await this.#documents.head(tx, await this.#surface(tx, surfaceId, "document")))
                        .seq,
            );
            if (added) this.#live.sendPresence(surfaceId, streamId);
            return { seq };
        } catch (error) {
            if (added) this.#live.unsubscribe(surfaceId, streamId);
            throw error;
        }
    }
    async unsubscribeDocument(ctx: Context, surfaceId: string, streamId: string): Promise<void> {
        await this.#surfaceOf(ctx, surfaceId, "document");
        this.#live.unsubscribe(surfaceId, streamId);
    }
    /** Relay presence, never stored, to the document's other subscribed streams. */
    async shareDocumentPresence(
        ctx: Context,
        surfaceId: string,
        streamId: string,
        awarenessClientId: number,
        update: string,
    ): Promise<void> {
        await this.#surfaceOf(ctx, surfaceId, "document");
        this.#live.presence(surfaceId, streamId, awarenessClientId, update);
    }
    /** A closed event stream ends its subscriptions, and its presence with them. */
    closeDocumentStream(streamId: string): void {
        this.#live.closeStream(streamId);
    }
    /** Receive live frames addressed to individual event streams. */
    onDocumentFrame(listener: DocumentFrameListener): () => void {
        return this.#live.onFrame(listener);
    }
    async documentVersions(
        ctx: Context,
        surfaceId: string,
        afterVersion?: string,
        limit = 100,
    ): Promise<SurfaceDocumentVersionListResponse> {
        checked(Type.Integer({ minimum: 1, maximum: 200 }), limit);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "document");
            if (afterVersion !== undefined) {
                checked(documentHistoryCursorSchema, afterVersion);
                if (
                    (await this.#kv.read(tx, `document-summary.${surfaceId}.${afterVersion}`)) ===
                    undefined
                )
                    throw new SurfaceError("not_found", "The document revision was not found.");
            }
            const rows = (
                await this.#store.queryPage(
                    tx,
                    `document-summary.${surfaceId}.`,
                    afterVersion ?? "",
                    limit + 1,
                )
            ).map((row) => checked(surfaceDocumentVersionSummarySchema, row));
            const versions = rows.slice(0, limit);
            return {
                versions,
                nextAfterVersion: rows.length > limit ? versions.at(-1)!.version : null,
            };
        });
    }
    async getDocumentVersion(
        ctx: Context,
        surfaceId: string,
        version: string,
    ): Promise<SurfaceDocumentRevision> {
        checked(resourceVersionSchema, version);
        return ctx.inTx(async (tx) => {
            await this.#surface(tx, surfaceId, "document");
            const revision = await this.#kv.read(tx, `document-revision.${surfaceId}.${version}`);
            if (revision === undefined)
                throw new SurfaceError("not_found", "The document revision was not found.");
            return checked(surfaceDocumentRevisionSchema, revision);
        });
    }
    async #chatBy(ctx: Context, key: string): Promise<SurfaceChat | undefined> {
        const surfaceId = await this.#kv.read(ctx, key);
        if (surfaceId === undefined) return undefined;
        return checked(surfaceChatSchema, await this.#kv.read(ctx, `chat.${String(surfaceId)}`));
    }
    #chatPath(runnerId: string | undefined, surfaceId: string): string {
        if (runnerId === undefined) {
            const local = this.runners.machineHome(undefined);
            return local === undefined
                ? this.config.surfacePath(surfaceId)
                : this.config.surfacePathOn(local.home, local.platform, surfaceId);
        }
        const home = this.runners.home(runnerId);
        if (home === undefined)
            throw new SurfaceError(
                "not_initialized",
                `The runner ${this.runners.displayName(runnerId)} has never connected, so it has nowhere to put a Surface chat folder yet.`,
            );
        return this.config.surfacePathOn(
            home,
            this.runners.platform(runnerId) ?? "linux",
            surfaceId,
        );
    }
    /**
     * Make the reserved folder, then create the agent and name it on the Surface in one
     * transaction. A folder left by an interrupted attempt is taken up again; an association that
     * already exists makes this a no-op, so concurrent requests and restarts converge.
     */
    async #prepareChat(ctx: Context, id: string): Promise<void> {
        const reserved = await this.#kv.read(ctx, `chat.${id}`);
        if (reserved === undefined) return;
        const chat = checked(surfaceChatSchema, reserved);
        if ((await this.#surface(ctx, id)).chatAgentId != null) return;
        await backoff(
            ctx,
            async () => {
                const machine = await this.runners.machine(chat.runnerId);
                await machine.fs.mkdir(PRODUCT, chat.path, { recursive: true });
            },
            { timeout: 5 * 60_000 },
        );
        await ctx.inTx(async (tx) => {
            const current = await this.#surface(tx, id);
            if (current.chatAgentId != null) return;
            const now = Date.now();
            await this.#requireAgents().create(
                tx,
                {
                    provenance: { createdAt: now },
                    environment: { ...currentAgentEnvironment(), workingDirectory: chat.path },
                    metadata: { title: current.name, updatedAt: now, version: 1 },
                    modules: {
                        compute: {
                            cwd: chat.path,
                            ...(chat.runnerId === undefined ? {} : { runnerId: chat.runnerId }),
                            secretScope: { workspaceId: chat.workspaceId },
                        },
                    },
                },
                { id: chat.agentId, parent: null },
            );
            await this.#kv.write(tx, `chat-agent.${chat.agentId}`, id);
            await this.#kv.write(tx, `chat-workspace.${chat.workspaceId}`, id);
            const surface: Surface = {
                ...current,
                chatAgentId: chat.agentId,
                updatedAt: now,
                version: createUuidV7Factory(Date.now, current.version)(),
            };
            await this.#kv.write(tx, `surface.${id}`, surface);
            await this.#event(tx, {
                type: "surface.updated",
                payload: {
                    surfaceId: id,
                    previousVersion: current.version,
                    version: surface.version,
                    changes: {
                        members: current.members,
                        updatedAt: now,
                        chatAgentId: chat.agentId,
                    },
                    ...echo(chat.mutationId),
                },
            });
            afterCommit(tx, () => {
                for (const wake of this.#chatWaiters.get(id) ?? []) wake();
            });
        });
    }
    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("Surfaces have not started.");
        return this.#agents;
    }
    async #stored(ctx: Context): Promise<Surface[]> {
        return (await this.#kv.list(ctx, "surface."))
            .map((row) => readSurface(row.value))
            .filter((surface) => !WITHDRAWN_TYPES.has(surface.type));
    }
    /**
     * Shared records never hold a target projection or a document's important-document entry;
     * both are resolved for each read.
     */
    async #present(ctx: Context, surface: Surface): Promise<Surface> {
        if (surface.type === "document")
            return {
                ...surface,
                promptDocument: await this.#promptDocuments.entry(ctx, surface.id),
            };
        if (!isReferenceType(surface.type)) return surface;
        const stored = await this.#kv.read(ctx, `reference.${surface.id}`);
        return {
            ...surface,
            target: Value.Check(surfaceReferenceSchema, stored)
                ? await this.#resolve(ctx, stored)
                : { type: surface.type, state: "unavailable" },
        };
    }
    /**
     * Every authenticated person may read every bot, task, and artifact, so availability is the
     * target's own lifecycle. Unavailable projections never carry the target's identity.
     */
    async #resolve(ctx: Context, reference: SurfaceReference): Promise<SurfaceTarget> {
        if (reference.type === "artifact") {
            const artifact = await this.artifacts.get(ctx, reference.artifactId);
            if (artifact === undefined || artifact.status !== "active")
                return { type: "artifact", state: "unavailable" };
            return {
                type: "artifact",
                state: "available",
                artifactId: artifact.id,
                name: artifact.title,
                hasImage: artifact.type === "image" || artifact.type === "image_series",
                version: apiResourceVersion(artifact.updatedAt, artifact.revision, artifact.id),
            };
        }
        if (reference.type === "bot") {
            const bot = await this.bots.get(ctx, reference.botId);
            if (bot === undefined || bot.status !== "active")
                return { type: "bot", state: "unavailable" };
            return {
                type: "bot",
                state: "available",
                botId: bot.id,
                name: bot.name,
                hasImage: bot.avatar !== undefined,
                version: apiResourceVersion(bot.updatedAt, bot.version, bot.id),
            };
        }
        const task = await this.tasks.get(ctx, reference.taskId);
        if (task === undefined || task.status !== "active")
            return { type: "task", state: "unavailable" };
        return {
            type: "task",
            state: "available",
            taskId: task.id,
            name: task.name,
            hasImage: false,
            version: apiResourceVersion(task.updatedAt, task.version, task.id),
        };
    }
    async #surfaceOf(ctx: Context, id: string, type?: Surface["type"]): Promise<Surface> {
        return ctx.inTx((tx) => this.#surface(tx, id, type));
    }
    async #surface(ctx: Context, id: string, type?: Surface["type"]): Promise<Surface> {
        checked(surfaceIdSchema, id);
        const value = await this.#kv.read(ctx, `surface.${id}`);
        if (value === undefined) throw new SurfaceError("not_found", "The Surface was not found.");
        const surface = readSurface(value);
        if (WITHDRAWN_TYPES.has(surface.type) || (type !== undefined && surface.type !== type))
            throw new SurfaceError("not_found", "The Surface was not found.");
        return surface;
    }
    async #validateUser(ctx: Context, userId: string | null): Promise<void> {
        checked(surfaceMemberSchema.properties.userId, userId);
        if (userId === null) return;
        if (!this.team.enabled)
            throw new SurfaceError("invalid_request", "Standalone Surfaces use the local person.");
        const target = await this.team.getUser(ctx, userId);
        if (target === undefined || target.authentication === "guest")
            throw new SurfaceError("not_found", "The Surface user was not found.");
    }
    async #memberTail(ctx: Context, userId: string | null): Promise<string> {
        return surfaceOrderKey((await queryLastSurfaceOrderKey(ctx, userId)) ?? null, null);
    }
    async #todoTail(ctx: Context, surfaceId: string): Promise<string> {
        return surfaceOrderKey(
            (await this.listTodos(ctx, surfaceId)).at(-1)?.orderKey ?? null,
            null,
        );
    }
    async #saveTodo(ctx: Context, todo: Todo, actor: SurfaceActor): Promise<void> {
        const revision = checked(todoRevisionSchema, {
            todo,
            actor,
            source: actor.agentId === null ? "api" : "tool",
        });
        if (
            !(await this.#store.writeValueIfAbsent(
                ctx,
                `revision.${todo.surfaceId}.${todo.id}.${todo.version}`,
                revision,
            ))
        )
            throw new Error("A todo revision cannot be overwritten.");
        await this.#kv.write(ctx, `todo.${todo.surfaceId}.${todo.id}`, todo);
    }
    async #event(ctx: Context, event: SurfaceEvent): Promise<void> {
        // Reserve the initiating event before transactional listeners enqueue derived changes.
        await this.durable.invoke(ctx, {
            function: "surfaces.notify",
            arguments: event,
            lockKeys: ["surfaces.notify"],
        });
        for (const listener of this.#transactional) await listener(ctx, structuredClone(event));
    }
    async #notifyDocumentChanged(ctx: Context, surfaceId: string): Promise<void> {
        await this.durable.invoke(ctx, {
            function: DOCUMENT_CHANGED,
            arguments: { surfaceId },
            lockKeys: [DOCUMENT_CHANGED],
        });
    }
}

/** Older snapshots have no attribution; reads never infer it or rewrite stored history. */
function readSurface(value: unknown): Surface {
    const surface = checked(surfaceSchema, value);
    return {
        ...surface,
        creatorUserId: surface.creatorUserId ?? null,
        chatAgentId: surface.chatAgentId ?? null,
    };
}
function readTodo(value: unknown): Todo {
    const todo = checked(todoSchema, value);
    return { ...todo, authorUserId: todo.authorUserId ?? null };
}
function readRevision(value: unknown): TodoRevision {
    const revision = checked(todoRevisionSchema, value);
    return {
        ...revision,
        todo: { ...revision.todo, authorUserId: revision.todo.authorUserId ?? null },
    };
}
function isReferenceType(type: string): type is SurfaceReference["type"] {
    return type === "artifact" || type === "bot" || type === "task";
}
function referenceFor(input: CreateSurfaceRequest): SurfaceReference | undefined {
    if (input.type === "artifact") return { type: "artifact", artifactId: input.artifactId };
    if (input.type === "bot") return { type: "bot", botId: input.botId };
    if (input.type === "task") return { type: "task", taskId: input.taskId };
    return undefined;
}
/** One managed normalization for every Surface image, mapped to the Surface's own error. */
async function normalizedImage(data: string): Promise<SurfaceImageAsset> {
    try {
        const normalized = await normalizeManagedImage(Buffer.from(data, "base64"));
        return {
            data: Buffer.from(normalized.bytes).toString("base64"),
            etag: normalized.etag,
            thumbhash: normalized.thumbhash,
        };
    } catch (error) {
        throw new SurfaceError(
            "invalid_request",
            error instanceof Error ? error.message : "The Surface image is invalid.",
        );
    }
}
function echo(mutationId?: string) {
    return mutationId === undefined ? {} : { mutationId };
}
function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
    if (!Value.Check(schema, value))
        throw new SurfaceError(
            "invalid_request",
            "The Surface request or stored value is invalid.",
        );
    return value as Static<S>;
}
function byOrder(a: { orderKey: string; id: string }, b: { orderKey: string; id: string }) {
    return compareStrings(a.orderKey, b.orderKey) || compareStrings(a.id, b.id);
}
function reorderedKey(
    items: { id: string; orderKey: string }[],
    id: string,
    afterId: string | null,
): string | undefined {
    if (afterId === id || (afterId !== null && !items.some((i) => i.id === afterId)))
        throw new SurfaceError(
            "conflict",
            "The ordering anchor must be a different active item in this list.",
        );
    const index = items.findIndex((i) => i.id === id);
    if ((items[index - 1]?.id ?? null) === afterId) return undefined;
    const others = items.filter((i) => i.id !== id);
    const anchor = afterId === null ? -1 : others.findIndex((i) => i.id === afterId);
    return surfaceOrderKey(others[anchor]?.orderKey ?? null, others[anchor + 1]?.orderKey ?? null);
}
