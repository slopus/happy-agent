import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentDatabase,
    agentPermissionModeSchema,
    currentAgentEnvironment,
    withAgentDatabase,
    type AgentBaseMessageOptions,
    type AgentConfig,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { AgentEvent, EventsModuleListener } from "../events/index.js";
import { EventsModule } from "../events/index.js";
import { HistoryModule } from "../history/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { ProjectsModule } from "../projects/index.js";
import { SchedulingModule } from "../scheduling/index.js";
import { UserInputModule, type UserInputRequest } from "../userInput/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { ConfigModule } from "../config/index.js";
import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";
import { afterCommit, detach, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { importHappyCredentials } from "./credentials/importHappyCredentials.js";
import type { HappySpawnOperations } from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import { HappyMachineClient } from "./HappyMachineClient.js";
import type {
    HappyInboundMessage,
    HappyModel,
    HappySessionSnapshot,
    HappySpawnRequest,
} from "./HappySession.js";
import { HappySessionClient, type HappySessionOperations } from "./HappySessionClient.js";
import { createHappySyncDatabase, happySyncMigrations } from "./HappySyncDatabase.js";
import { HappyMessageMapper } from "./mapHappyMessages.js";
import { resolveHappyUserInputAnswers } from "./resolveHappyUserInputAnswers.js";

/** How many agents one daemon keeps connected to Happy at once. */
const MAX_CONNECTED_AGENTS = 64;

const happySelectionSchema = Type.Object(
    {
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        permissionMode: agentPermissionModeSchema,
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

const acceptedEventPayloadSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 256 }),
        kind: Type.String({ minLength: 1, maxLength: 256 }),
        runId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: true },
);

type HappySelection = Static<typeof happySelectionSchema>;

interface HappySelectionModel {
    readonly effortLevels: readonly string[];
    readonly id: string;
    readonly providerId: string;
}

const happyMetadataSchema = Type.Object(
    { happy: happySelectionSchema },
    { additionalProperties: true },
);

interface ConnectedAgent {
    readonly client: HappySessionClient;
    readonly mapper: HappyMessageMapper;
}

/**
 * The connection between this daemon and Happy, the mobile app.
 *
 * Happy speaks directly in Agent Base identities: a Happy session ID is its agent ID. It keeps no
 * second conversation catalog. Project and workspace ownership stays in those catalogs, while the
 * agent configuration is the durable source for its working directory and selected model.
 */
export class HappyModule
    implements AgentModule<AnyAgentTool>, HappySessionOperations, HappySpawnOperations
{
    readonly name = "happy";
    readonly migrations = happySyncMigrations;
    readonly #agents = new Map<string, ConnectedAgent>();
    readonly #config: ConfigModule;
    readonly #history: HistoryModule;
    readonly #scheduling: SchedulingModule;
    readonly #projects: ProjectsModule;
    readonly #userInput: UserInputModule;
    readonly #workspaces: WorkspacesModule;
    readonly #sync = createHappySyncDatabase();
    #agentSystem: AgentSystemRef<LibSQLDatabase> | undefined;
    #configuration: HappyConnectionConfiguration | undefined;
    #context: Context | undefined;
    #fingerprint = "";
    #machine: HappyMachineClient | undefined;

    constructor(
        config: ConfigModule,
        events: EventsModule,
        history: HistoryModule,
        projects: ProjectsModule,
        scheduling: SchedulingModule,
        userInput: UserInputModule,
        workspaces: WorkspacesModule,
    ) {
        this.#config = config;
        this.#history = history;
        this.#projects = projects;
        this.#scheduling = scheduling;
        this.#userInput = userInput;
        this.#workspaces = workspaces;
        // The journal must know who projects it from the moment it records anything.
        events.observe(this.#eventsListener);
    }

    /** Projects every durable agent event into Happy's outbox. */
    readonly #eventsListener: EventsModuleListener = {
        onEvent: (_ctx: Context, event: AgentEvent): void => {
            if (event.agentId === undefined) return;
            this.#agents.get(event.agentId)?.client.kick();
        },
        onEventTransactional: async (ctx: Context, event: AgentEvent): Promise<void> => {
            if (this.#configuration === undefined || event.agentId === undefined) return;
            const attached = await this.#attach(ctx, event.agentId);
            if (attached === undefined) return;
            const accepted =
                event.type !== "message.accepted" ||
                !Value.Check(acceptedEventPayloadSchema, event.payload)
                    ? undefined
                    : await this.#history.message(ctx, event.agentId, event.payload.id);
            await this.#sync.projectEvent(ctx, {
                agentId: event.agentId,
                eventId: event.id,
                messages: attached.mapper.map(event, accepted).map((message) => ({
                    localId: message.localId,
                    payload: message,
                })),
                now: Date.now(),
            });
        },
    };

    readonly beforeStart = (
        ctx: Context,
        agents: AgentSystemRef<LibSQLDatabase>,
    ): AgentModuleHooks => {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Happy was started without an agent database.");
        }
        this.#context = withAgentDatabase(detach(ctx).named("happy"), database);
        this.#agentSystem = agents;
        return { afterStart: async (startedCtx) => await this.#connect(startedCtx) };
    };

    async #connect(ctx: Context): Promise<void> {
        const context = this.#context;
        if (context === undefined) return;
        if (!this.#config.configuration.values.settings.happyIntegration) {
            ctx.log.debug("Happy synchronization is turned off in the configuration.");
            return;
        }
        const configuration = await importHappyCredentials({
            dataDirectory: this.#config.configuration.paths.agentHome,
        });
        if (configuration === undefined) {
            ctx.log.debug("Happy is not connected on this machine.");
            return;
        }
        this.#configuration = configuration;
        this.#fingerprint = fingerprint(configuration);
        if (configuration.machineId === undefined) {
            ctx.log.debug("Happy has no machine identity for this computer.");
            return;
        }
        this.#machine = new HappyMachineClient({
            configuration,
            context,
            models: () => this.models(),
            operations: this,
            remoteSessionId: async (agentId) =>
                (await this.#sync.readSession(context, agentId))?.remoteSessionId,
            version: this.#config.configuration.version,
        });
        this.#machine.start();
    }

    /** Stops talking to Happy, which the daemon does as it shuts down. */
    async stop(): Promise<void> {
        this.#machine?.close();
        this.#machine = undefined;
        const agents = [...this.#agents.values()];
        this.#agents.clear();
        await Promise.all(agents.map(async (agent) => await agent.client.close()));
    }

    /** Sends everything owed and waits for it, which is what a shutdown and a test need. */
    async settle(): Promise<void> {
        await Promise.all(
            [...this.#agents.values()].map(async (agent) => await agent.client.settle()),
        );
    }

    /** Every model the phone may offer, across providers. */
    models(): readonly HappyModel[] {
        return this.#system().models.map((model) => ({
            defaultEffort: model.defaultEffort,
            effortLevels: [...model.effortLevels],
            id: model.id,
            name: model.name,
            providerId: model.providerId,
            serviceTiers: model.serviceTiers === undefined ? [] : [...model.serviceTiers],
        }));
    }

    /** One agent as Happy needs to describe it, or nothing when it is gone. */
    async session(ctx: Context, agentId: string): Promise<HappySessionSnapshot | undefined> {
        const config = await this.#system().config(ctx, agentId);
        if (config === undefined) return undefined;
        return this.#snapshot(agentId, config);
    }

    /** Delivers what a person said on the phone, and what they chose to say it with. */
    async submit(ctx: Context, agentId: string, message: HappyInboundMessage): Promise<void> {
        const system = this.#system();
        const config = await system.config(ctx, agentId);
        if (config === undefined) {
            throw new Error(`No agent exists for Happy session "${agentId}".`);
        }
        const current = selectionFromConfig(config, this.#defaultSelection());
        const next = checkedSelection(system.models, {
            effort: message.selection.effort ?? current.effort,
            modelId: message.selection.modelId ?? current.modelId,
            permissionMode: message.selection.permissionMode ?? current.permissionMode,
            providerId: message.selection.providerId ?? current.providerId,
        });
        const messageOptions = messageOptionsFor(next);
        try {
            await system.send(ctx, agentId, messageFrom(message), {
                ...messageOptions,
                metadata: {
                    ...messageOptions.metadata,
                    happy: { remoteMessageId: message.remoteMessageId },
                },
            });
        } catch (cause) {
            throw new Error("Agent Base rejected the phone's message.", { cause });
        }
        this.#scheduling.interruptWaits(ctx, agentId);
        await system.updateMetadata(ctx, agentId, { happy: next });
    }

    /** Stops whatever the agent is doing. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        await this.#system().abort(ctx, agentId);
    }

    /**
     * Ends this phone's view of an agent.
     *
     * Agents are never deleted or archived: a later message may resume one. Closing the remote
     * projection therefore only detaches the Happy client after stopping the active work.
     */
    async archiveSession(ctx: Context, agentId: string): Promise<void> {
        await this.abort(ctx, agentId);
        await this.#detach(ctx, agentId);
    }

    /** The questions this agent is waiting on right now. */
    async pendingQuestions(ctx: Context, agentId: string): Promise<readonly UserInputRequest[]> {
        return await this.#userInput.list(ctx, agentId, { status: "pending" });
    }

    /** Records what a person answered on the phone. */
    async answerQuestion(
        ctx: Context,
        agentId: string,
        requestId: string,
        answers: Record<string, unknown>,
    ): Promise<void> {
        const pending = await this.#userInput.list(ctx, agentId, { status: "pending" });
        const request = pending.find((candidate) => candidate.id === requestId);
        if (request === undefined) {
            throw new Error(`Question "${requestId}" is no longer waiting for an answer.`);
        }
        await this.#userInput.answer(ctx, agentId, resolveHappyUserInputAnswers(request, answers));
    }

    /** Dismisses a question the person chose not to answer. */
    async cancelQuestion(ctx: Context, agentId: string, requestId: string): Promise<void> {
        await this.#userInput.cancel(ctx, agentId, {
            reason: "Dismissed from the phone.",
            requestId,
        });
    }

    /**
     * Starts an agent in a directory the phone named.
     *
     * The requested session ID is the agent ID. It is deterministic across retried Happy RPCs,
     * making the Agent Base identity itself the durable idempotency key.
     */
    async spawnSession(ctx: Context, request: HappySpawnRequest): Promise<{ agentId: string }> {
        const system = this.#system();
        const existing = await system.config(ctx, request.sessionId);
        if (existing !== undefined) return { agentId: request.sessionId };

        const owner = await this.#workspaces.resolvePath(ctx, request.cwd);
        const cwd = owner.workspace?.path ?? owner.project.repositoryRef;
        const selection = checkedSelection(system.models, {
            effort: request.effort,
            modelId: request.modelId,
            permissionMode: request.permissionMode,
            providerId: request.providerId,
        });
        await system.create(ctx, agentConfigFor(cwd, selection), { id: request.sessionId });
        if (owner.workspace === undefined) {
            await this.#projects.attachAgent(ctx, owner.project.id, request.sessionId);
        } else {
            await this.#workspaces.attachAgent(ctx, owner.workspace.id, request.sessionId);
        }
        await this.#attach(ctx, request.sessionId);
        return { agentId: request.sessionId };
    }

    async #attach(ctx: Context, agentId: string): Promise<ConnectedAgent | undefined> {
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;
        const configuration = this.#configuration;
        const context = this.#context;
        if (configuration === undefined || context === undefined) return undefined;
        if (this.#agents.size >= MAX_CONNECTED_AGENTS) return undefined;
        const session = await this.session(ctx, agentId);
        if (session === undefined) return undefined;
        await this.#sync.ensureSession(
            ctx,
            {
                agentId,
                credentialFingerprint: this.#fingerprint,
                encryptionKeyBase64: this.#sessionKey(),
                encryptionVariant: configuration.credentials.encryption.type,
                sessionId: session.sessionId,
            },
            Date.now(),
        );
        const attached: ConnectedAgent = {
            client: new HappySessionClient({
                agentId,
                configuration,
                context,
                operations: this,
                sessionId: session.sessionId,
                sync: this.#sync,
                version: this.#config.configuration.version,
            }),
            mapper: new HappyMessageMapper(),
        };
        this.#agents.set(agentId, attached);
        afterCommit(ctx, () => {
            attached.client.start();
        });
        return attached;
    }

    async #detach(ctx: Context, agentId: string): Promise<void> {
        const attached = this.#agents.get(agentId);
        this.#agents.delete(agentId);
        if (attached === undefined) return;
        afterCommit(ctx, () => {
            void attached.client.archive();
        });
    }

    /** One session, described in the terms Happy publishes it. */
    #snapshot(agentId: string, config: AgentConfig): HappySessionSnapshot {
        const cwd = config.environment?.workingDirectory;
        if (cwd === undefined) {
            throw new Error(`Agent "${agentId}" has no working directory.`);
        }
        const selection = selectionFromConfig(config, this.#defaultSelection());
        return {
            agentId,
            archived: false,
            cwd,
            effort: selection.effort,
            modelId: selection.modelId,
            permissionMode: selection.permissionMode,
            projectName: basename(cwd) || cwd,
            providerId: selection.providerId,
            sessionId: agentId,
            status: "idle",
            title:
                typeof config.metadata?.title === "string"
                    ? config.metadata.title
                    : "Untitled session",
            tools: [],
            // Agent Base deliberately does not expose active state through AgentSystemRef.
            working: false,
        };
    }

    #defaultSelection(): HappySelection {
        const model = this.#system().models[0];
        if (model === undefined) {
            throw new Error("Happy cannot start a session without an available model.");
        }
        return {
            effort: model.defaultEffort,
            modelId: model.id,
            permissionMode: this.#config.configuration.values.defaults.permissionMode,
            providerId: model.providerId,
        };
    }

    #system(): AgentSystemRef<LibSQLDatabase> {
        if (this.#agentSystem === undefined) {
            throw new Error("Happy was asked to act before its agents had started.");
        }
        return this.#agentSystem;
    }

    #sessionKey(): string {
        const encryption = this.#configuration?.credentials.encryption;
        if (encryption?.type === "legacy") {
            return Buffer.from(encryption.secret).toString("base64");
        }
        return randomBytes(32).toString("base64");
    }
}

function agentConfigFor(cwd: string, selection: HappySelection): AgentConfig {
    return {
        environment: { ...currentAgentEnvironment(), workingDirectory: cwd },
        metadata: { happy: selection },
        modules: { compute: { cwd, providerId: "host" } },
    };
}

function checkedSelection(
    models: readonly HappySelectionModel[],
    selection: HappySelection,
): HappySelection {
    if (!Value.Check(happySelectionSchema, selection)) {
        throw new Error("The Happy model selection is invalid.");
    }
    const model = models.find(
        (candidate) =>
            candidate.id === selection.modelId && candidate.providerId === selection.providerId,
    );
    if (model === undefined) {
        throw new Error("That model is not available in this Happy Agent.");
    }
    if (!model.effortLevels.includes(selection.effort)) {
        throw new Error("That reasoning level is not available for this model.");
    }
    return selection;
}

function fingerprint(configuration: HappyConnectionConfiguration): string {
    return createHash("sha256")
        .update(configuration.credentials.token)
        .update("\0")
        .update(configuration.serverUrl)
        .digest("hex")
        .slice(0, 32);
}

function messageFrom(message: HappyInboundMessage): SessionUserMessage {
    const content: SessionInputBlock[] = [];
    if (message.text.length > 0 || message.images.length === 0) {
        content.push({ text: message.text, type: "text" });
    }
    for (const image of message.images) {
        content.push({ data: image.data, mimeType: image.mimeType, type: "image" });
    }
    return { content, role: "user" };
}

function messageOptionsFor(selection: HappySelection): AgentBaseMessageOptions {
    return {
        effort: selection.effort as never,
        metadata: {
            ...USER_MESSAGE_ORIGIN_METADATA,
            // The composer selection this message runs with, stamped the way the API
            // stamps its own sends so history shows the phone's mode too.
            mode: {
                effort: selection.effort,
                modelId: selection.modelId,
                permissionMode: selection.permissionMode,
                providerId: selection.providerId,
                serviceTier: null,
            },
        },
        model: selection.modelId,
        permissionMode: selection.permissionMode,
        provider: selection.providerId,
    };
}

function selectionFromConfig(config: AgentConfig, fallback: HappySelection): HappySelection {
    const metadata = config.metadata;
    if (!Value.Check(happyMetadataSchema, metadata)) return fallback;
    return metadata.happy;
}
