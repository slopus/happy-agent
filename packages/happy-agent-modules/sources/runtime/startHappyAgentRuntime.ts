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
    GracefulShutdown,
    withLogContext,
    withLifetime,
    withShutdown,
    type Context,
    type GracefulShutdownReport,
    type RootContext,
} from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { AbortModule } from "../abort/index.js";
import { ApiModule } from "../api/index.js";
import { AutoModule } from "../auto/index.js";
import { BotsModule } from "../bots/index.js";
import { CollaborationModule } from "../collaboration/index.js";
import { CompactionsModule } from "../compactions/index.js";
import { CloudModule } from "../cloud/index.js";
import { ComputeModule, createComputeModules, type HostCompute } from "../compute/index.js";
import {
    ConfigModule,
    type ConfigInferenceFactory,
    type ConfigInferenceOverride,
    type HappyAgentConfiguration,
} from "../config/index.js";
import { ContextWindowModule } from "../contextWindow/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { EventsModule } from "../events/index.js";
import { ProjectFilesModule } from "../files/index.js";
import { GitModule } from "../git/index.js";
import { GoalModule } from "../goal/index.js";
import { HappyModule } from "../happy/index.js";
import { HistoryModule } from "../history/index.js";
import { ImageGenerationModule } from "../imageGeneration/index.js";
import { MenuBarModule } from "../menuBar/index.js";
import { McpModule } from "../mcp/index.js";
import { ModelSwitchModule } from "../modelSwitch/ModelSwitchModule.js";
import { MurmurModule } from "../murmur/index.js";
import { ObservationModule } from "../observation/index.js";
import { PermissionsModule } from "../permissions/index.js";
import { PresenceModule } from "../presence/index.js";
import { ProfileModule } from "../profile/index.js";
import { ProjectsModule } from "../projects/index.js";
import { ProviderUsageModule } from "../providerUsage/index.js";
import { ProviderScanModule } from "../providerScan/index.js";
import { SchedulingModule } from "../scheduling/index.js";
import { SearchModule } from "../search/index.js";
import { SecretsModule } from "../secrets/index.js";
import { SlashCommandsModule } from "../slashCommands/index.js";
import { SkillsModule } from "../skills/index.js";
import { SystemPromptModule } from "../systemPrompt/index.js";
import { TasksModule } from "../tasks/index.js";
import { TerminalsModule } from "../terminals/index.js";
import { TitlesModule } from "../titles/index.js";
import { ToolDiscoveryModule } from "../toolDiscovery/index.js";
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
type ShutdownHandler = (ctx: Context) => Promise<void> | void;

interface RuntimeShutdownTask {
    readonly name: string;
    run(ctx: Context): Promise<void>;
}

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
    readonly bots: BotsModule;
    readonly collaboration: CollaborationModule;
    readonly cloud: CloudModule;
    readonly compactions: CompactionsModule;
    readonly compute: ComputeModule;
    readonly config: ConfigModule;
    readonly contextWindow: ContextWindowModule;
    readonly durableFunctions: DurableFunctionsModule;
    readonly events: EventsModule;
    readonly files: ProjectFilesModule;
    readonly goal: GoalModule;
    readonly happy: HappyModule;
    readonly history: HistoryModule;
    readonly imageGeneration: ImageGenerationModule;
    readonly installation: InstallationModule;
    readonly menuBar: MenuBarModule;
    readonly mcp: McpModule;
    readonly modelSwitch: ModelSwitchModule;
    readonly murmur: MurmurModule<LibSQLDatabase>;
    readonly observation: ObservationModule;
    readonly permissions: PermissionsModule;
    readonly presence: PresenceModule;
    readonly profile: ProfileModule<LibSQLDatabase>;
    readonly projects: ProjectsModule;
    readonly providerUsage: ProviderUsageModule;
    readonly providerScan: ProviderScanModule;
    readonly scheduling: SchedulingModule;
    readonly search: SearchModule;
    readonly secrets: SecretsModule;
    readonly slashCommands: SlashCommandsModule;
    readonly skills: SkillsModule;
    readonly systemPrompt: SystemPromptModule;
    readonly tasks: TasksModule;
    readonly terminals: TerminalsModule;
    readonly titles: TitlesModule;
    readonly toolDiscovery: ToolDiscoveryModule;
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
    /** Stop main work and then private permission reviews at their next durable edges. */
    drain(): Promise<void>;
    /** Begin the named stdlib shutdown while transports remain available. */
    shutdown(): Promise<GracefulShutdownReport>;
    /** Finish shutdown and dispose the API after its transport has closed. */
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
    const coordinator = new GracefulShutdown();
    const ctx = withShutdown(observation.install(createRootContext()), coordinator);
    try {
        await config.ensureUserConfigurationFiles();
    } catch (error: unknown) {
        // Starter files are a convenience; a read-only home must not keep the daemon down.
        ctx.log.warn("Could not create the user's starter configuration files.", {}, error);
    }
    const shutdownTasks = new Map<string, RuntimeShutdownTask>();
    const registerShutdown = (name: string, handler: ShutdownHandler): RuntimeShutdownTask =>
        registerRuntimeShutdownTask(coordinator, shutdownTasks, name, handler);
    let api: ApiModule | undefined;
    let auto: AutoModule | undefined;
    let system: AgentSystemLocal<LibSQLDatabase> | undefined;
    let closed = false;
    let shuttingDown: Promise<GracefulShutdownReport> | undefined;
    let closing: Promise<void> | undefined;
    const backgroundTasks = new Map<Promise<void>, string>();
    registerShutdown("background", async (shutdownCtx) => {
        if (backgroundTasks.size === 0) return;
        const names = [...backgroundTasks.values()].slice(0, 8).join(",");
        shutdownCtx.log.info(
            `daemon:shutdown:background pid=${String(process.pid)} tasks=${names}${backgroundTasks.size > 8 ? ",…" : ""}`,
        );
        await Promise.allSettled(backgroundTasks.keys());
    });
    registerShutdown("providers", async (shutdownCtx) => {
        await Promise.allSettled([
            system?.close(shutdownCtx) ?? Promise.resolve(),
            auto?.close(shutdownCtx) ?? Promise.resolve(),
        ]);
        config.closeProviders();
    });
    registerShutdown("observation", async (shutdownCtx) => {
        const otherTasks = [...shutdownTasks.values()].filter(
            (task) => task.name !== "observation",
        );
        await Promise.allSettled(otherTasks.map(async (task) => await task.run(shutdownCtx)));
        await observation.close(shutdownCtx);
    });
    const shutdown = (): Promise<GracefulShutdownReport> => {
        if (shuttingDown !== undefined) return shuttingDown;
        closed = true;
        const shutdownCtx = withLogContext(ctx.named("runtime-shutdown"), {
            module: "runtime",
            pid: process.pid,
        });
        const startedAt = performance.now();
        const running = coordinator.shutdown();
        shutdownCtx.log.info(
            `daemon:shutdown:runtime:start pid=${String(process.pid)} handlers=${String(coordinator.pending().length)} backgroundTasks=${String(backgroundTasks.size)}`,
        );
        shuttingDown = running.then((report) => {
            if (report.timedOut.length > 0) {
                shutdownCtx.log.warn(
                    `daemon:shutdown:runtime:timeout pid=${String(process.pid)} waitingFor=${report.timedOut.join(",")}`,
                );
            }
            for (const failure of report.failed) {
                shutdownCtx.log.error(
                    `daemon:shutdown:runtime:failure pid=${String(process.pid)} handler=${failure.name} error=${shutdownErrorMessage(failure.error)}`,
                    {},
                    failure.error,
                );
            }
            shutdownCtx.log.info(
                `daemon:shutdown:runtime:finish pid=${String(process.pid)} durationMs=${String(Math.round(performance.now() - startedAt))}`,
            );
            return report;
        });
        return shuttingDown;
    };
    const close = (): Promise<void> => {
        if (closing !== undefined) return closing;
        closing = (async () => {
            const report = await shutdown();
            const failures = report.failed.map(({ error }) => error);
            try {
                await api?.close();
            } catch (error) {
                failures.push(error);
            }
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    "The Happy agent runtime did not close cleanly.",
                );
            }
        })();
        return closing;
    };

    try {
        await mkdir(paths.agentHome, { mode: 0o700, recursive: true });
        await chmod(paths.agentHome, 0o700);
        await config.writeRuntimeConfiguration(ctx.named("runtime-configuration"));
        try {
            await mkdir(paths.publicHome, { mode: 0o755, recursive: true });
            await mkdir(paths.generatedPath, { mode: 0o755, recursive: true });
        } catch (error: unknown) {
            // The public Happy folder is a convenience surface; an unusable one degrades the
            // features that write there but must not keep the whole daemon down.
            ctx.log.warn("Could not create the public Happy folder.", {}, error);
        }

        const providerScan = new ProviderScanModule(config);
        await providerScan.open(ctx.named("provider-startup-scan"));
        const enabledModels = config.models;
        const models = config.offeredModels;
        for (const notice of config.catalogNotices) {
            ctx.log.warn(notice, {});
        }
        const provider = enabledModels[0]?.providerId ?? models[0]?.providerId;
        if (provider === undefined) throw new Error("No provider model is configured.");
        const providers = config.providers;
        if (providers.typeOf(provider) === null) {
            throw new Error(`The configured default provider "${provider}" is unavailable.`);
        }

        const main = await openHappyAgentDatabase(paths.databasePath);
        registerShutdown("main-database", async (shutdownCtx) => {
            await system?.close(shutdownCtx);
            await settleRuntimeShutdownTasks(shutdownCtx, shutdownTasks, [
                "files",
                "cloud",
                "happy",
                "murmur",
                "projects-and-workspaces",
                "terminals",
                "titles",
            ]);
            await main.close();
        });
        await chmod(paths.databasePath, 0o600);
        const review = await openHappyAgentDatabase(paths.autoDatabasePath);
        registerShutdown("auto-database", async (shutdownCtx) => {
            await auto?.close(shutdownCtx);
            await review.close();
        });
        await chmod(paths.autoDatabasePath, 0o600);

        const runtimeLifetime = ctx.lifetime;
        if (runtimeLifetime === undefined) {
            throw new Error("The Happy Agent runtime has no graceful-shutdown lifetime.");
        }
        const runtimeRoot = withLifetime(detach(ctx), runtimeLifetime);
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
        registerShutdown("compute", async (shutdownCtx) => {
            await Promise.allSettled([
                system?.close(shutdownCtx) ?? Promise.resolve(),
                auto?.close(shutdownCtx) ?? Promise.resolve(),
            ]);
            await compute.computeModule.dispose(shutdownCtx);
        });

        const events = new EventsModule();
        const history = new HistoryModule(events);
        history.onAppend(observation.recordHistory);
        const presence = new PresenceModule(config);
        const systemPrompt = new SystemPromptModule(config, compute.computeModule);
        const autoModule = new AutoModule(
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
        auto = autoModule;

        const permissions = new PermissionsModule(compute.computeModule, autoModule);
        const abort = new AbortModule(compute.computeModule);
        const git = new GitModule(config);
        const durableFunctions = new DurableFunctionsModule();
        const projects = new ProjectsModule(config, git, abort, durableFunctions);
        const workspaces = new WorkspacesModule(config, projects, git, abort, durableFunctions);
        const bots = new BotsModule(config, abort);
        const titles = new TitlesModule(config, history, workspaces);
        const terminals = new TerminalsModule(projects, workspaces, bots);
        registerShutdown("terminals", async () => await terminals.close());
        const files = new ProjectFilesModule(projects, workspaces, git, bots);
        registerShutdown("files", async () => await files.close());

        const profile = new ProfileModule<LibSQLDatabase>();
        const murmur = new MurmurModule<LibSQLDatabase>(profile);
        const collaboration = new CollaborationModule(config, abort);
        const scheduling = new SchedulingModule();
        const userInput = new UserInputModule(presence);
        const mcp = new McpModule(config, userInput, workspaces);
        registerShutdown("mcp", async () => await mcp.close());
        userInput.onEventTransactional(async (listenerCtx, event) => {
            if (event.type !== "user_input_answered") return;
            if (event.actingAgentId !== event.request.askingAgentId) return;
            await autoModule
                .recordUserInputEventTransactional(listenerCtx, {
                    type: "user_input_answered",
                    agentId: event.request.askingAgentId,
                    requestId: event.requestId,
                    answer: JSON.stringify(event.request.answers ?? event.request.answer),
                })
                .catch(() => undefined);
        });

        const installation = new InstallationModule(projects);
        const cloud = new CloudModule(durableFunctions, profile);
        const providerUsage = new ProviderUsageModule(config);
        registerShutdown("provider-usage", async () => await providerUsage.close());
        const happy = new HappyModule(
            config,
            compute.computeModule,
            events,
            git,
            history,
            projects,
            providerUsage,
            scheduling,
            userInput,
            workspaces,
        );
        const goal = new GoalModule();
        const imageGeneration = new ImageGenerationModule(config);
        const menuBar = new MenuBarModule(config);
        registerShutdown("menu-bar", async () => await menuBar.close());
        const modelSwitch = new ModelSwitchModule(history);
        const toolDiscovery = new ToolDiscoveryModule();
        const search = new SearchModule(config);
        const secrets = new SecretsModule();
        const tasks = new TasksModule();
        const usage = new UsageModule(events);
        const compactions = new CompactionsModule(events, usage, history);
        const slashCommands = new SlashCommandsModule(events, compactions, compute.skillsModule);
        const contextWindow = new ContextWindowModule(config);
        const workflows = new WorkflowsModule(config, collaboration, compute.computeModule);
        const apiModule = new ApiModule(
            abort,
            config,
            events,
            cloud,
            compactions,
            bots,
            projects,
            workspaces,
            terminals,
            files,
            git,
            history,
            permissions,
            userInput,
            usage,
            providerUsage,
            providerScan,
            happy,
            profile,
            murmur,
            compute.computeModule,
            slashCommands,
        );
        api = apiModule;

        const modules: HappyAgentRuntimeModules = {
            abort,
            api: apiModule,
            auto: autoModule,
            bots,
            collaboration,
            cloud,
            compactions,
            compute: compute.computeModule,
            config,
            contextWindow,
            durableFunctions,
            events,
            files,
            goal,
            happy,
            history,
            imageGeneration,
            installation,
            menuBar,
            mcp,
            modelSwitch,
            murmur,
            observation,
            permissions,
            presence,
            profile,
            projects,
            providerScan,
            providerUsage,
            scheduling,
            search,
            secrets,
            slashCommands,
            skills: compute.skillsModule,
            systemPrompt,
            tasks,
            terminals,
            titles,
            toolDiscovery,
            usage,
            userInput,
            workflows,
            workspaces,
        };

        const ordered: AgentModule<AnyAgentTool, LibSQLDatabase>[] = [
            // API must subscribe before any later module restores state or emits an event.
            apiModule,
            abort,
            cloud,
            config,
            providerScan,
            observation,
            systemPrompt,
            toolDiscovery,
            history,
            modelSwitch,
            permissions,
            autoModule,
            presence,
            goal,
            tasks,
            usage,
            providerUsage,
            events,
            compactions,
            slashCommands,
            contextWindow,
            profile,
            murmur,
            git,
            durableFunctions,
            bots,
            projects,
            titles,
            workspaces,
            files,
            secrets,
            collaboration,
            workflows,
            scheduling,
            userInput,
            mcp,
            search,
            imageGeneration,
            compute.skillsModule,
            compute.computeModule,
            happy,
            installation,
            menuBar,
        ]
            .map(checkModuleToolParameters)
            .map(instrumentModuleLogging);

        await apiModule.prepare();
        await options.onPrepared?.({
            api: apiModule,
            configuration,
            context: (name) => withDatabase(ctx.named(name)),
        });

        const storage = new AgentStorage({
            acquireLock: async () => await acquireHappyAgentStorageLock(paths.agentLockPath),
            database: main.database,
        });
        const agentSystem = await AgentSystemLocal.create(ctx.named("agent-system"), storage, {
            models,
            modules: ordered,
            provider,
            providers,
            sendMode: "all",
            shutdownName: "agent-system",
            steeringMode: "all",
        });
        system = agentSystem;
        let mainDraining: Promise<void> | undefined;
        const drainMain = (): Promise<void> => {
            mainDraining ??= agentSystem.drain();
            return mainDraining;
        };
        let draining: Promise<void> | undefined;
        const drain = (): Promise<void> => {
            draining ??= (async () => {
                // A main tool may be waiting on an auto review. Keep reviewers operational until
                // every main inference/tool batch has reached its edge, then drain reviewers.
                await drainMain();
                await autoModule.drain();
            })();
            return draining;
        };
        apiModule.onDrain("agent-system", {
            start: drainMain,
            progress: () => agentSystem.drainProgress(),
        });
        apiModule.onDrain("auto-agent-system", {
            start: drain,
            progress: () => autoModule.drainProgress(),
        });
        registerShutdown("titles", async () => await titles.close());
        registerShutdown("cloud", async () => await cloud.stop());
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
            durableFunctions.stop();
            git.dispose();
            await workspaces.close(withDatabase(ctx));
        });
        if (configuration.values.features.workspaces) {
            await workspaces.open(withDatabase(ctx));
        }

        profile.open(installation.epoch);
        registerShutdown("murmur", async () => await murmur.close(withDatabase(ctx)));
        await murmur.open(withDatabase(ctx));

        await apiModule.markReady();

        return {
            api: apiModule,
            background,
            close,
            configuration,
            ctx,
            database: main.database,
            drain,
            git,
            installation: {
                epoch: installation.epoch,
                schemaVersion: installation.schemaVersion,
            },
            get models() {
                return config.models;
            },
            modules,
            provider,
            providers,
            shutdown,
            storage,
            system: agentSystem,
        };
    } catch (error) {
        await close().catch(() => undefined);
        throw error;
    }
}

function registerRuntimeShutdownTask(
    coordinator: GracefulShutdown,
    tasks: Map<string, RuntimeShutdownTask>,
    name: string,
    handler: ShutdownHandler,
): RuntimeShutdownTask {
    if (tasks.has(name)) {
        throw new Error(`The runtime already has a shutdown handler named "${name}".`);
    }
    let running: Promise<void> | undefined;
    const task: RuntimeShutdownTask = {
        name,
        run: (ctx) => {
            running ??= runRuntimeShutdownStep(ctx, name, handler);
            return running;
        },
    };
    tasks.set(name, task);
    coordinator.register(name, async (ctx) => await task.run(ctx));
    return task;
}

async function settleRuntimeShutdownTasks(
    ctx: Context,
    tasks: ReadonlyMap<string, RuntimeShutdownTask>,
    names: readonly string[],
): Promise<void> {
    await Promise.allSettled(
        names.flatMap((name) => {
            const task = tasks.get(name);
            return task === undefined ? [] : [task.run(ctx)];
        }),
    );
}

async function runRuntimeShutdownStep(
    ctx: Context,
    step: string,
    handler: ShutdownHandler,
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
        await handler(ctx);
        ctx.log.info(
            `daemon:shutdown:step:finish pid=${String(process.pid)} step=${step} durationMs=${String(Math.round(performance.now() - startedAt))}`,
        );
    } catch (error) {
        ctx.log.error(
            `daemon:shutdown:step:fail pid=${String(process.pid)} step=${step} durationMs=${String(Math.round(performance.now() - startedAt))} error=${shutdownErrorMessage(error)}`,
            {},
            error,
        );
        throw error;
    } finally {
        clearTimeout(slow);
    }
}

function shutdownErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message.replaceAll(/\s+/g, " ") : String(error);
}
