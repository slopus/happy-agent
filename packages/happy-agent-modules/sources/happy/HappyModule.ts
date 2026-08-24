import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { HappyIntegration, HappyIntegrationError } from "@slopus/happy-agent-client";
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
import { ComputeModule } from "../compute/index.js";
import { EventsModule } from "../events/index.js";
import { GitModule, type GitChangeSnapshot, type GitTrackedEntity } from "../git/index.js";
import { HistoryModule } from "../history/index.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { ProjectsModule, type Project } from "../projects/index.js";
import { ProviderUsageModule } from "../providerUsage/index.js";
import { SchedulingModule } from "../scheduling/index.js";
import { UserInputModule, type UserInputRequest } from "../userInput/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { ConfigModule } from "../config/index.js";
import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";
import { afterCommit, detach, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import {
    importHappyCredentials,
    inspectDaemonHappyCredentials,
    readExternalHappyCredentialFingerprint,
} from "./credentials/importHappyCredentials.js";
import { getHappyPaths } from "./credentials/getHappyPaths.js";
import {
    resolveHappyConnectionTarget,
    type HappyConnectionTarget,
} from "./credentials/resolveHappyConnectionTarget.js";
import { saveHappyPairingCredentials } from "./credentials/saveHappyPairingCredentials.js";
import { createHappyIntegrationVersion } from "./createHappyIntegrationVersion.js";
import {
    createHappyIntegrationDatabase,
    happyIntegrationMigrations,
} from "./HappyIntegrationDatabase.js";
import type {
    HappySpawnOperations,
    HappySpawnResult,
    HappySpawnStartResult,
} from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import { HappyMachineClient, type HappyMachineConnectionEvent } from "./HappyMachineClient.js";
import { HappyPairing, HappyPairingError } from "./HappyPairing.js";
import { HappyProjectClient } from "./HappyProjectClient.js";
import {
    HappyMessageRefused,
    type HappyInboundMessage,
    type HappyModel,
    type HappySessionSnapshot,
    type HappySpawnRequest,
} from "./HappySession.js";
import { HappySessionClient, type HappySessionOperations } from "./HappySessionClient.js";
import { createHappySyncDatabase, happySyncMigrations } from "./HappySyncDatabase.js";
import {
    createHappyProjectSyncDatabase,
    happyProjectSyncMigrations,
} from "./HappyProjectSyncDatabase.js";
import { HappyMessageMapper } from "./mapHappyMessages.js";
import { resolveHappyUserInputAnswers } from "./resolveHappyUserInputAnswers.js";

/** How many agents one daemon keeps connected to Happy at once. */
const MAX_CONNECTED_AGENTS = 64;

/** How many archived messages a newly attached Happy session receives as its initial context. */
const HAPPY_BACKFILL_MESSAGES = 50;

/** Terminal RPC answers remembered for fast retries during one daemon lifetime. */
const MAX_SERVED_SPAWN_RESULTS = 1_024;

/** Old projections inspected on restart so an archive event missed while offline still converges. */
const MAX_REAPED_SYNC_SESSIONS = 4_096;

/** Keeps Happy-owned Git subscriptions inside GitModule's bounded lease. */
const GIT_TRACK_RENEWAL_MS = 60_000;

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
type WithoutIntegrationSnapshotFields<Value> = Value extends unknown
    ? Omit<Value, "updatedAt" | "version">
    : never;
type HappyIntegrationValue = WithoutIntegrationSnapshotFields<HappyIntegration>;

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

export type HappyIntegrationListener = (
    ctx: Context,
    integration: HappyIntegration,
) => Promise<void> | void;

export class HappyIntegrationStartError extends Error {
    readonly code: "happy_unavailable" | "unsupported";
    readonly integration: HappyIntegration;

    constructor(
        code: "happy_unavailable" | "unsupported",
        message: string,
        integration: HappyIntegration,
    ) {
        super(message);
        this.name = "HappyIntegrationStartError";
        this.code = code;
        this.integration = integration;
    }
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
    readonly migrations = [
        ...happySyncMigrations,
        ...happyIntegrationMigrations,
        ...happyProjectSyncMigrations,
    ];
    readonly #agents = new Map<string, ConnectedAgent>();
    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;
    readonly #events: EventsModule;
    readonly #git: GitModule;
    readonly #history: HistoryModule;
    readonly #scheduling: SchedulingModule;
    readonly #projects: ProjectsModule;
    readonly #providerUsage: ProviderUsageModule;
    readonly #userInput: UserInputModule;
    readonly #workspaces: WorkspacesModule;
    readonly #sync = createHappySyncDatabase();
    readonly #projectSync = createHappyProjectSyncDatabase();
    readonly #integrationDatabase = createHappyIntegrationDatabase();
    readonly #integrationListeners = new Set<HappyIntegrationListener>();
    readonly #served = new Map<string, HappySpawnResult>();
    readonly #tasks = new Set<Promise<void>>();
    readonly #archivingAgents = new Set<string>();
    readonly #retiredAgents = new Set<string>();
    readonly #gitEntityByAgent = new Map<string, GitTrackedEntity>();
    readonly #gitAgentsByEntity = new Map<string, Set<string>>();
    #agentSystem: AgentSystemRef<LibSQLDatabase> | undefined;
    #configuration: HappyConnectionConfiguration | undefined;
    #context: Context | undefined;
    #fingerprint = "";
    #integration: HappyIntegration;
    #pairing: HappyPairing | undefined;
    #pairingGeneration = 0;
    #projectClient: HappyProjectClient | undefined;
    #integrationStart: Promise<HappyIntegration> | undefined;
    #integrationUpdates: Promise<void> = Promise.resolve();
    #lifecycleUpdates: Promise<void> = Promise.resolve();
    #gitRenewalTimer: NodeJS.Timeout | undefined;
    #machine: HappyMachineClient | undefined;
    #reconcilePromise: Promise<void> | undefined;
    #stopping = false;
    readonly #unwatchCatalog: (() => void)[] = [];

    constructor(
        config: ConfigModule,
        compute: ComputeModule,
        events: EventsModule,
        git: GitModule,
        history: HistoryModule,
        projects: ProjectsModule,
        providerUsage: ProviderUsageModule,
        scheduling: SchedulingModule,
        userInput: UserInputModule,
        workspaces: WorkspacesModule,
    ) {
        this.#config = config;
        this.#compute = compute;
        this.#events = events;
        this.#git = git;
        this.#history = history;
        this.#projects = projects;
        this.#providerUsage = providerUsage;
        this.#scheduling = scheduling;
        this.#userInput = userInput;
        this.#workspaces = workspaces;
        const now = Date.now();
        this.#integration = {
            authorization: null,
            configured: false,
            error: null,
            status: config.configuration.values.settings.happyIntegration
                ? "disconnected"
                : "disabled",
            updatedAt: now,
            version: createHappyIntegrationVersion(undefined, () => now),
        };
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
            if (event.agentId === undefined) return;
            if (this.#configuration === undefined) return;
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
        await this.#initializeIntegration(context);
        const blockedCredentialFingerprints = new Set(
            (await this.#integrationDatabase.read(context)).blockedCredentialFingerprints,
        );
        if (!this.#config.configuration.values.settings.happyIntegration) {
            const configuration = await inspectDaemonHappyCredentials({
                blockedCredentialFingerprints,
                dataDirectory: this.#config.configuration.paths.agentHome,
                environment: this.#config.happyEnvironment,
            });
            this.#configuration = configuration;
            await this.#setIntegration(context, {
                authorization: null,
                configured: configuration !== undefined,
                error: null,
                status: "disabled",
            });
            ctx.log.debug("Happy synchronization is turned off in the configuration.");
            return;
        }
        const configuration = await importHappyCredentials({
            blockedCredentialFingerprints,
            dataDirectory: this.#config.configuration.paths.agentHome,
            environment: this.#config.happyEnvironment,
        });
        if (configuration === undefined) {
            this.#configuration = undefined;
            await this.#setIntegration(context, {
                authorization: null,
                configured: false,
                error: null,
                status: "disconnected",
            });
            ctx.log.debug("Happy is not connected on this machine.");
            return;
        }
        await this.#activate(context, configuration);
    }

    async #initializeIntegration(ctx: Context): Promise<void> {
        const updatedAt = Date.now();
        const version = await this.#integrationDatabase.reserveVersion(ctx, () => updatedAt);
        this.#integration = { ...this.#integration, updatedAt, version };
    }

    /**
     * Keeps what the phone has been told about these sessions true as work is renamed and put away.
     *
     * Where a session may start is not published here. The phone reads that from the sessions
     * themselves, so a project is only ever described by the sessions that belong to it.
     */
    #watchCatalog(ctx: Context): void {
        this.#unwatchCatalog.push(
            this.#git.onSnapshot((_eventCtx, entity) => {
                for (const agentId of this.#gitAgentsByEntity.get(gitEntityKey(entity)) ?? []) {
                    this.#agents.get(agentId)?.client.kick();
                }
            }),
        );
        this.#gitRenewalTimer ??= setInterval(() => {
            for (const entity of this.#gitEntityByAgent.values()) this.#git.track(entity);
        }, GIT_TRACK_RENEWAL_MS);
        this.#gitRenewalTimer.unref();
        this.#unwatchCatalog.push(
            this.#projects.onEvent((_eventCtx, event) => {
                this.#runTask(async () => {
                    await this.#syncProjectEvent(ctx, event.project);
                    if (event.type === "project_archived") {
                        await this.#archiveRemoteAgents(
                            ctx,
                            await this.#projects.listAgentIds(ctx, event.project.id),
                        );
                    }
                    await this.#reapArchived(ctx);
                    await this.#republishAttached(ctx);
                });
            }),
        );
        this.#unwatchCatalog.push(
            this.#workspaces.onEvent((_eventCtx, event) => {
                this.#runTask(async () => {
                    if (
                        (event.type === "workspace_updated" && event.change === "begin_archive") ||
                        event.type === "workspace_archived"
                    ) {
                        await this.#archiveRemoteAgents(
                            ctx,
                            await this.#workspaces.listAgentIds(ctx, event.workspace.id),
                        );
                    }
                    await this.#reapArchived(ctx);
                    await this.#republishAttached(ctx);
                });
            }),
        );
        this.#unwatchCatalog.push(
            this.#userInput.onEvent((_eventCtx, event) => {
                this.#agents.get(event.request.askingAgentId)?.client.kick();
            }),
        );
        this.#unwatchCatalog.push(
            this.#providerUsage.onChanged(() => {
                for (const connected of this.#agents.values()) connected.client.kick();
            }),
        );
    }

    /** Stops talking to Happy, which the daemon does as it shuts down. */
    async stop(): Promise<void> {
        this.#stopping = true;
        this.#pairingGeneration += 1;
        this.#integrationStart = undefined;
        const pairing = this.#pairing;
        this.#pairing = undefined;
        pairing?.close();
        // Cleanup must run after any lifecycle transition that already passed its stopping check.
        // Otherwise an authorization settling concurrently with shutdown could create a machine
        // client after the direct cleanup had already finished.
        await this.#withLifecycleUpdate(async () => await this.#closeHappyClients());
        await this.#integrationUpdates;
    }

    /** Reads the installation-wide Happy integration snapshot. */
    integration(_ctx: Context): HappyIntegration {
        return this.#integration;
    }

    /** Watches complete integration snapshot replacements. */
    onIntegrationUpdated(listener: HappyIntegrationListener): () => void {
        this.#integrationListeners.add(listener);
        return () => {
            this.#integrationListeners.delete(listener);
        };
    }

    /** Starts or joins Happy authorization and connection work. */
    async startIntegration(ctx: Context): Promise<HappyIntegration> {
        if (!this.#config.configuration.values.settings.happyIntegration) {
            throw new HappyIntegrationStartError(
                "unsupported",
                "The Happy integration is disabled in this daemon.",
                this.#integration,
            );
        }
        const existing = this.#integrationStart;
        if (existing !== undefined) return await existing;
        const generation = this.#pairingGeneration;
        const started = this.#startIntegration(this.#context ?? ctx, generation);
        this.#integrationStart = started;
        try {
            return await started;
        } finally {
            if (this.#integrationStart === started) this.#integrationStart = undefined;
        }
    }

    async #startIntegration(ctx: Context, generation: number): Promise<HappyIntegration> {
        if (this.#stopping || generation !== this.#pairingGeneration) return this.#integration;
        if (this.#pairing !== undefined) return this.#integration;
        if (this.#configuration !== undefined) {
            if (this.#machine === undefined) {
                const outcome = await this.#withLifecycleUpdate(async () => {
                    if (this.#stopping || generation !== this.#pairingGeneration) return "stale";
                    if (this.#pairing !== undefined) return "activated";
                    if (this.#configuration === undefined) return "pair";
                    if (this.#machine !== undefined) {
                        this.#machine.start();
                        return "activated";
                    }
                    const blockedCredentialFingerprints = new Set(
                        (await this.#integrationDatabase.read(ctx)).blockedCredentialFingerprints,
                    );
                    const refreshed = await importHappyCredentials({
                        blockedCredentialFingerprints,
                        dataDirectory: this.#config.configuration.paths.agentHome,
                        environment: this.#config.happyEnvironment,
                    });
                    if (this.#stopping || generation !== this.#pairingGeneration) return "stale";
                    if (refreshed === undefined) {
                        this.#configuration = undefined;
                        return "pair";
                    }
                    await this.#activate(ctx, refreshed);
                    return "activated";
                });
                if (outcome !== "pair") return this.#integration;
            } else {
                if (this.#stopping || generation !== this.#pairingGeneration) {
                    return this.#integration;
                }
                this.#machine.start();
                return this.#integration;
            }
        }
        if (this.#stopping || generation !== this.#pairingGeneration) return this.#integration;
        return await this.#beginPairing(ctx, generation);
    }

    /** Cancels the current QR attempt without changing durable credentials. */
    async cancelIntegration(ctx: Context): Promise<HappyIntegration> {
        this.#pairingGeneration += 1;
        this.#integrationStart = undefined;
        const pairing = this.#pairing;
        this.#pairing = undefined;
        pairing?.close();
        return await this.#withLifecycleUpdate(async () => {
            if (this.#integration.status !== "pairing") return this.#integration;
            return await this.#setIntegration(this.#context ?? ctx, {
                authorization: null,
                configured: false,
                error: null,
                status: "disconnected",
            });
        });
    }

    /** Unlinks the daemon-owned Happy account without changing the external Happy CLI. */
    async disconnectIntegration(ctx: Context): Promise<HappyIntegration> {
        this.#pairingGeneration += 1;
        this.#integrationStart = undefined;
        const pairing = this.#pairing;
        const hadActivePairing = pairing !== undefined;
        this.#pairing = undefined;
        pairing?.close();
        return await this.#withLifecycleUpdate(async () => {
            // Idempotence covers credential suppression too. Once this daemon is already
            // unlinked, a repeated request must not tombstone a genuinely new external login.
            if (!hadActivePairing && isUnlinkedIntegration(this.#integration)) {
                return this.#integration;
            }
            const context = this.#context ?? ctx;
            await this.#rememberUnlinkedCredentials(context, true);
            await this.#closeHappyClients();
            this.#configuration = undefined;
            this.#fingerprint = "";
            const credentialsPath = getHappyPaths(
                this.#config.configuration.paths.agentHome,
            ).credentialsPath;
            await rm(credentialsPath, { force: true }).catch((error: unknown) => {
                context.log.debug(
                    "Happy credentials could not be removed while unlinking.",
                    {},
                    error,
                );
            });
            return await this.#setIntegration(context, {
                authorization: null,
                configured: false,
                error: null,
                status: this.#config.configuration.values.settings.happyIntegration
                    ? "disconnected"
                    : "disabled",
            });
        });
    }

    /** Replaces any current Happy authorization with a fresh QR attempt. */
    async rePairIntegration(ctx: Context): Promise<HappyIntegration> {
        if (!this.#config.configuration.values.settings.happyIntegration) {
            throw new HappyIntegrationStartError(
                "unsupported",
                "The Happy integration is disabled in this daemon.",
                this.#integration,
            );
        }
        await this.disconnectIntegration(ctx);
        return await this.startIntegration(ctx);
    }

    async #beginPairing(ctx: Context, generation: number): Promise<HappyIntegration> {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("Happy pairing was started without an agent database.");
        }
        const target = await resolveHappyConnectionTarget({
            dataDirectory: this.#config.configuration.paths.agentHome,
            environment: this.#config.happyEnvironment,
        });
        let pairing: HappyPairing;
        try {
            pairing = await HappyPairing.start({
                serverUrl: target.serverUrl,
                version: this.#config.configuration.version,
            });
            // Ownership can be invalidated before the lifecycle queue accepts this pairing.
            // Mark rejection as observed immediately; #settlePairing still handles the original
            // promise whenever this attempt becomes the module's active pairing.
            void pairing.result.catch(() => undefined);
        } catch (error: unknown) {
            if (generation !== this.#pairingGeneration || this.#stopping) {
                return this.#integration;
            }
            ctx.log.debug("Happy authorization could not be started.", {}, error);
            throw new HappyIntegrationStartError(
                "happy_unavailable",
                "Happy is unavailable. Please try again.",
                this.#integration,
            );
        }
        return await this.#withLifecycleUpdate(async () => {
            if (this.#stopping || generation !== this.#pairingGeneration) {
                pairing.close();
                return this.#integration;
            }
            this.#pairing = pairing;
            await this.#setIntegration(ctx, {
                authorization: pairing.authorization,
                configured: false,
                error: null,
                status: "pairing",
            });
            void this.#settlePairing(
                withAgentDatabase(detach(ctx).named("happy-pairing"), database),
                pairing,
                target,
            );
            return this.#integration;
        });
    }

    async #settlePairing(
        ctx: Context,
        pairing: HappyPairing,
        target: HappyConnectionTarget,
    ): Promise<void> {
        try {
            const credentials = await pairing.result;
            await this.#withLifecycleUpdate(async () => {
                if (this.#pairing !== pairing || this.#stopping) return;
                await saveHappyPairingCredentials(target, credentials);
                await this.#integrationDatabase.clearBlockedCredentialFingerprints(ctx);
                const configuration = await importHappyCredentials({
                    adoptExternalCredentials: false,
                    dataDirectory: this.#config.configuration.paths.agentHome,
                    environment: this.#config.happyEnvironment,
                });
                if (configuration === undefined) {
                    throw new HappyPairingError(
                        "invalid_response",
                        "The saved Happy credentials could not be loaded.",
                    );
                }
                this.#pairing = undefined;
                await this.#activate(ctx, configuration);
            });
        } catch (error: unknown) {
            await this.#withLifecycleUpdate(async () => {
                if (this.#pairing !== pairing || this.#stopping) return;
                this.#pairing = undefined;
                const projected = pairingError(error);
                ctx.log.debug(
                    "Happy authorization did not complete.",
                    { code: projected.code },
                    error,
                );
                await this.#setIntegration(ctx, {
                    authorization: null,
                    configured: false,
                    error: projected,
                    status: "failed",
                });
            });
        }
    }

    async #activate(ctx: Context, configuration: HappyConnectionConfiguration): Promise<void> {
        await this.#closeHappyClients();
        this.#configuration = configuration;
        this.#fingerprint = fingerprint(configuration);
        await this.#setIntegration(ctx, {
            authorization: null,
            configured: true,
            error: null,
            status: "connecting",
        });
        if (configuration.machineId === undefined) {
            await this.#setIntegration(ctx, {
                authorization: null,
                configured: true,
                error: {
                    code: "invalid_response",
                    message: "Happy Agent could not create its Happy machine identity.",
                },
                status: "failed",
            });
            return;
        }
        let machine!: HappyMachineClient;
        machine = new HappyMachineClient({
            configuration,
            context: ctx,
            models: () => this.models(),
            onConnectionChanged: (event) => {
                void this.#handleMachineConnection(ctx, machine, event).catch((error: unknown) => {
                    ctx.log.error("Happy connection state could not be recorded.", {}, error);
                });
            },
            operations: this,
            remoteSessionId: async (agentId) =>
                (await this.#sync.readSession(ctx, agentId))?.remoteSessionId,
            version: this.#config.configuration.version,
        });
        this.#machine = machine;
        this.#projectClient = new HappyProjectClient({
            avatarAsset: async (assetCtx, projectId) =>
                await this.#projects.avatarAsset(assetCtx, projectId),
            configuration,
            context: ctx,
            sync: this.#projectSync,
            version: this.#config.configuration.version,
        });
        machine.start();
        this.#watchCatalog(ctx);
        const reconcile = (async () => {
            await this.#reconcileProjects(ctx);
            await this.#reapArchived(ctx);
            await this.#reconcile(ctx);
        })().catch((error: unknown) => {
            ctx.log.debug("Happy could not restore its visible sessions.", {}, error);
        });
        this.#reconcilePromise = reconcile;
        void reconcile.finally(() => {
            if (this.#reconcilePromise === reconcile) this.#reconcilePromise = undefined;
        });
    }

    async #handleMachineConnection(
        ctx: Context,
        machine: HappyMachineClient,
        event: HappyMachineConnectionEvent,
    ): Promise<void> {
        if (this.#machine !== machine || this.#stopping) return;
        if (event.status === "connected") {
            await this.#setIntegration(ctx, {
                authorization: null,
                configured: true,
                error: null,
                status: "connected",
            });
            return;
        }
        if (event.status === "connecting") {
            // Registration retries remain one stable disconnected snapshot until they succeed.
            if (this.#integration.status === "disconnected") return;
            await this.#setIntegration(ctx, {
                authorization: null,
                configured: true,
                error: null,
                status: "connecting",
            });
            return;
        }
        if (event.reason === "credentials_rejected") {
            await this.#withLifecycleUpdate(
                async () => await this.#invalidateCredentials(ctx, machine, event.message),
            );
            return;
        }
        await this.#setIntegration(ctx, {
            authorization: null,
            configured: true,
            error: { code: "happy_unavailable", message: event.message },
            status: "disconnected",
        });
    }

    async #invalidateCredentials(
        ctx: Context,
        machine: HappyMachineClient,
        message: string,
    ): Promise<void> {
        if (this.#machine !== machine) return;
        const credentialsPath = this.#configuration?.credentialsPath;
        await this.#rememberUnlinkedCredentials(ctx, false);
        await this.#closeHappyClients();
        this.#configuration = undefined;
        this.#fingerprint = "";
        if (credentialsPath !== undefined) {
            await rm(credentialsPath, { force: true }).catch((error: unknown) => {
                ctx.log.debug("Rejected Happy credentials could not be removed.", {}, error);
            });
        }
        await this.#setIntegration(ctx, {
            authorization: null,
            configured: false,
            error: { code: "credentials_rejected", message },
            status: "failed",
        });
    }

    async #setIntegration(ctx: Context, value: HappyIntegrationValue): Promise<HappyIntegration> {
        return await this.#withIntegrationUpdate(async () => {
            if (sameIntegration(this.#integration, value)) return this.#integration;
            const updatedAt = Date.now();
            const version = await this.#integrationDatabase.reserveVersion(
                this.#context ?? ctx,
                () => updatedAt,
            );
            const integration = { ...value, updatedAt, version } as HappyIntegration;
            this.#integration = integration;
            await Promise.all(
                [...this.#integrationListeners].map(
                    async (listener) => await listener(ctx, integration),
                ),
            );
            return integration;
        });
    }

    async #rememberUnlinkedCredentials(
        ctx: Context,
        suppressCurrentExternalCredential: boolean,
    ): Promise<void> {
        const owned = await inspectDaemonHappyCredentials({
            dataDirectory: this.#config.configuration.paths.agentHome,
            environment: this.#config.happyEnvironment,
        });
        const external = await readExternalHappyCredentialFingerprint({
            environment: this.#config.happyEnvironment,
        });
        const ownedFingerprints = [
            this.#configuration?.credentialFingerprint,
            owned?.credentialFingerprint,
        ].filter((value): value is string => value !== undefined);
        const fingerprints = [
            ...ownedFingerprints,
            ...(external !== undefined &&
            (suppressCurrentExternalCredential || ownedFingerprints.includes(external))
                ? [external]
                : []),
        ];
        if (fingerprints.length === 0) return;
        await this.#integrationDatabase.addBlockedCredentialFingerprints(ctx, fingerprints);
    }

    async #closeHappyClients(): Promise<void> {
        if (this.#gitRenewalTimer !== undefined) clearInterval(this.#gitRenewalTimer);
        this.#gitRenewalTimer = undefined;
        for (const unwatch of this.#unwatchCatalog.splice(0)) unwatch();
        this.#projectClient = undefined;
        this.#machine?.close();
        this.#machine = undefined;
        await this.#reconcilePromise?.catch(() => undefined);
        await this.#settleTasks();
        const connected = [...this.#agents.values()];
        this.#agents.clear();
        this.#served.clear();
        this.#archivingAgents.clear();
        this.#retiredAgents.clear();
        this.#gitEntityByAgent.clear();
        this.#gitAgentsByEntity.clear();
        await Promise.all(connected.map(async (agent) => await agent.client.close()));
    }

    async #withIntegrationUpdate<Value>(operation: () => Promise<Value>): Promise<Value> {
        const run = this.#integrationUpdates.then(operation);
        this.#integrationUpdates = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    async #withLifecycleUpdate<Value>(operation: () => Promise<Value>): Promise<Value> {
        const run = this.#lifecycleUpdates.then(operation);
        this.#lifecycleUpdates = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    /** Sends everything owed and waits for it, which is what a shutdown and a test need. */
    async settle(): Promise<void> {
        await this.#reconcilePromise;
        await this.#settleTasks();
        await Promise.all(
            [...this.#agents.values()].map(async (agent) => await agent.client.settle()),
        );
    }

    async #settleTasks(): Promise<void> {
        while (this.#tasks.size > 0) {
            await Promise.allSettled([...this.#tasks]);
        }
    }

    #runTask(work: () => Promise<void>): void {
        if (this.#stopping) return;
        const task = work()
            .catch((error: unknown) => {
                this.#context?.log.debug("Happy catalog synchronization failed.", {}, error);
            })
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
    }

    /** Every model the phone may offer, across providers. */
    models(): readonly HappyModel[] {
        return this.#config.models.map((model) => ({
            defaultEffort: model.defaultEffort,
            effortLevels: [...model.effortLevels],
            id: model.id,
            name: model.name,
            providerId: model.providerId,
            serviceTiers: model.serviceTiers === undefined ? [] : [...model.serviceTiers],
        }));
    }

    /** Latest advisory account quota for the provider selected by a Happy session. */
    providerUsage(providerId: string) {
        return (
            this.#providerUsage.list().find((entry) => entry.providerId === providerId)?.usage ??
            null
        );
    }

    /** One agent as Happy needs to describe it, or nothing when it is gone. */
    async session(ctx: Context, agentId: string): Promise<HappySessionSnapshot | undefined> {
        const config = await this.#system().config(ctx, agentId);
        if (config === undefined) return undefined;
        return await this.#snapshot(ctx, agentId, config);
    }

    /** Delivers what a person said on the phone, and what they chose to say it with. */
    async submit(ctx: Context, agentId: string, message: HappyInboundMessage): Promise<void> {
        const system = this.#system();
        const config = await system.config(ctx, agentId);
        if (config === undefined) {
            throw new Error(`No agent exists for Happy session "${agentId}".`);
        }
        const current = selectionFromConfig(config, this.#defaultSelection());
        let next: HappySelection;
        try {
            next = checkedSelection(this.#config.models, {
                effort: message.selection.effort ?? current.effort,
                modelId: message.selection.modelId ?? current.modelId,
                permissionMode: message.selection.permissionMode ?? current.permissionMode,
                providerId: message.selection.providerId ?? current.providerId,
            });
        } catch (cause) {
            throw new HappyMessageRefused(
                cause instanceof Error ? cause.message : "That model selection is not available.",
                { cause },
            );
        }
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

    /** Archives the local agent when the person archives its Happy session. */
    async archiveSession(ctx: Context, agentId: string): Promise<void> {
        const system = this.#system();
        const config = await system.config(ctx, agentId);
        if (config === undefined) return;
        if (typeof config.metadata?.archivedAt !== "number") {
            await system.abort(ctx, agentId);
            await this.#compute.archiveAgent(ctx, agentId);
            const now = Date.now();
            await system.updateMetadata(ctx, agentId, {
                archivedAt: now,
                updatedAt: now,
                version:
                    typeof config.metadata?.version === "number" ? config.metadata.version + 1 : 1,
            });
        }
        await this.#archiveRemoteProjection(ctx, agentId);
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

    defaultSpawnPermissionMode(): HappySelection["permissionMode"] {
        return this.#config.configuration.values.defaults.permissionMode;
    }

    readSpawnResult(clientRequestId: string): HappySpawnResult | undefined {
        return this.#served.get(clientRequestId);
    }

    rememberSpawnResult(clientRequestId: string, result: HappySpawnResult): void {
        if (result.type === "pending") return;
        this.#served.delete(clientRequestId);
        this.#served.set(clientRequestId, result);
        while (this.#served.size > MAX_SERVED_SPAWN_RESULTS) {
            const oldest = this.#served.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#served.delete(oldest);
        }
    }

    /** Starts the deterministic local agent behind either Happy spawn request. */
    async spawnSession(ctx: Context, request: HappySpawnRequest): Promise<HappySpawnStartResult> {
        const system = this.#system();
        const owner = await this.#resolveSpawnOwner(ctx, request);
        if (owner === undefined) return { type: "pending" };
        const cwd = owner.workspaceId === undefined ? owner.projectPath : owner.workspacePath;
        const existing = await system.config(ctx, request.sessionId);
        const selection = checkedSelection(this.#config.models, {
            effort: request.effort,
            modelId: request.modelId,
            permissionMode: request.permissionMode,
            providerId: request.providerId,
        });
        // Creating the agent and placing it in its folder are one decision. The catalog refuses a
        // folder that is being archived, and this is the retry key's only durable record, so a
        // refusal must leave no agent behind: an existing configuration is what a later retry reads
        // to decide the session is already made.
        if (existing === undefined) {
            await ctx.inTx(async (txCtx) => {
                await system.create(txCtx, agentConfigFor(cwd, selection, owner), {
                    id: request.sessionId,
                });
                await this.#attachSpawnOwner(txCtx, request.sessionId, owner);
            });
        } else if (typeof existing.metadata?.archivedAt === "number") {
            throw new Error("That Happy Agent session is archived.");
        } else {
            await this.#attachSpawnOwner(ctx, request.sessionId, owner);
        }
        await this.#attach(ctx, request.sessionId);
        return { agentId: request.sessionId, type: "ready" };
    }

    async #resolveSpawnOwner(
        ctx: Context,
        request: HappySpawnRequest,
    ): Promise<
        | {
              projectId: string;
              projectPath: string;
              workspaceId?: string;
              workspacePath: string;
          }
        | undefined
    > {
        if ("cwd" in request) {
            const owner = await this.#workspaces.resolvePath(ctx, request.cwd);
            return {
                projectId: owner.project.id,
                projectPath: owner.project.repositoryRef,
                ...(owner.workspace === undefined
                    ? { workspacePath: owner.project.repositoryRef }
                    : {
                          workspaceId: owner.workspace.id,
                          workspacePath: owner.workspace.path,
                      }),
            };
        }

        const target = request.target;
        if (target.kind === "project") {
            const project = await this.#projects.get(ctx, target.id);
            if (project === undefined || project.status === "archived") {
                throw new Error("That project is not available in Happy Agent.");
            }
            return {
                projectId: project.id,
                projectPath: project.repositoryRef,
                workspacePath: project.repositoryRef,
            };
        }
        if (target.kind === "workspace") {
            const workspace = await this.#workspaces.get(ctx, target.id);
            if (workspace === undefined || workspace.status !== "ready") {
                throw new Error("That workspace is not ready in Happy Agent.");
            }
            const project = await this.#projects.get(ctx, workspace.projectRef);
            if (project === undefined || project.status === "archived") {
                throw new Error("That workspace's project is not available in Happy Agent.");
            }
            return {
                projectId: project.id,
                projectPath: project.repositoryRef,
                workspaceId: workspace.id,
                workspacePath: workspace.path,
            };
        }
        if (target.kind === "projectFolder") {
            await mkdir(target.projectPath, { recursive: true });
            const owner = await this.#workspaces.resolvePath(ctx, target.projectPath);
            return {
                projectId: owner.project.id,
                projectPath: owner.project.repositoryRef,
                ...(owner.workspace === undefined
                    ? { workspacePath: owner.project.repositoryRef }
                    : {
                          workspaceId: owner.workspace.id,
                          workspacePath: owner.workspace.path,
                      }),
            };
        }

        const project = await this.#projects.get(ctx, target.projectId);
        if (project === undefined || project.status === "archived") {
            throw new Error("That project is not available in Happy Agent.");
        }
        let workspace = await this.#workspaces.get(ctx, request.workspaceId);
        if (workspace === undefined) {
            workspace = await this.#workspaces.createWorkspace(ctx, project.id, {
                id: request.workspaceId,
                name: "Workspace",
                nameConfigured: false,
                parentId: project.id,
            });
        }
        if (workspace === undefined) {
            throw new Error("Happy Agent could not create that workspace.");
        }
        if (workspace.projectRef !== project.id) {
            throw new Error("That workspace belongs to another project.");
        }
        if (workspace.status === "initializing") return undefined;
        if (workspace.status !== "ready") {
            throw new Error("That workspace could not be prepared.");
        }
        return {
            projectId: project.id,
            projectPath: project.repositoryRef,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
        };
    }

    async #attachSpawnOwner(
        ctx: Context,
        agentId: string,
        owner: { readonly projectId: string; readonly workspaceId?: string },
    ): Promise<void> {
        const currentWorkspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
        const currentProject = await this.#projects.projectForAgent(ctx, agentId);
        if (owner.workspaceId !== undefined) {
            if (currentWorkspaceId === owner.workspaceId) return;
            if (currentWorkspaceId !== undefined || currentProject !== undefined) {
                throw new Error("That session already belongs to another project or workspace.");
            }
            await this.#workspaces.attachAgent(ctx, owner.workspaceId, agentId);
            return;
        }
        if (currentProject?.id === owner.projectId && currentWorkspaceId === undefined) return;
        if (currentWorkspaceId !== undefined || currentProject !== undefined) {
            throw new Error("That session already belongs to another project or workspace.");
        }
        await this.#projects.attachAgent(ctx, owner.projectId, agentId);
    }

    /**
     * Whether a person can still open this agent, which is whether the place it lives is still
     * somewhere they navigate to.
     *
     * A hidden subagent belongs to the agent that spawned it and to no place a person navigates to.
     * Giving it a session of its own would put work nobody started at the top of the phone's list,
     * and a busy delegating agent would fill that list on its own.
     *
     * Archiving keeps the association, so belonging to a workspace is not the same as being
     * reachable through one: an archived owner is asked about here rather than assumed live, or a
     * session put away on the desktop would come back the moment its agent said anything.
     */
    async #userVisible(ctx: Context, agentId: string): Promise<boolean> {
        const config = await this.#system().config(ctx, agentId);
        if (config === undefined || typeof config.metadata?.archivedAt === "number") return false;
        const workspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
        if (workspaceId !== undefined) {
            const workspace = await this.#workspaces.get(ctx, workspaceId);
            if (workspace === undefined) return false;
            if (workspace.status === "archived" || workspace.archivedAt !== undefined) return false;
            const parent = await this.#projects.get(ctx, workspace.projectRef);
            return parent !== undefined && parent.status !== "archived";
        }
        const project = await this.#projects.projectForAgent(ctx, agentId);
        return project !== undefined && project.status !== "archived";
    }

    /**
     * Asks every live session to describe itself again, because where it lives has changed.
     *
     * Renaming a workspace or a project renames it on the phone: the session's own metadata is
     * what the phone groups and labels by, so it is republished rather than left saying the old
     * name until something else happens to move it.
     */
    async #republishAttached(_ctx: Context): Promise<void> {
        for (const attached of this.#agents.values()) attached.client.kick();
    }

    /** Project sync is best effort and never participates in session event transactions. */
    async #syncProjectEvent(ctx: Context, project: Project): Promise<void> {
        const client = this.#projectClient;
        if (client === undefined) return;
        try {
            await client.sync(project);
        } catch (error) {
            ctx.log.debug(
                "Happy could not synchronize a project.",
                { projectId: project.id },
                error,
            );
        }
    }

    async #remoteProjectId(ctx: Context, localProjectId: string): Promise<string | undefined> {
        const client = this.#projectClient;
        if (client === undefined) return undefined;
        try {
            return await client.remoteProjectId(localProjectId);
        } catch (error) {
            ctx.log.debug(
                "Happy could not read a project's remote identity.",
                {
                    projectId: localProjectId,
                },
                error,
            );
            return undefined;
        }
    }

    /** Walks every local catalog page with one bounded remote request in flight at a time. */
    async #reconcileProjects(ctx: Context): Promise<void> {
        const client = this.#projectClient;
        if (client === undefined) return;
        let cursor: string | undefined;
        do {
            const page = await this.#projects.listCatalogPage(ctx, {
                includeArchived: true,
                ...(cursor === undefined ? {} : { cursor }),
            });
            for (const project of page.projects) {
                try {
                    await client.sync(project, { verifyRemote: true });
                } catch (error) {
                    ctx.log.debug(
                        "Happy could not synchronize a project during startup.",
                        {
                            projectId: project.id,
                        },
                        error,
                    );
                }
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
    }

    /**
     * Puts away every session whose place has been archived since it was published.
     *
     * Archiving on the desktop is the same decision as ending the session on the phone, so the
     * phone is told in the same words rather than left holding a session pointing at a checkout
     * that may no longer be on disk.
     */
    async #reapArchived(ctx: Context): Promise<void> {
        const agentIds = new Set([
            ...this.#agents.keys(),
            ...(this.#fingerprint.length === 0
                ? []
                : await this.#sync.listAgentIds(ctx, this.#fingerprint, MAX_REAPED_SYNC_SESSIONS)),
        ]);
        for (const agentId of agentIds) {
            try {
                if (await this.#userVisible(ctx, agentId)) continue;
                await this.#archiveRemoteProjection(ctx, agentId);
            } catch (error) {
                ctx.log.debug("Happy could not retire an archived session.", { agentId }, error);
            }
        }
    }

    async #attach(ctx: Context, agentId: string): Promise<ConnectedAgent | undefined> {
        if (this.#stopping) return undefined;
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;
        const configuration = this.#configuration;
        const context = this.#context;
        if (configuration === undefined || context === undefined) return undefined;
        if (this.#agents.size >= MAX_CONNECTED_AGENTS) return undefined;
        if (!(await this.#userVisible(ctx, agentId))) return undefined;
        const session = await this.session(ctx, agentId);
        if (session === undefined) return undefined;
        const localProjectId = session.project?.id;
        if (localProjectId !== undefined) {
            const projectClient = this.#projectClient;
            if (projectClient !== undefined) {
                try {
                    const project = await this.#projects.get(ctx, localProjectId);
                    if (project !== undefined) {
                        await projectClient.sync(project, { verifyRemote: true });
                    }
                } catch (error) {
                    ctx.log.debug(
                        "Happy project sync did not block session attachment.",
                        {
                            agentId,
                            projectId: localProjectId,
                        },
                        error,
                    );
                }
            }
        }
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
        const mapper = new HappyMessageMapper();
        await this.#backfill(ctx, agentId, mapper);
        const attached: ConnectedAgent = {
            client: new HappySessionClient({
                agentId,
                configuration,
                context,
                operations: this,
                ...(localProjectId === undefined
                    ? {}
                    : {
                          projectId: async () => await this.#remoteProjectId(ctx, localProjectId),
                      }),
                sessionId: session.sessionId,
                sync: this.#sync,
                version: this.#config.configuration.version,
            }),
            mapper,
        };
        if (this.#stopping) {
            await attached.client.close();
            return undefined;
        }
        this.#agents.set(agentId, attached);
        afterCommit(ctx, () => {
            attached.client.start();
        });
        return attached;
    }

    /**
     * Puts the conversation a session already had onto the phone, once.
     *
     * A session that has been running all week is not new to the person who started it, and
     * without this it arrives on the phone as an empty room: the projection only carries what
     * happens from the moment Happy attaches, so everything said before that is simply missing.
     *
     * The projection cursor is moved to the newest event this agent has recorded, so the live
     * stream picks up immediately after what was replayed rather than repeating it. The archive
     * is the source rather than the journal because the journal's live window is bounded and a
     * cold start begins with it empty — the very case this exists for.
     *
     * Failing to read the past is not a reason to refuse the present. A session that cannot be
     * backfilled still attaches and still streams; it just opens empty, which is what it did
     * before this existed.
     */
    async #backfill(ctx: Context, agentId: string, mapper: HappyMessageMapper): Promise<void> {
        const existing = await this.#sync.readSession(ctx, agentId);
        if (existing?.historyBackfilled !== false) return;
        try {
            const page = await this.#history.read(ctx, agentId, {
                from: "end",
                limit: HAPPY_BACKFILL_MESSAGES,
            });
            const latest = await this.#events.latestAgentEvent(ctx, agentId);
            // One archived record may contain several structured tool events. The phone's initial
            // payload is still bounded to 50 protocol messages, keeping the newest visible context
            // while preserving chronological order within that window.
            const history = mapper.mapHistory(
                page.messages.map((record) => record.message),
                HAPPY_BACKFILL_MESSAGES,
            );
            await this.#sync.backfillHistory(
                ctx,
                agentId,
                history.map((message) => ({
                    localId: message.localId,
                    payload: message,
                })),
                latest?.cursor,
                Date.now(),
            );
        } catch (error) {
            ctx.log.debug(
                "Happy could not replay what this session already said.",
                { agentId },
                error,
            );
        }
    }

    /**
     * Attaches every session a person can still open, because this daemon has just started.
     *
     * Sessions attach on their own when they next record something, which is enough for a busy
     * agent and no use at all for a quiet one: before this, a conversation nobody had touched
     * since the restart stayed off the phone until somebody went to the desktop and prodded it.
     * A person expects to reopen their laptop and find their work where they left it.
     *
     * Walked through the places a person navigates to rather than through every agent that
     * exists, because those places are exactly what makes a session reachable — the same
     * question `#userVisible` asks one agent at a time. A hidden subagent belongs to no such
     * place and is passed over here for the reason it is refused there.
     *
     * Archived projects and workspaces are left out by the listings themselves, which is the
     * same answer a person gets when they go looking for their work. The durable attachment lists
     * may still name locally archived agents, so `#attach` checks Agent Base metadata before
     * spending one of the bounded session connections on them.
     */
    async #reconcile(ctx: Context): Promise<void> {
        const attach = async (agentId: string): Promise<boolean> => {
            if (this.#stopping || this.#agents.size >= MAX_CONNECTED_AGENTS) return false;
            try {
                await this.#attach(ctx, agentId);
            } catch (error) {
                ctx.log.debug("Happy could not restore a session.", { agentId }, error);
            }
            return true;
        };
        try {
            let workspaceCursor: number | undefined;
            do {
                const page = await this.#workspaces.listCatalogPage(ctx, {
                    ...(workspaceCursor === undefined ? {} : { cursor: workspaceCursor }),
                });
                for (const workspace of page.workspaces) {
                    for (const agentId of await this.#workspaces.listAgentIds(ctx, workspace.id)) {
                        if (!(await attach(agentId))) return;
                    }
                }
                workspaceCursor = page.nextCursor;
            } while (workspaceCursor !== undefined);

            let projectCursor: string | undefined;
            do {
                const page = await this.#projects.listCatalogPage(ctx, {
                    ...(projectCursor === undefined ? {} : { cursor: projectCursor }),
                });
                for (const project of page.projects) {
                    for (const agentId of await this.#projects.listAgentIds(ctx, project.id)) {
                        if (!(await attach(agentId))) return;
                    }
                }
                projectCursor = page.nextCursor;
            } while (projectCursor !== undefined);
        } catch (error) {
            ctx.log.debug("Happy could not read the sessions on this computer.", {}, error);
        }
    }

    async #archiveRemoteAgents(ctx: Context, agentIds: readonly string[]): Promise<void> {
        for (const agentId of agentIds) {
            try {
                await this.#archiveRemoteProjection(ctx, agentId);
            } catch (error) {
                ctx.log.debug("Happy could not retire an archived session.", { agentId }, error);
            }
        }
    }

    async #archiveRemoteProjection(ctx: Context, agentId: string): Promise<void> {
        if (this.#archivingAgents.has(agentId) || this.#retiredAgents.has(agentId)) return;
        const attached = this.#agents.get(agentId);
        const existing = await this.#sync.readSession(ctx, agentId);
        if (attached === undefined && existing?.remoteSessionId === undefined) return;
        const configuration = this.#configuration;
        const context = this.#context;
        if (configuration === undefined || context === undefined) return;
        const client =
            attached?.client ??
            new HappySessionClient({
                agentId,
                configuration,
                context,
                operations: this,
                sessionId: existing?.sessionId ?? agentId,
                sync: this.#sync,
                version: this.#config.configuration.version,
            });
        afterCommit(ctx, () => {
            if (this.#archivingAgents.has(agentId) || this.#retiredAgents.has(agentId)) {
                if (attached === undefined) void client.close();
                return;
            }
            if (this.#stopping) {
                if (attached === undefined) void client.close();
                return;
            }
            this.#agents.delete(agentId);
            this.#forgetGitAgent(agentId);
            this.#archivingAgents.add(agentId);
            this.#runTask(async () => {
                try {
                    await client.archive();
                    this.#retiredAgents.add(agentId);
                } finally {
                    this.#archivingAgents.delete(agentId);
                }
            });
        });
    }

    /** One session, described in the terms Happy publishes it. */
    async #snapshot(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
    ): Promise<HappySessionSnapshot> {
        const cwd = config.environment?.workingDirectory;
        if (cwd === undefined) {
            throw new Error(`Agent "${agentId}" has no working directory.`);
        }
        const selection = selectionFromConfig(config, this.#defaultSelection());
        const owner = await this.#owner(ctx, agentId);
        const git =
            owner.project === undefined
                ? (this.#forgetGitAgent(agentId), undefined)
                : this.#gitSummary(agentId, {
                      path: cwd,
                      projectId: owner.project.id,
                      ...(owner.workspace === undefined ? {} : { workspaceId: owner.workspace.id }),
                  });
        let lastUserOrFinalAssistantTextMessageAt: number | undefined;
        try {
            lastUserOrFinalAssistantTextMessageAt =
                await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, agentId);
        } catch (error) {
            // Session ordering is enrichment. A broken history read must not take the live
            // conversation or the rest of its metadata off the phone.
            ctx.log.debug(
                "Happy could not read the latest conversation timestamp.",
                { agentId },
                error,
            );
        }
        let lastQuestionAt: number | undefined;
        try {
            lastQuestionAt = await this.#userInput.latestQuestionAt(ctx, agentId);
        } catch (error) {
            ctx.log.debug(
                "Happy could not read the latest question timestamp.",
                { agentId },
                error,
            );
        }
        const lastMeaningfulMessageAt = latestTimestamp(
            lastUserOrFinalAssistantTextMessageAt,
            lastQuestionAt,
        );
        return {
            agentId,
            archived: typeof config.metadata?.archivedAt === "number",
            cwd,
            effort: selection.effort,
            ...(git === undefined ? {} : { git }),
            ...(owner.gitBranch === undefined ? {} : { gitBranch: owner.gitBranch }),
            ...(lastMeaningfulMessageAt === undefined ? {} : { lastMeaningfulMessageAt }),
            modelId: selection.modelId,
            permissionMode: selection.permissionMode,
            ...(owner.project === undefined ? {} : { project: owner.project }),
            projectName: owner.project?.name ?? basename(cwd) ?? cwd,
            providerId: selection.providerId,
            sessionId: agentId,
            status: "idle",
            // An unnamed chat says nothing rather than inventing a name: Happy has its own
            // words for one, and a placeholder here would overwrite them on the phone.
            ...(typeof config.metadata?.title === "string" ? { title: config.metadata.title } : {}),
            tools: [],
            // Events owns the live run edge and restores it from durable state after restart.
            // Its post-commit listener kicks this session on both start and completion.
            working: this.#events.activeRunId(agentId) !== undefined,
            ...(owner.workspace === undefined ? {} : { workspace: owner.workspace }),
        };
    }

    /** Tracks one checkout and returns its latest complete branch comparison, when ready. */
    #gitSummary(
        agentId: string,
        entity: GitTrackedEntity,
    ):
        | {
              changedFiles: number;
              countsExact: boolean;
              deletions: number;
              insertions: number;
          }
        | undefined {
        this.#rememberGitEntity(agentId, entity);
        this.#git.track(entity);
        const snapshot = this.#git.trackedSnapshot(entity);
        if (snapshot?.comparison !== "ready") return undefined;
        return gitSummary(snapshot);
    }

    #rememberGitEntity(agentId: string, entity: GitTrackedEntity): void {
        const previous = this.#gitEntityByAgent.get(agentId);
        if (previous !== undefined && sameGitEntity(previous, entity)) return;
        this.#forgetGitAgent(agentId);
        this.#gitEntityByAgent.set(agentId, entity);
        const key = gitEntityKey(entity);
        const agents = this.#gitAgentsByEntity.get(key) ?? new Set<string>();
        agents.add(agentId);
        this.#gitAgentsByEntity.set(key, agents);
    }

    #forgetGitAgent(agentId: string): void {
        const previous = this.#gitEntityByAgent.get(agentId);
        if (previous === undefined) return;
        this.#gitEntityByAgent.delete(agentId);
        const key = gitEntityKey(previous);
        const agents = this.#gitAgentsByEntity.get(key);
        agents?.delete(agentId);
        if (agents?.size === 0) this.#gitAgentsByEntity.delete(key);
    }

    /**
     * Where this agent lives, in the terms the phone groups by.
     *
     * A workspace names its own project, so a session in a worktree gathers with the sessions in
     * the checkout it came from rather than sitting alone. An agent belonging to neither is a
     * session somewhere this daemon does not keep, and says so by describing no owner at all.
     */
    async #owner(
        ctx: Context,
        agentId: string,
    ): Promise<{
        gitBranch?: string;
        project?: { id: string; kind: "home" | "regular"; name: string };
        workspace?: { id: string; name: string };
    }> {
        try {
            const workspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
            if (workspaceId !== undefined) {
                const workspace = await this.#workspaces.get(ctx, workspaceId);
                if (workspace !== undefined) {
                    const project = await this.#projects.get(ctx, workspace.projectRef);
                    return {
                        ...(workspace.branch === undefined ? {} : { gitBranch: workspace.branch }),
                        ...(project === undefined
                            ? {}
                            : {
                                  project: {
                                      id: project.id,
                                      kind: project.kind,
                                      name: project.name,
                                  },
                              }),
                        workspace: { id: workspace.id, name: workspace.name },
                    };
                }
            }
            const project = await this.#projects.projectForAgent(ctx, agentId);
            if (project === undefined) return {};
            return {
                ...(project.gitBranch === undefined ? {} : { gitBranch: project.gitBranch }),
                project: { id: project.id, kind: project.kind, name: project.name },
            };
        } catch (error) {
            // Describing a session is never worth failing to publish it over: without an owner
            // it still reaches the phone, grouped by itself rather than with its neighbours.
            ctx.log.debug("Happy could not read where an agent lives.", { agentId }, error);
            return {};
        }
    }

    #defaultSelection(): HappySelection {
        const model = this.#config.models[0];
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

function agentConfigFor(
    cwd: string,
    selection: HappySelection,
    owner: { readonly projectId: string; readonly workspaceId?: string },
): AgentConfig {
    return {
        environment: { ...currentAgentEnvironment(), workingDirectory: cwd },
        metadata: { happy: selection },
        modules: {
            compute: {
                cwd,
                providerId: "host",
                secretScope: {
                    projectId: owner.projectId,
                    workspaceId: owner.workspaceId ?? owner.projectId,
                },
            },
        },
    };
}

function latestTimestamp(
    first: number | undefined,
    second: number | undefined,
): number | undefined {
    if (first === undefined) return second;
    if (second === undefined) return first;
    return Math.max(first, second);
}

function gitEntityKey(entity: Pick<GitTrackedEntity, "projectId" | "workspaceId">): string {
    return entity.workspaceId === undefined
        ? `project:${entity.projectId}`
        : `workspace:${entity.workspaceId}`;
}

function sameGitEntity(left: GitTrackedEntity, right: GitTrackedEntity): boolean {
    return (
        left.path === right.path &&
        left.projectId === right.projectId &&
        left.workspaceId === right.workspaceId
    );
}

function gitSummary(snapshot: GitChangeSnapshot): {
    changedFiles: number;
    countsExact: boolean;
    deletions: number;
    insertions: number;
} {
    return {
        changedFiles: snapshot.changedFiles,
        countsExact: snapshot.countsExact,
        deletions: snapshot.deletions,
        insertions: snapshot.insertions,
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

function pairingError(error: unknown): HappyIntegrationError {
    if (error instanceof HappyPairingError && error.code !== "cancelled") {
        return { code: error.code, message: error.message };
    }
    return {
        code: "invalid_response",
        message: "Happy authorization could not be completed.",
    };
}

function sameIntegration(current: HappyIntegration, value: HappyIntegrationValue): boolean {
    return (
        current.status === value.status &&
        current.configured === value.configured &&
        current.authorization?.kind === value.authorization?.kind &&
        current.authorization?.data === value.authorization?.data &&
        current.authorization?.expiresAt === value.authorization?.expiresAt &&
        current.error?.code === value.error?.code &&
        current.error?.message === value.error?.message
    );
}

function isUnlinkedIntegration(integration: HappyIntegration): boolean {
    return (
        integration.configured === false &&
        integration.authorization === null &&
        integration.error === null &&
        (integration.status === "disabled" || integration.status === "disconnected")
    );
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
