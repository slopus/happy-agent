import { chmod, mkdir } from "node:fs/promises";

import {
    AgentStorage,
    AgentSystemLocal,
    withAgentDatabase,
    type AgentModel,
    type AgentModule,
    type AgentProviders,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Compute, HostComputeConfig } from "@slopus/happy-agent-compute";
import {
    createRootContext,
    detach,
    withLogContext,
    withLifetime,
    type Context,
    type RootContext,
} from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { AbortModule } from "../abort/index.js";
import { ApiModule } from "../api/index.js";
import { AutoModule } from "../auto/index.js";
import { CollaborationModule } from "../collaboration/index.js";
import { CompactionsModule } from "../compactions/index.js";
import { ComputeModule, createComputeModules, type HostCompute } from "../compute/index.js";
import {
    ConfigModule,
    type ConfigInferenceFactory,
    type ConfigInferenceOverride,
    type HappyAgentConfiguration,
} from "../config/index.js";
import { ContextWindowModule } from "../contextWindow/index.js";
import { EventsModule } from "../events/index.js";
import { ProjectFilesModule } from "../files/index.js";
import { GitModule } from "../git/index.js";
import { GoalModule } from "../goal/index.js";
import { HappyModule } from "../happy/index.js";
import { HistoryModule } from "../history/index.js";
import { ImageGenerationModule } from "../imageGeneration/index.js";
import { ModelSwitchModule } from "../modelSwitch/ModelSwitchModule.js";
import { MurmurModule } from "../murmur/index.js";
import { ObservationModule } from "../observation/index.js";
import { PermissionsModule } from "../permissions/index.js";
import { PresenceModule } from "../presence/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProjectsModule } from "../projects/index.js";
import { SchedulingModule } from "../scheduling/index.js";
import { SearchModule } from "../search/index.js";
import { SecretsModule } from "../secrets/index.js";
import { SkillsModule } from "../skills/index.js";
import { SystemPromptModule } from "../systemPrompt/index.js";
import { TasksModule } from "../tasks/index.js";
import { TerminalsModule } from "../terminals/index.js";
import { TitlesModule } from "../titles/index.js";
import { UsageModule } from "../usage/index.js";
import { UserInputModule } from "../userInput/index.js";
import { WorkflowsModule } from "../workflows/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { checkModuleToolParameters } from "./checkModuleToolParameters.js";
import { openHappyAgentDatabase } from "./HappyAgentDatabase.js";
import { acquireHappyAgentStorageLock } from "./HappyAgentStorageLock.js";
import { InstallationModule } from "./InstallationModule.js";
import { instrumentModuleLogging } from "./instrumentModuleLogging.js";

const SLOW_SHUTDOWN_STEP_MS = 1_000;
type ShutdownHandler = () => Promise<void> | void;

/** The only runtime inputs not owned by configuration. Product startup supplies only version. */
export interface StartHappyAgentRuntimeOptions {
    /** Happy's private root. Defaults to `~/.happy`. */
    readonly happyHome?: string;
    /** Human-readable version this process reports. */
    readonly version?: string;
    /**
     * Test-only inference replacement: a fixed catalog, or a factory that reroutes the catalog
     * the configuration enables on its own.
     */
    readonly inference?: ConfigInferenceOverride | ConfigInferenceFactory;
    /** Test-only machine replacement. */
    readonly compute?: (ctx: Context, config: HostComputeConfig) => Promise<Compute>;
    /** Test-owned environment overrides consumed only by the config module. */
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    /**
     * Called after the API exists but before agents restore.
     *
     * The executable binds its Unix socket here so health can report `starting` throughout the
     * AgentSystem startup pass. Runtime composition and ownership stay in this package.
     */
    readonly onPrepared?: (prepared: PreparedHappyAgentRuntime) => Promise<void> | void;
}

export interface PreparedHappyAgentRuntime {
    readonly api: ApiModule;
    readonly configuration: HappyAgentConfiguration;
    /** Create a database-scoped context for one independently owned socket operation. */
    context(name: string): Context;
}

/** Every capability in the runtime, addressable by its owning module. */
export interface HappyAgentRuntimeModules {
    readonly abort: AbortModule;
    readonly api: ApiModule;
    readonly auto: AutoModule;
    readonly collaboration: CollaborationModule;
    readonly compactions: CompactionsModule;
    readonly compute: ComputeModule;
    readonly config: ConfigModule;
    readonly contextWindow: ContextWindowModule;
    readonly events: EventsModule;
    readonly files: ProjectFilesModule;
    readonly goal: GoalModule;
    readonly happy: HappyModule;
    readonly history: HistoryModule;
    readonly imageGeneration: ImageGenerationModule;
    readonly installation: InstallationModule;
    readonly modelSwitch: ModelSwitchModule;
    readonly murmur: MurmurModule<LibSQLDatabase>;
    readonly observation: ObservationModule;
    readonly permissions: PermissionsModule;
    readonly presence: PresenceModule;
    readonly profile: ProfileModule<LibSQLDatabase>;
    readonly projects: ProjectsModule;
    readonly scheduling: SchedulingModule;
    readonly search: SearchModule;
    readonly secrets: SecretsModule;
    readonly skills: SkillsModule;
    readonly systemPrompt: SystemPromptModule;
    readonly tasks: TasksModule;
    readonly terminals: TerminalsModule;
    readonly titles: TitlesModule;
    readonly usage: UsageModule;
    readonly userInput: UserInputModule;
    readonly workflows: WorkflowsModule;
    readonly workspaces: WorkspacesModule;
}

export interface HappyAgentRuntime {
    readonly api: ApiModule;
    readonly ctx: RootContext;
    readonly configuration: HappyAgentConfiguration;
    readonly provider: string;
    readonly providers: AgentProviders;
    readonly models: readonly AgentModel[];
    readonly database: LibSQLDatabase;
    readonly storage: AgentStorage<LibSQLDatabase>;
    readonly system: AgentSystemLocal<LibSQLDatabase>;
    readonly modules: HappyAgentRuntimeModules;
    readonly git: GitModule;
    readonly installation: {
        readonly epoch: string;
        readonly schemaVersion: number;
    };
    readonly background: (name: string, work: (ctx: Context) => Promise<void>) => void;
    close(): Promise<void>;
}

/** Start the databases, modules, agent system, and API that make up one local Happy runtime. */
export async function startHappyAgentRuntime(
    options: StartHappyAgentRuntimeOptions = {},
): Promise<HappyAgentRuntime> {
    const config = await ConfigModule.load(options.happyHome, {
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.inference === undefined ? {} : { inference: options.inference }),
        ...(options.version === undefined ? {} : { version: options.version }),
    });
    const configuration = config.configuration;
    const paths = configuration.paths;
    const observation = await ObservationModule.start(config);
    const ctx = observation.install(createRootContext());
    const shutdownController = new AbortController();
    try {
        await config.ensureUserConfigurationFiles();
    } catch (error: unknown) {
        // Starter files are a convenience; a read-only home must not keep the daemon down.
        ctx.log.warn("Could not create the user's starter configuration files.", {}, error);
    }
    const shutdownHandlers = new Map<string, ShutdownHandler>();
    const registerShutdown = (name: string, handler: ShutdownHandler): void => {
        if (shutdownHandlers.has(name)) {
            throw new Error(`The runtime already has a shutdown handler named "${name}".`);
        }
        shutdownHandlers.set(name, handler);
    };
    registerShutdown("observation", async () => await observation.close(ctx));
    let closed = false;
    let closing: Promise<void> | undefined;
    const backgroundTasks = new Map<Promise<void>, string>();
    const close = (): Promise<void> => {
        if (closing !== undefined) return closing;
        closed = true;
        closing = (async () => {
            const shutdownCtx = withLogContext(ctx.named("runtime-shutdown"), {
                module: "runtime",
                pid: process.pid,
            });
            const startedAt = performance.now();
            shutdownCtx.log.info(
                `daemon:shutdown:runtime:start pid=${String(process.pid)} steps=${String(shutdownHandlers.size)} backgroundTasks=${String(backgroundTasks.size)}`,
            );
            config.closeProviders();
            shutdownController.abort(new Error("The Happy Agent runtime is shutting down."));
            shutdownCtx.log.info(`daemon:shutdown:providers:abort pid=${String(process.pid)}`);
            const failures: unknown[] = [];
            if (backgroundTasks.size > 0) {
                const names = [...backgroundTasks.values()].slice(0, 8).join(",");
                shutdownCtx.log.info(
                    `daemon:shutdown:background pid=${String(process.pid)} tasks=${names}${backgroundTasks.size > 8 ? ",…" : ""}`,
                );
                await runRuntimeShutdownStep(
                    shutdownCtx,
                    "background",
                    async () => {
                        await Promise.allSettled(backgroundTasks.keys());
                    },
                    failures,
                );
            }
            for (const [name, handler] of [...shutdownHandlers.entries()].reverse()) {
                await runRuntimeShutdownStep(shutdownCtx, name, handler, failures);
            }
            shutdownHandlers.clear();
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    "The Happy agent runtime did not close cleanly.",
                );
            }
            shutdownCtx.log.info(
                `daemon:shutdown:runtime:finish pid=${String(process.pid)} durationMs=${String(Math.round(performance.now() - startedAt))}`,
            );
        })();
        return closing;
    };

    try {
        await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
        await chmod(paths.agentHome, 0o700);
        try {
            await mkdir(paths.publicHome, { mode: 0o755, recursive: true });
            await mkdir(paths.generatedPath, { mode: 0o755, recursive: true });
        } catch (error: unknown) {
            // The public Happy folder is a convenience surface; an unusable one degrades the
            // features that write there but must not keep the whole daemon down.
            ctx.log.warn("Could not create the public Happy folder.", {}, error);
        }

        const models = config.models;
        for (const notice of config.catalogNotices) {
            ctx.log.warn(notice, {});
        }
        const provider = models[0]?.providerId;
        if (provider === undefined) throw new Error("No model is enabled by the configuration.");
        const providers = config.providers;
        if (providers.typeOf(provider) === null) {
            throw new Error(`The configured default provider "${provider}" is not enabled.`);
        }

        const main = await openHappyAgentDatabase(paths.databasePath);
        registerShutdown("main-database", () => main.close());
        await chmod(paths.databasePath, 0o600);
        const review = await openHappyAgentDatabase(paths.autoDatabasePath);
        registerShutdown("auto-database", () => review.close());
        await chmod(paths.autoDatabasePath, 0o600);

        const runtimeRoot = withLifetime(detach(ctx), shutdownController.signal);
        const withDatabase = (target: Context): Context => withAgentDatabase(target, main.database);
        const background = (name: string, work: (workerCtx: Context) => Promise<void>): void => {
            if (closed) return;
            const task = work(withDatabase(runtimeRoot.named(name)))
                .catch((error: unknown) => {
                    ctx.log.warn(`Background work "${name}" failed.`, {}, error);
                })
                .finally(() => {
                    backgroundTasks.delete(task);
                });
            backgroundTasks.set(task, name);
        };

        const suppliedCompute = options.compute;
        const computeModule =
            suppliedCompute === undefined
                ? new ComputeModule(config)
                : ComputeModule.withProvider(config, {
                      id: "host",
                      create: async (computeCtx: Context, computeConfig: HostComputeConfig) =>
                          (await suppliedCompute(computeCtx, computeConfig)) as HostCompute,
                  });
        const compute = createComputeModules(computeModule);
        registerShutdown("compute", async () => await compute.computeModule.dispose(ctx));

        const events = new EventsModule();
        const history = new HistoryModule(events);
        history.onAppend(observation.recordHistory);
        const presence = new PresenceModule(config);
        const systemPrompt = new SystemPromptModule(config, compute.computeModule);
        const auto = new AutoModule(
            config,
            compute.computeModule,
            systemPrompt,
            new AgentStorage({
                acquireLock: async () => {
                    try {
                        return await acquireHappyAgentStorageLock(paths.autoAgentLockPath);
                    } catch (error: unknown) {
                        throw new Error(
                            "Auto mode cannot start because the automatic permission reviewer " +
                                "store is already in use by another process.",
                            { cause: error },
                        );
                    }
                },
                database: review.database,
            }),
        );
        registerShutdown("auto", async () => await auto.close(ctx));

        const permissions = new PermissionsModule(compute.computeModule, auto);
        const git = new GitModule(config);
        const projects = new ProjectsModule(config, git);
        const workspaces = new WorkspacesModule(config, projects, git);
        const titles = new TitlesModule(config, history, workspaces);
        const terminals = new TerminalsModule(projects, workspaces);
        registerShutdown("terminals", async () => await terminals.close());
        const files = new ProjectFilesModule(projects, workspaces, git);
        registerShutdown("files", async () => await files.close());

        const profile = new ProfileModule<LibSQLDatabase>();
        const murmur = new MurmurModule<LibSQLDatabase>(config, profile);
        const abort = new AbortModule(compute.computeModule);
        const collaboration = new CollaborationModule(abort);
        const scheduling = new SchedulingModule();
        const userInput = new UserInputModule(presence);
        userInput.onEventTransactional(async (listenerCtx, event) => {
            if (event.type !== "user_input_answered") return;
            if (event.actingAgentId !== event.request.askingAgentId) return;
            await auto
                .recordUserInputEventTransactional(listenerCtx, {
                    type: "user_input_answered",
                    agentId: event.request.askingAgentId,
                    requestId: event.requestId,
                    answer: JSON.stringify(event.request.answers ?? event.request.answer),
                })
                .catch(() => undefined);
        });

        const installation = new InstallationModule();
        const happy = new HappyModule(
            config,
            events,
            history,
            projects,
            scheduling,
            userInput,
            workspaces,
        );
        const goal = new GoalModule();
        const imageGeneration = new ImageGenerationModule(config);
        const modelSwitch = new ModelSwitchModule(history);
        const search = new SearchModule(config);
        const secrets = new SecretsModule();
        const tasks = new TasksModule();
        const usage = new UsageModule(events);
        const compactions = new CompactionsModule(events, usage, history);
        const contextWindow = new ContextWindowModule(config);
        const workflows = new WorkflowsModule(config, collaboration, compute.computeModule);
        const api = new ApiModule(
            abort,
            config,
            events,
            compactions,
            projects,
            workspaces,
            terminals,
            files,
            git,
            history,
            permissions,
            userInput,
            usage,
            profile,
            compute.computeModule,
        );
        registerShutdown("api", async () => await api.close());

        const modules: HappyAgentRuntimeModules = {
            abort,
            api,
            auto,
            collaboration,
            compactions,
            compute: compute.computeModule,
            config,
            contextWindow,
            events,
            files,
            goal,
            happy,
            history,
            imageGeneration,
            installation,
            modelSwitch,
            murmur,
            observation,
            permissions,
            presence,
            profile,
            projects,
            scheduling,
            search,
            secrets,
            skills: compute.skillsModule,
            systemPrompt,
            tasks,
            terminals,
            titles,
            usage,
            userInput,
            workflows,
            workspaces,
        };

        const ordered: AgentModule<AnyAgentTool, LibSQLDatabase>[] = [
            // API must subscribe before any later module restores state or emits an event.
            api,
            abort,
            config,
            observation,
            systemPrompt,
            history,
            modelSwitch,
            permissions,
            auto,
            presence,
            goal,
            tasks,
            usage,
            events,
            compactions,
            contextWindow,
            profile,
            murmur,
            git,
            projects,
            titles,
            workspaces,
            files,
            secrets,
            collaboration,
            workflows,
            scheduling,
            userInput,
            search,
            imageGeneration,
            compute.skillsModule,
            compute.computeModule,
            happy,
            installation,
        ]
            .map(checkModuleToolParameters)
            .map(instrumentModuleLogging);

        await api.prepare();
        await options.onPrepared?.({
            api,
            configuration,
            context: (name) => withDatabase(ctx.named(name)),
        });

        const storage = new AgentStorage({
            acquireLock: async () => await acquireHappyAgentStorageLock(paths.agentLockPath),
            database: main.database,
        });
        const system = await AgentSystemLocal.create(
            withLifetime(ctx.named("agent-system"), shutdownController.signal),
            storage,
            {
                models,
                modules: ordered,
                provider,
                providers,
                sendMode: "all",
                steeringMode: "all",
            },
        );
        registerShutdown("agent-system", async () => await system.close(ctx));
        registerShutdown("titles", async () => await titles.close());
        registerShutdown("active-agent-runs", async () => {
            const activeAgentIds = events.activeAgentIds();
            if (activeAgentIds.length === 0) return;
            ctx.log.info(
                `daemon:shutdown:abort-active-runs pid=${String(process.pid)} agents=${String(activeAgentIds.length)}`,
            );
            await Promise.all(
                activeAgentIds.map(
                    async (agentId) => await system.abort(withDatabase(ctx), agentId),
                ),
            );
        });
        registerShutdown("happy", async () => await happy.stop());

        git.onSnapshot(async (snapshotCtx, entity, snapshot) => {
            const factsCtx = withDatabase(snapshotCtx);
            try {
                if (entity.workspaceId === undefined) {
                    await projects.recordGitFacts(factsCtx, entity.projectId, snapshot.facts);
                } else {
                    await workspaces.recordGitFacts(factsCtx, entity.workspaceId, snapshot.facts);
                }
            } catch (error: unknown) {
                factsCtx.log.debug(
                    "Git facts from a live scan were not stored.",
                    { path: entity.path },
                    error,
                );
            }
        });
        registerShutdown("projects-and-workspaces", async () => {
            git.dispose();
            await workspaces.close(withDatabase(ctx));
            await projects.close(withDatabase(ctx));
        });
        await projects.open(withDatabase(ctx), installation.epoch);
        await workspaces.open(withDatabase(ctx));

        profile.open(installation.epoch);
        registerShutdown("murmur", async () => await murmur.close(withDatabase(ctx)));
        const person = await profile.get(withDatabase(ctx));
        await murmur.open(
            withDatabase(ctx),
            ...(person === undefined ? [] : ([person.id] as const)),
        );

        await api.markReady();

        return {
            api,
            background,
            close,
            configuration,
            ctx,
            database: main.database,
            git,
            installation: {
                epoch: installation.epoch,
                schemaVersion: installation.schemaVersion,
            },
            models,
            modules,
            provider,
            providers,
            storage,
            system,
        };
    } catch (error) {
        await close().catch(() => undefined);
        throw error;
    }
}

async function runRuntimeShutdownStep(
    ctx: Context,
    step: string,
    handler: ShutdownHandler,
    failures: unknown[],
): Promise<void> {
    const startedAt = performance.now();
    ctx.log.info(`daemon:shutdown:step:start pid=${String(process.pid)} step=${step}`);
    const slow = setTimeout(() => {
        ctx.log.warn(
            `daemon:shutdown:step:slow pid=${String(process.pid)} step=${step} durationMs=${String(SLOW_SHUTDOWN_STEP_MS)}`,
        );
    }, SLOW_SHUTDOWN_STEP_MS);
    slow.unref();
    try {
        await handler();
        ctx.log.info(
            `daemon:shutdown:step:finish pid=${String(process.pid)} step=${step} durationMs=${String(Math.round(performance.now() - startedAt))}`,
        );
    } catch (error) {
        failures.push(error);
        ctx.log.error(
            `daemon:shutdown:step:fail pid=${String(process.pid)} step=${step} durationMs=${String(Math.round(performance.now() - startedAt))} error=${shutdownErrorMessage(error)}`,
            {},
            error,
        );
    } finally {
        clearTimeout(slow);
    }
}

function shutdownErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message.replaceAll(/\s+/g, " ") : String(error);
}
