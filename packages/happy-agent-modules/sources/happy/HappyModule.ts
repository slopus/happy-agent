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

import type { BotsModule } from "../bots/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import type { EventsModule } from "../events/index.js";
import type { GitModule } from "../git/index.js";
import type { HistoryModule } from "../history/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { ProviderUsageModule } from "../providerUsage/index.js";
import type { SchedulingModule } from "../scheduling/index.js";
import { TeamAuthenticationError, type TeamModule, type TeamUser } from "../team/index.js";
import type { UserInputModule } from "../userInput/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import { HappyConnection, type HappyIntegrationListener } from "./HappyConnection.js";
import { happySyncMigrations } from "./HappySyncDatabase.js";
import { happyIntegrationMigrations } from "./HappyIntegrationDatabase.js";
import { happyProjectSyncMigrations } from "./HappyProjectSyncDatabase.js";

export { HappyIntegrationStartError, type HappyIntegrationListener } from "./HappyConnection.js";

/** One feature owns the standalone connection or all personal team connections. */
export class HappyModule extends HappyConnection implements AgentModule<AnyAgentTool> {
    readonly name = "happy";
    // Released module-wide order is 001, 002, 003. Per-store extensions come after that prefix.
    readonly migrations = [
        happySyncMigrations[0]!,
        happyIntegrationMigrations[0]!,
        happyProjectSyncMigrations[0]!,
        ...happySyncMigrations.slice(1),
        ...happyIntegrationMigrations.slice(1),
        ...happyProjectSyncMigrations.slice(1),
    ];
    readonly #team: TeamModule;
    readonly #createConnection: (user: TeamUser) => HappyConnection;
    readonly #connections = new Map<
        string,
        { connection: HappyConnection; ready: Promise<void> }
    >();
    readonly #listeners = new Set<HappyIntegrationListener>();
    #context: Context | undefined;
    #agents: AgentSystemRef<LibSQLDatabase> | undefined;
    #closed = false;

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
        );
        this.#team = team;
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
        if (!this.#team.enabled) return this.start(ctx, agents);
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Happy requires its agent database.");
        this.#context = withAgentDatabase(
            detach(ctx).named("personal-mobile-connections"),
            database,
        );
        this.#agents = agents;
        return {
            afterStart: async () => {
                const users = await this.#team.listUsers(this.#context!);
                await Promise.all(
                    users.map(async (user) => {
                        await this.#personalConnection(user);
                    }),
                );
            },
        };
    };

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
        await Promise.all(
            [...this.#connections.values()].map(async ({ connection, ready }) => {
                await ready;
                await connection.settle();
            }),
        );
    }
    override async stop(): Promise<void> {
        this.#closed = true;
        await Promise.all([
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
