import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { HappyIntegration } from "@slopus/happy-agent-client";
import { detach, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import type { ArtifactsModule } from "../artifacts/index.js";
import type { BotsModule } from "../bots/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import type { EventsModule } from "../events/index.js";
import type { ProjectFilesModule } from "../files/index.js";
import type { GitModule } from "../git/index.js";
import type { HistoryModule } from "../history/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { ProviderUsageModule } from "../providerUsage/index.js";
import type { RunnersModule } from "../runners/index.js";
import type { SchedulingModule } from "../scheduling/index.js";
import type { SurfacesModule } from "../surfaces/index.js";
import type { TasksModule } from "../tasks/index.js";
import { TeamAuthenticationError, type TeamModule, type TeamUser } from "../team/index.js";
import type { UserInputModule } from "../userInput/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import { HappyConnection, type HappyIntegrationListener } from "./HappyConnection.js";
import { happySyncMigrations } from "./HappySyncDatabase.js";
import { happyIntegrationMigrations } from "./HappyIntegrationDatabase.js";
import { happyProjectSyncMigrations } from "./HappyProjectSyncDatabase.js";
import { HAPPY_UPLOADS_SWEEP_INTERVAL_MS, sweepHappyUploads } from "./sweepHappyUploads.js";

export { HappyIntegrationRequestError, type HappyIntegrationListener } from "./HappyConnection.js";

/** One feature owns the standalone connection or all personal team connections. */
export class HappyModule extends HappyConnection implements AgentModule<AnyAgentTool> {
    readonly name = "happy";
    // Every store numbers its migrations from one module-wide sequence, applied in that order.
    readonly migrations = [
        ...happySyncMigrations,
        ...happyIntegrationMigrations,
        ...happyProjectSyncMigrations,
    ].sort(([left], [right]) => left.localeCompare(right));
    readonly #team: TeamModule;
    readonly #files: ProjectFilesModule;
    readonly #createConnection: (user: TeamUser) => HappyConnection;
    readonly #connections = new Map<
        string,
        { connection: HappyConnection; ready: Promise<void> }
    >();
    readonly #listeners = new Set<HappyIntegrationListener>();
    #context: Context | undefined;
    #agents: AgentSystemRef<LibSQLDatabase> | undefined;
    #closed = false;
    #uploadsTimer: NodeJS.Timeout | undefined;
    #uploadsSweep: Promise<void> | undefined;

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
        bots: BotsModule,
        team: TeamModule,
        files: ProjectFilesModule,
        artifacts: ArtifactsModule,
        tasks: TasksModule,
        surfaces: SurfacesModule,
        runners: RunnersModule,
    ) {
        super(
            config,
            compute,
            events,
            git,
            history,
            projects,
            providerUsage,
            scheduling,
            userInput,
            workspaces,
            bots,
            files,
            artifacts,
            tasks,
            surfaces,
            runners,
        );
        this.#team = team;
        this.#files = files;
        this.#createConnection = (user) =>
            new HappyConnection(
                config,
                compute,
                events,
                git,
                history,
                projects,
                providerUsage,
                scheduling,
                userInput,
                workspaces,
                bots,
                files,
                artifacts,
                tasks,
                surfaces,
                runners,
                team,
                user,
            );
        events.observe({
            onEvent: async (ctx, event) => {
                if (!this.#team.enabled) return await this.eventsListener.onEvent?.(ctx, event);
                for (const { connection } of this.#connections.values()) {
                    await connection.eventsListener.onEvent?.(ctx, event);
                }
            },
            onEventTransactional: async (ctx, event) => {
                if (!this.#team.enabled)
                    return await this.eventsListener.onEventTransactional?.(ctx, event);
                // All durable projections participate in the original event's transaction.
                for (const { connection } of this.#connections.values()) {
                    await connection.eventsListener.onEventTransactional?.(ctx, event);
                }
            },
        });
    }

    readonly beforeStart = (
        ctx: Context,
        agents: AgentSystemRef<LibSQLDatabase>,
    ): AgentModuleHooks => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Happy requires its agent database.");
        // Attachments are kept once per installation, whichever connection saved them.
        const uploads = withAgentDatabase(detach(ctx).named("happy-uploads-retention"), database);
        const hooks = this.#startConnections(ctx, agents, database);
        return {
            ...hooks,
            afterStart: async (startedCtx, startedAgents) => {
                this.#retainUploads(uploads);
                await hooks.afterStart?.(startedCtx, startedAgents);
            },
        };
    };

    #startConnections(
        ctx: Context,
        agents: AgentSystemRef<LibSQLDatabase>,
        database: NonNullable<ReturnType<typeof agentDatabase>>,
    ): AgentModuleHooks {
        if (!this.#team.enabled) return this.start(ctx, agents);
        this.#context = withAgentDatabase(
            detach(ctx).named("personal-mobile-connections"),
            database,
        );
        this.#agents = agents;
        return {
            afterStart: async () => {
                const users = await this.#team.listMembers(this.#context!);
                await Promise.all(
                    users.map(async (user) => {
                        await this.#personalConnection(user);
                    }),
                );
            },
        };
    }

    /**
     * Looks for attachments past their retention now and every interval after, off the start
     * path; a look still running when the next is due is not doubled.
     */
    #retainUploads(ctx: Context): void {
        if (this.#closed || this.#uploadsTimer !== undefined) return;
        const sweep = () => {
            if (this.#closed || this.#uploadsSweep !== undefined) return;
            this.#uploadsSweep = sweepHappyUploads(ctx, this.#files, Date.now(), () => this.#closed)
                .catch((error: unknown) => {
                    ctx.log.debug(
                        "Attachments past their retention could not be looked for.",
                        {},
                        error,
                    );
                })
                .finally(() => {
                    this.#uploadsSweep = undefined;
                });
        };
        this.#uploadsTimer = setInterval(sweep, HAPPY_UPLOADS_SWEEP_INTERVAL_MS);
        this.#uploadsTimer.unref();
        sweep();
    }

    override onIntegrationUpdated(listener: HappyIntegrationListener): () => void {
        const unsubscribe = super.onIntegrationUpdated(listener);
        this.#listeners.add(listener);
        return () => {
            unsubscribe();
            this.#listeners.delete(listener);
        };
    }

    override async integration(ctx: Context): Promise<HappyIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).integration(ctx)
            : super.integration(ctx);
    }
    override async startIntegration(ctx: Context): Promise<HappyIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).startIntegration(ctx)
            : super.startIntegration(ctx);
    }
    override async cancelIntegration(ctx: Context): Promise<HappyIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).cancelIntegration(ctx)
            : super.cancelIntegration(ctx);
    }
    override async disconnectIntegration(ctx: Context): Promise<HappyIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).disconnectIntegration(ctx)
            : super.disconnectIntegration(ctx);
    }
    override async rePairIntegration(ctx: Context): Promise<HappyIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).rePairIntegration(ctx)
            : super.rePairIntegration(ctx);
    }
    override async settle(): Promise<void> {
        await super.settle();
        await this.#uploadsSweep;
        await Promise.all(
            [...this.#connections.values()].map(async ({ connection, ready }) => {
                await ready;
                await connection.settle();
            }),
        );
    }
    override async stop(): Promise<void> {
        this.#closed = true;
        if (this.#uploadsTimer !== undefined) clearInterval(this.#uploadsTimer);
        this.#uploadsTimer = undefined;
        await Promise.all([
            this.#uploadsSweep,
            super.stop(),
            ...[...this.#connections.values()].map(async ({ connection, ready }) => {
                await ready.catch(() => undefined);
                await connection.stop();
            }),
        ]);
        this.#connections.clear();
    }

    async #currentConnection(ctx: Context): Promise<HappyConnection> {
        const user = await this.#team.currentUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return await this.#personalConnection(user);
    }

    async #personalConnection(user: TeamUser): Promise<HappyConnection> {
        if (this.#closed || this.#context === undefined || this.#agents === undefined) {
            throw new Error("Happy mobile connections are not running.");
        }
        let entry = this.#connections.get(user.id);
        if (entry === undefined) {
            const connection = this.#createConnection(user);
            connection.onIntegrationUpdated(async (ctx, integration, ownerId) => {
                for (const listener of this.#listeners) await listener(ctx, integration, ownerId);
            });
            const hooks = connection.start(this.#context, this.#agents);
            const ready = Promise.resolve().then(async () => {
                await hooks.afterStart?.(this.#context!, this.#agents!);
            });
            entry = { connection, ready };
            this.#connections.set(user.id, entry);
            void ready.catch(() => undefined);
        }
        await entry.ready;
        return entry.connection;
    }
}
