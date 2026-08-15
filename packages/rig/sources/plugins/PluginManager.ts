import { join, resolve } from "node:path";
import type { Context } from "@steve.kite/stdlib";

import type Dockerode from "dockerode";
import {
    HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES,
    type HappySystemPromptHookInput,
    type HappyTracingEvent,
} from "happy-plugins";
import { errorToMessage } from "../errorToMessage.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { GeneratedMediaStore } from "../generated-media/index.js";
import { createEventIdFactory } from "../protocol/createEventIdFactory.js";
import type {
    ComputePreparationEvent,
    EventId,
    PluginLogSnapshot,
    PluginSummary,
} from "../protocol/index.js";
import type { InMemorySession } from "../session/InMemorySession.js";
import type { SessionStore } from "../session/SessionStore.js";
import type { DaemonLog } from "../server/DaemonLog.js";
import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import type {
    ManagedNetworkHttpRequest,
    ManagedNetworkInterceptor,
} from "../agent/context/ManagedNetworkPolicy.js";
import type { HappyNetworkRequestCompletion, HappyNetworkTunnel } from "happy-plugins";
import type { Skill } from "../agent/skills/Skill.js";
import { loadSkills } from "../agent/skills/loadSkills.js";
import { discoverPlugins } from "./discoverPlugins.js";
import { createPluginDockerClient } from "./createPluginDockerClient.js";
import { discoverGitHubPlugins } from "./discoverGitHubPlugins.js";
import type { GitHubFetch } from "./fetchBoundedGitHubResource.js";
import { getPluginDataDirectory } from "./getPluginDataDirectory.js";
import { getPluginsDirectory } from "./getPluginsDirectory.js";
import type {
    GitHubPluginCatalog,
    GitHubPluginInstallationSource,
    GitHubPluginSource,
} from "./githubPluginCatalog.js";
import { installGitHubPlugin } from "./installGitHubPlugin.js";
import {
    installPluginFromPath,
    toPluginFolderName,
    type InstalledPlugin,
} from "./installPluginFromPath.js";
import { comparePluginVersions } from "./comparePluginVersions.js";
import { PluginInstallationRequests } from "./PluginInstallationRequests.js";
import { PluginNotFoundError } from "./PluginNotFoundError.js";
import { readPluginManifest } from "./readPluginManifest.js";
import { PluginIconSummaryCache, readPluginIcon } from "./readPluginIcon.js";
import { PluginIconError } from "./PluginIconError.js";
import { removePluginDockerImages } from "./preparePluginDockerImage.js";
import { resolvePluginDockerImage } from "./resolvePluginDockerRuntime.js";
import type { PluginDiscovery, PluginIconResource, RegisteredPlugin } from "./types.js";
import { PluginComputeRegistry, type PluginComputeRegistryEvent } from "./PluginComputeRegistry.js";
import { PluginHookRegistry } from "./PluginHookRegistry.js";
import type { PluginMcpRegistry } from "./PluginMcpRegistry.js";
import { PluginNetworkRegistry } from "./PluginNetworkRegistry.js";
import { PluginAppRegistry, type PluginAppResource } from "./PluginAppRegistry.js";
import { boundPluginLogText, readBoundedPluginLog } from "./readBoundedPluginLog.js";
import { startPlugin, type RunningPlugin, type StartPluginOptions } from "./startPlugin.js";
import { removePluginDockerContainers } from "./startPluginDockerContainer.js";
import { DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS } from "./PluginStartupState.js";
import { formatComputePreparationNotice } from "./formatComputePreparationNotice.js";
import { withWorkerContext } from "../observability/index.js";
import type { RigAgentService } from "../agent/RigAgentService.js";

const PLUGIN_STATUS_PUBLICATION_INTERVAL_MS = 100;
const PLUGIN_PROCESS_EXIT_SETTLE_MS = 100;
const MAX_COMPUTE_SESSION_PREPARATIONS = 1_000;

export interface PluginManagerOptions {
    agents?: RigAgentService;
    appRegistry?: PluginAppRegistry;
    computeRegistry?: PluginComputeRegistry;
    daemonLog: DaemonLog;
    defaultDocker?: DockerExecutionConfig;
    directory?: string;
    docker?: Dockerode;
    dockerCleanupTimeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
    githubFetch?: GitHubFetch;
    generatedMedia?: GeneratedMediaStore;
    hookRegistry?: PluginHookRegistry;
    now?: () => number;
    mcpRegistry?: PluginMcpRegistry;
    networkRegistry?: PluginNetworkRegistry;
    listProviderUsage?: StartPluginOptions["listProviderUsage"];
    /** How a registered plugin is started. Tests replace the real sandboxed process. */
    start?: (plugin: RegisteredPlugin, options: StartPluginOptions) => Promise<RunningPlugin>;
    startupTimeoutMs?: number;
    store: SessionStore;
}

export interface UninstalledPlugin {
    dataDirectory: string;
    folder: string;
    name: string;
}

interface PluginRuntimeState {
    error?: string;
    logTruncated?: boolean;
    logPath?: string;
    status: PluginSummary["status"];
    statusMessage?: string;
    updatedAt: number;
}

interface PluginCatalog {
    failures: readonly { error: string; folder: string }[];
    plugins: readonly PluginSummary[];
    version: EventId;
}

type StatusPublicationState =
    | { status: "idle" }
    | { status: "publishing" }
    | { status: "publishing_pending" }
    | { status: "scheduled"; timer: NodeJS.Timeout };

/**
 * Owns every installed plugin's lifecycle.
 *
 * Installing and uninstalling take effect immediately: a newly installed plugin is started before
 * the call returns, and an uninstalled one is stopped before its code is removed. Each change
 * publishes the whole current set so attached clients stay in step without polling.
 */
export class PluginManager implements ManagedNetworkInterceptor {
    readonly directory: string;

    readonly #appRegistry: PluginAppRegistry;
    readonly #agents: RigAgentService | undefined;
    #catalog: { promise: Promise<PluginCatalog>; version: EventId } | undefined;
    readonly #createEventId = createEventIdFactory();
    #catalogVersion: EventId = this.#createEventId();
    readonly #computeRegistry: PluginComputeRegistry;
    readonly #computeSessionPreparation = new Map<
        string,
        {
            delivered: WeakSet<InMemorySession>;
            phase: string;
            sessions: WeakSet<InMemorySession>;
            state: ComputePreparationEvent["data"]["state"];
        }
    >();
    readonly #daemonLog: DaemonLog;
    readonly #defaultDocker: DockerExecutionConfig | undefined;
    readonly #docker: Dockerode;
    readonly #dockerCleanupTimeoutMs: number | undefined;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #githubFetch: GitHubFetch | undefined;
    readonly #generatedMedia: GeneratedMediaStore | undefined;
    readonly #hookRegistry: PluginHookRegistry;
    readonly #iconCache = new PluginIconSummaryCache();
    #discovery: { promise: Promise<PluginDiscovery>; version: EventId } | undefined;
    readonly #now: () => number;
    readonly #mcpRegistry: PluginMcpRegistry | undefined;
    readonly #networkRegistry: PluginNetworkRegistry;
    readonly #listProviderUsage: StartPluginOptions["listProviderUsage"];
    readonly #installationRequests = new PluginInstallationRequests();
    readonly #running = new Map<string, RunningPlugin>();
    readonly #startupGenerations = new Map<string, symbol>();
    readonly #states = new Map<string, PluginRuntimeState>();
    readonly #start: (
        plugin: RegisteredPlugin,
        options: StartPluginOptions,
    ) => Promise<RunningPlugin>;
    readonly #store: SessionStore;
    readonly #startupTimeoutMs: number;
    readonly #unsubscribeCompute: () => void;
    #statusPublication: StatusPublicationState = { status: "idle" };
    #closed = false;
    #computePublication = Promise.resolve();
    #publication = Promise.resolve();
    #started = false;

    constructor(options: PluginManagerOptions) {
        if (options.mcpRegistry === undefined && options.appRegistry === undefined) {
            throw new Error("PluginManager requires the shared MCP registry.");
        }
        this.#appRegistry = options.appRegistry ?? new PluginAppRegistry(options.mcpRegistry!);
        this.#agents = options.agents;
        this.#daemonLog = options.daemonLog;
        this.#computeRegistry =
            options.computeRegistry ??
            new PluginComputeRegistry({
                log: (level, event, message, details) =>
                    this.#daemonLog.record(level, event, message, details),
            });
        this.#unsubscribeCompute = this.#computeRegistry.subscribe((event) => {
            if (!this.#started) return undefined;
            if (event.type === "catalog_changed") {
                void withWorkerContext("plugin-catalog-change", (workerCtx) =>
                    this.#publishChanged(workerCtx),
                );
                return undefined;
            } else {
                const publish = () =>
                    withWorkerContext("plugin-compute-preparation", (workerCtx) =>
                        this.#publishComputePreparation(workerCtx, event),
                    );
                const next = this.#computePublication.then(publish, publish);
                this.#computePublication = next.catch(() => undefined);
                return next;
            }
        });
        this.#defaultDocker = options.defaultDocker;
        this.#docker = options.docker ?? createPluginDockerClient(options.defaultDocker);
        this.#dockerCleanupTimeoutMs = options.dockerCleanupTimeoutMs;
        this.#environment = options.environment ?? process.env;
        this.#githubFetch = options.githubFetch;
        this.#generatedMedia = options.generatedMedia;
        this.#hookRegistry =
            options.hookRegistry ??
            new PluginHookRegistry({
                log: (level, event, message, details) =>
                    this.#daemonLog.record(level, event, message, details),
            });
        this.#now = options.now ?? Date.now;
        this.#mcpRegistry = options.mcpRegistry;
        this.#networkRegistry =
            options.networkRegistry ??
            new PluginNetworkRegistry({
                onFailure: (failure) => {
                    this.#daemonLog.record(
                        "warning",
                        "plugin_network_interception_failed",
                        "A plugin network interception failed open to normal proxy behavior.",
                        failure,
                    );
                },
            });
        this.#listProviderUsage = options.listProviderUsage;
        this.#start = options.start ?? startPlugin;
        this.#startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_PLUGIN_STARTUP_TIMEOUT_MS;
        this.#store = options.store;
        this.directory = options.directory ?? getPluginsDirectory(this.#environment);
    }

    async start(ctx: Context): Promise<void> {
        if (this.#started) return;
        this.#started = true;
        const discovery = await ctx.span("rig.daemon.plugins.discover", () =>
            discoverPlugins(this.directory, { iconCache: this.#iconCache }),
        );
        for (const failure of discovery.failures) {
            this.#daemonLog.record(
                "error",
                "plugin_registration_failed",
                `Rig could not register the plugin in ${failure.folderName}.`,
                {
                    directory: failure.directory,
                    error: failure.error,
                    pluginFolder: failure.folderName,
                },
            );
        }
        await ctx.span("rig.daemon.plugins.activate", () =>
            Promise.all(
                discovery.plugins.map((plugin) =>
                    this.#closed
                        ? Promise.resolve()
                        : this.#startRegistered(ctx, plugin.folderName),
                ),
            ),
        );
        await ctx.span("rig.daemon.plugins.publish", () => this.#publishChanged(ctx));
    }

    /** Installs a plugin from a folder on this machine and starts it. */
    async install(
        ctx: Context,
        options: {
            fs: FileSystemContext;
            requestId?: string;
            signal?: AbortSignal;
            sourceDirectory: string;
        },
    ): Promise<InstalledPlugin> {
        this.#assertOpen();
        if (options.requestId !== undefined) {
            return this.#installationRequests.run(
                options.requestId,
                { sourceDirectory: options.sourceDirectory, type: "local-directory" },
                () => this.#installFromPath(ctx, options),
            );
        }
        return this.#installFromPath(ctx, options);
    }

    async #installFromPath(
        ctx: Context,
        options: {
            fs: FileSystemContext;
            signal?: AbortSignal;
            sourceDirectory: string;
        },
    ): Promise<InstalledPlugin> {
        const installed = await installPluginFromPath({
            docker: this.#docker,
            fs: options.fs,
            pluginsDirectory: this.directory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            sourceDirectory: options.sourceDirectory,
        });
        await this.#activateInstalled(ctx, installed);
        return installed;
    }

    /** Lists the plugins published by a GitHub repository index. */
    async discoverRepository(
        ctx: Context,
        source: GitHubPluginSource,
        signal?: AbortSignal,
    ): Promise<GitHubPluginCatalog> {
        this.#assertOpen();
        const catalog = await discoverGitHubPlugins(source, {
            ...(this.#githubFetch === undefined ? {} : { fetcher: this.#githubFetch }),
            ...(signal === undefined ? {} : { signal }),
        });
        const installed = (await this.list(ctx)).plugins;
        return {
            catalogId: catalog.catalogId,
            plugins: catalog.plugins.map((plugin) => {
                const folder = toPluginFolderName(plugin.name);
                const match = installed.find((candidate) => candidate.folder === folder);
                const availability =
                    match === undefined
                        ? ("not-installed" as const)
                        : comparePluginVersions(plugin.version, match.version) > 0
                          ? ("update-available" as const)
                          : comparePluginVersions(plugin.version, match.version) < 0
                            ? ("downgrade-available" as const)
                            : ("reinstall-available" as const);
                return {
                    availability,
                    description: plugin.description,
                    displayName: plugin.displayName,
                    ...(match === undefined
                        ? {}
                        : {
                              installed: {
                                  folder: match.folder,
                                  name: match.name,
                                  version: match.version,
                              },
                          }),
                    name: plugin.name,
                    source: {
                        catalogId: catalog.catalogId,
                        plugin,
                        ...(catalog.ref === undefined ? {} : { ref: catalog.ref }),
                        repository: catalog.repository,
                        revision: catalog.revision,
                        type: "github" as const,
                    },
                    version: plugin.version,
                };
            }),
            ...(catalog.ref === undefined ? {} : { ref: catalog.ref }),
            repository: catalog.repository,
            revision: catalog.revision,
        };
    }

    /** Installs one indexed plugin from a GitHub repository and starts it. */
    async installFromGitHub(
        ctx: Context,
        source: GitHubPluginInstallationSource,
        options: { fs: FileSystemContext; requestId?: string; signal?: AbortSignal },
    ): Promise<InstalledPlugin> {
        this.#assertOpen();
        if (options.requestId === undefined) return this.#installFromGitHub(ctx, source, options);
        return this.#installationRequests.run(options.requestId, source, () =>
            this.#installFromGitHub(ctx, source, options),
        );
    }

    async #installFromGitHub(
        ctx: Context,
        source: GitHubPluginInstallationSource,
        options: { fs: FileSystemContext; signal?: AbortSignal },
    ): Promise<InstalledPlugin> {
        const installed = await installGitHubPlugin({
            docker: this.#docker,
            ...(this.#githubFetch === undefined ? {} : { fetcher: this.#githubFetch }),
            fs: options.fs,
            pluginsDirectory: this.directory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            source,
        });
        await this.#activateInstalled(ctx, installed);
        return installed;
    }

    async #activateInstalled(ctx: Context, installed: InstalledPlugin): Promise<void> {
        // Replacing an installed plugin retires the process built from the previous code.
        await this.#stopRunning(ctx, installed.folder, true);
        await this.#startRegistered(ctx, installed.folder, { preserveLog: true });
        try {
            const plugin = await readPluginManifest(installed.directory, {
                iconCache: this.#iconCache,
            });
            if (plugin.docker !== undefined) {
                await removePluginDockerImages(installed.folder, {
                    docker: this.#docker,
                    ...(this.#dockerCleanupTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: this.#dockerCleanupTimeoutMs }),
                    ...(plugin.docker.type === "dockerfile"
                        ? { keepImage: await resolvePluginDockerImage(plugin) }
                        : {}),
                });
            }
        } catch (error) {
            this.#recordDockerCleanupFailure(installed.name, "remove superseded images", error);
        }
        await this.#publishChanged(ctx, { installation: installed });
    }

    /** Stops a plugin and removes its installed code, keeping the folder it writes to. */
    async uninstall(
        ctx: Context,
        options: {
            fs: FileSystemContext;
            name: string;
            signal?: AbortSignal;
        },
    ): Promise<UninstalledPlugin> {
        this.#assertOpen();
        options.signal?.throwIfAborted();
        const discovery = await discoverPlugins(this.directory, { iconCache: this.#iconCache });
        const wanted = options.name.trim().toLowerCase();
        const installed = discovery.plugins.find(
            (plugin) =>
                plugin.manifest.name.toLowerCase() === wanted ||
                plugin.folderName.toLowerCase() === wanted,
        );
        if (installed === undefined) {
            const known = discovery.plugins.map((plugin) => plugin.manifest.name);
            throw new PluginNotFoundError(
                known.length === 0
                    ? `No plugin named ${options.name} is installed. No plugins are installed.`
                    : `No plugin named ${options.name} is installed. Installed plugins: ${known.join(", ")}.`,
            );
        }
        options.signal?.throwIfAborted();
        await this.#stopRunning(ctx, installed.folderName);
        if (installed.docker !== undefined) {
            await Promise.all([
                removePluginDockerContainers(installed.folderName, {
                    docker: this.#docker,
                    ...(this.#dockerCleanupTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: this.#dockerCleanupTimeoutMs }),
                }).catch((error: unknown) =>
                    this.#recordDockerCleanupFailure(
                        installed.manifest.name,
                        "remove containers during uninstall",
                        error,
                    ),
                ),
                removePluginDockerImages(installed.folderName, {
                    docker: this.#docker,
                    ...(this.#dockerCleanupTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: this.#dockerCleanupTimeoutMs }),
                }).catch((error: unknown) =>
                    this.#recordDockerCleanupFailure(
                        installed.manifest.name,
                        "remove images during uninstall",
                        error,
                    ),
                ),
            ]);
        }
        await options.fs.rm(join(this.directory, installed.folderName), {
            force: true,
            recursive: true,
        });
        await this.#store.slots.removeByPluginAuthor(ctx, installed.folderName);
        this.#states.delete(installed.folderName);
        this.#daemonLog.record(
            "info",
            "plugin_uninstalled",
            `The ${installed.manifest.name} plugin was uninstalled.`,
            {
                dataDirectory: getPluginDataDirectory(installed.folderName, this.#environment),
                plugin: installed.manifest.name,
                pluginFolder: installed.folderName,
            },
        );
        await this.#publishChanged(ctx);
        return {
            dataDirectory: getPluginDataDirectory(installed.folderName, this.#environment),
            folder: installed.folderName,
            name: installed.manifest.name,
        };
    }

    /** Every installed plugin, with the ones currently running marked. */
    async list(ctx: Context): Promise<PluginCatalog> {
        for (;;) {
            const version = this.#catalogVersion;
            const cached =
                this.#catalog?.version === version
                    ? this.#catalog
                    : {
                          promise: this.#readCatalog(ctx, version),
                          version,
                      };
            this.#catalog = cached;
            let catalog: PluginCatalog;
            try {
                catalog = await cached.promise;
            } catch (error) {
                if (this.#catalog === cached) this.#catalog = undefined;
                throw error;
            }
            if (version === this.#catalogVersion) return catalog;
        }
    }

    /** Loads the normal skill catalog with contributions from active plugins. */
    async loadSkills(ctx: Context, fs: FileSystemContext): Promise<readonly Skill[]> {
        let discovery: PluginDiscovery;
        try {
            discovery = await this.#discoverCurrentPlugins(ctx);
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "plugin_skills_unreadable",
                "Rig could not read plugin skills; continuing with file skills.",
                { error: errorToMessage(error) },
            );
            return loadSkills(fs);
        }
        return loadSkills(fs, {
            additionalRoots: discovery.plugins.flatMap((plugin) =>
                this.#states.get(plugin.folderName)?.status === "running" &&
                plugin.skillsPath !== undefined
                    ? [
                          {
                              path: plugin.skillsPath,
                              source: {
                                  folder: plugin.folderName,
                                  plugin: plugin.manifest.name,
                                  type: "plugin" as const,
                              },
                          },
                      ]
                    : [],
            ),
            onInvalidSkill: (filePath, root) => {
                if (root.source.type !== "plugin") return;
                this.#daemonLog.record(
                    "warning",
                    "plugin_skill_skipped",
                    `Rig skipped an invalid skill from the ${root.source.plugin} plugin.`,
                    {
                        plugin: root.source.plugin,
                        pluginFolder: root.source.folder,
                        skillPath: filePath,
                    },
                );
            },
            onSkillCollision: ({ kept, skipped }) => {
                if (skipped.source.type !== "plugin") return;
                this.#daemonLog.record(
                    "warning",
                    "plugin_skill_name_collision",
                    `Rig skipped the ${skipped.source.plugin} plugin's ${skipped.name} skill because another skill has the same name.`,
                    {
                        keptSource:
                            kept.source.type === "file" ? "file" : `plugin: ${kept.source.plugin}`,
                        plugin: skipped.source.plugin,
                        pluginFolder: skipped.source.folder,
                        skill: skipped.name,
                    },
                );
            },
        });
    }

    /** Appends active static contributions in deterministic plugin-folder order. */
    async loadSystemPrompt(ctx: Context): Promise<string | undefined> {
        let discovery: PluginDiscovery;
        try {
            discovery = await this.#discoverCurrentPlugins(ctx);
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "plugin_system_prompts_unreadable",
                "Rig could not read plugin system prompts; continuing without them.",
                { error: errorToMessage(error) },
            );
            return undefined;
        }
        const contributions: string[] = [];
        let bytes = 0;
        for (const plugin of discovery.plugins) {
            if (
                this.#states.get(plugin.folderName)?.status !== "running" ||
                plugin.systemPrompt === undefined
            ) {
                continue;
            }
            const separatorBytes = contributions.length === 0 ? 0 : 2;
            const contributionBytes = Buffer.byteLength(plugin.systemPrompt, "utf8");
            if (bytes + separatorBytes + contributionBytes > HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES) {
                this.#daemonLog.record(
                    "warning",
                    "plugin_system_prompt_skipped",
                    `Rig skipped the ${plugin.manifest.name} plugin's system prompt because active plugin contributions reached the size limit.`,
                    {
                        plugin: plugin.manifest.name,
                        pluginFolder: plugin.folderName,
                    },
                );
                continue;
            }
            contributions.push(plugin.systemPrompt);
            bytes += separatorBytes + contributionBytes;
        }
        return contributions.length === 0 ? undefined : contributions.join("\n\n");
    }

    applySystemPrompt(ctx: Context, input: HappySystemPromptHookInput): Promise<string> {
        return this.#hookRegistry.applySystemPrompt(input);
    }

    trace(event: HappyTracingEvent): void {
        this.#hookRegistry.emit(event);
    }

    async #readCatalog(ctx: Context, version: EventId): Promise<PluginCatalog> {
        const discovery = await this.#readDiscovery(ctx, version);
        return {
            failures: discovery.failures.map((failure) => ({
                error: failure.error,
                folder: failure.folderName,
            })),
            plugins: discovery.plugins.map((plugin) => {
                const state = this.#states.get(plugin.folderName) ?? {
                    status: "stopped" as const,
                    updatedAt: this.#now(),
                };
                const compute =
                    state.status === "running"
                        ? this.#computeRegistry
                              .list()
                              .find((provider) => provider.pluginFolder === plugin.folderName)
                        : undefined;
                return {
                    apps:
                        state.status === "running" ? this.#appRegistry.list(plugin.folderName) : [],
                    ...(compute === undefined
                        ? {}
                        : {
                              compute: {
                                  health: compute.health,
                                  name: compute.name,
                                  provisioningTimeoutMs: compute.provisioningTimeoutMs,
                              },
                          }),
                    dataDirectory: getPluginDataDirectory(plugin.folderName, this.#environment),
                    author: plugin.manifest.author,
                    category: plugin.manifest.category,
                    description: plugin.manifest.description,
                    directory: plugin.directory,
                    ...(state.error === undefined ? {} : { error: state.error }),
                    folder: plugin.folderName,
                    icon: plugin.icon,
                    logAvailable: state.error !== undefined || state.logPath !== undefined,
                    name: plugin.manifest.name,
                    status: state.status,
                    ...(state.statusMessage === undefined
                        ? {}
                        : { statusMessage: state.statusMessage }),
                    version: plugin.manifest.version,
                };
            }),
            version,
        };
    }

    async #discoverCurrentPlugins(ctx: Context): Promise<PluginDiscovery> {
        for (;;) {
            const version = this.#catalogVersion;
            const discovery = await this.#readDiscovery(ctx, version);
            if (version === this.#catalogVersion) return discovery;
        }
    }

    async #readDiscovery(ctx: Context, version: EventId): Promise<PluginDiscovery> {
        const cached =
            this.#discovery?.version === version
                ? this.#discovery
                : {
                      promise: discoverPlugins(this.directory, { iconCache: this.#iconCache }),
                      version,
                  };
        this.#discovery = cached;
        try {
            return await cached.promise;
        } catch (error) {
            if (this.#discovery === cached) this.#discovery = undefined;
            throw error;
        }
    }

    /** Reads at most the current plugin log's fixed retention bound. */
    async readLog(ctx: Context, name: string): Promise<PluginLogSnapshot> {
        const discovery = await discoverPlugins(this.directory, { iconCache: this.#iconCache });
        const wanted = name.trim().toLowerCase();
        const plugin = discovery.plugins.find(
            (candidate) =>
                candidate.folderName.toLowerCase() === wanted ||
                candidate.manifest.name.toLowerCase() === wanted,
        );
        if (plugin === undefined) throw new Error(`No installed plugin is named ${name}.`);
        const state = this.#states.get(plugin.folderName) ?? {
            status: "stopped" as const,
            updatedAt: this.#now(),
        };
        const output =
            state.status === "failed"
                ? {
                      text: state.error ?? "The plugin failed to start.",
                      truncated: state.logTruncated ?? false,
                  }
                : state.logPath === undefined
                  ? { text: "", truncated: false }
                  : await readBoundedPluginLog(state.logPath);
        return {
            ...(state.error === undefined ? {} : { error: state.error }),
            folder: plugin.folderName,
            name: plugin.manifest.name,
            source: state.status === "failed" ? "error" : "current_run",
            status: state.status,
            text: output.text,
            truncated: output.truncated,
            updatedAt: state.updatedAt,
        };
    }

    readAppResource(
        applicationId: string,
        generation: string,
        resourceUri: string,
    ): PluginAppResource {
        return this.#appRegistry.readResource(applicationId, generation, resourceUri);
    }

    async readIcon(
        ctx: Context,
        folder: string,
        generation: string,
        signal?: AbortSignal,
    ): Promise<PluginIconResource> {
        signal?.throwIfAborted();
        const discovery = await this.#discoverCurrentPlugins(ctx);
        const plugin = discovery.plugins.find((candidate) => candidate.folderName === folder);
        if (plugin === undefined) {
            throw new PluginIconError(
                "plugin_not_found",
                `No installed plugin has the id ${JSON.stringify(folder)}.`,
            );
        }
        let icon: PluginIconResource;
        try {
            icon = await readPluginIcon(plugin.iconPath, signal === undefined ? {} : { signal });
        } catch (error) {
            if (signal?.aborted) throw error;
            await this.#refreshIconCatalog(ctx, plugin.iconPath);
            throw new PluginIconError("icon_unavailable", "The plugin icon is unavailable.");
        }
        if (icon.generation !== generation) {
            await this.#refreshIconCatalog(ctx, plugin.iconPath);
            throw new PluginIconError("stale_generation", "That plugin icon generation is stale.");
        }
        return icon;
    }

    async #refreshIconCatalog(ctx: Context, iconPath: string): Promise<void> {
        this.#iconCache.invalidate(iconPath);
        try {
            await this.#publishChanged(ctx);
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "plugin_icon_catalog_refresh_failed",
                "Rig could not announce a changed plugin icon.",
                { error: errorToMessage(error) },
            );
        }
    }

    callAppTool(
        _ctx: Context,
        applicationId: string,
        generation: string,
        server: string,
        tool: string,
        input: unknown,
        signal?: AbortSignal,
    ) {
        return this.#appRegistry.callTool(applicationId, generation, server, tool, input, signal);
    }

    storageGet(_ctx: Context, applicationId: string, generation: string, key: string) {
        return this.#appRegistry.storageGet(applicationId, generation, key);
    }
    storageList(_ctx: Context, applicationId: string, generation: string) {
        return this.#appRegistry.storageList(applicationId, generation);
    }
    storageSet(
        _ctx: Context,
        applicationId: string,
        generation: string,
        key: string,
        value: unknown,
    ) {
        return this.#appRegistry.storageSet(applicationId, generation, key, value);
    }
    storageDelete(_ctx: Context, applicationId: string, generation: string, key: string) {
        return this.#appRegistry.storageDelete(applicationId, generation, key);
    }

    interceptHttp(
        ctx: Context,
        request: ManagedNetworkHttpRequest,
    ): Promise<HappyNetworkRequestCompletion> {
        return this.#networkRegistry.interceptHttp(ctx, request);
    }

    observeTunnel(tunnel: HappyNetworkTunnel): void {
        this.#networkRegistry.observeTunnel(tunnel);
    }

    recordFailure(hostname: string, error: unknown): void {
        this.#networkRegistry.recordFailure(hostname, error);
    }

    shouldIntercept(hostname: string): boolean {
        return this.#networkRegistry.shouldIntercept(hostname);
    }

    async close(ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#statusPublication.status === "scheduled") {
            clearTimeout(this.#statusPublication.timer);
        }
        this.#statusPublication = { status: "idle" };
        this.#startupGenerations.clear();
        try {
            await this.#computeRegistry.close();
        } finally {
            this.#unsubscribeCompute();
        }
        await Promise.all(
            [...this.#running.values()].map((plugin) =>
                plugin.close().catch((error: unknown) => {
                    this.#daemonLog.record(
                        "warning",
                        "plugin_stop_cleanup_failed",
                        `Rig could not completely clean up the ${plugin.name} plugin while shutting down.`,
                        { error: errorToMessage(error), plugin: plugin.name },
                    );
                }),
            ),
        );
        this.#running.clear();
        this.#networkRegistry.close();
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("Rig is shutting down, so plugins cannot change now.");
    }

    async #startRegistered(
        ctx: Context,
        folderName: string,
        options: { preserveLog?: boolean } = {},
    ): Promise<void> {
        const startupGeneration = Symbol(folderName);
        this.#startupGenerations.set(folderName, startupGeneration);
        const isCurrentStartup = () =>
            this.#startupGenerations.get(folderName) === startupGeneration;
        const directory = join(this.directory, folderName);
        let name = folderName;
        let running: RunningPlugin | undefined;
        try {
            const plugin = await readPluginManifest(directory, { iconCache: this.#iconCache });
            name = plugin.manifest.name;
            if (plugin.entryPath === undefined) {
                if (this.#closed || !isCurrentStartup()) return;
                this.#states.set(folderName, {
                    status: "running",
                    updatedAt: this.#now(),
                });
                this.#daemonLog.record("info", "plugin_started", `The ${name} plugin started.`, {
                    plugin: name,
                    pluginDirectory: directory,
                });
                return;
            }
            const startupStartedAt = Date.now();
            const starting = this.#start(plugin, {
                ...(this.#agents === undefined ? {} : { agents: this.#agents }),
                appRegistry: this.#appRegistry,
                computeRegistry: this.#computeRegistry,
                ...(this.#defaultDocker === undefined
                    ? {}
                    : { defaultDocker: this.#defaultDocker }),
                environment: this.#environment,
                docker: this.#docker,
                ...(this.#dockerCleanupTimeoutMs === undefined
                    ? {}
                    : { dockerCleanupTimeoutMs: this.#dockerCleanupTimeoutMs }),
                ...(this.#generatedMedia === undefined
                    ? {}
                    : { generatedMedia: this.#generatedMedia }),
                hookRegistry: this.#hookRegistry,
                ...(this.#listProviderUsage === undefined
                    ? {}
                    : { listProviderUsage: this.#listProviderUsage }),
                listPlugins: () =>
                    withWorkerContext(
                        "plugin-list",
                        async (workerCtx) => (await this.list(workerCtx)).plugins,
                    ),
                ...(this.#mcpRegistry === undefined ? {} : { mcpRegistry: this.#mcpRegistry }),
                networkRegistry: this.#networkRegistry,
                onStatus: (status) => this.#updatePluginStatus(folderName, status),
                ...(options.preserveLog === true ? { preserveLog: true } : {}),
                store: this.#store,
            });
            running = await startPluginWithin(starting, this.#startupTimeoutMs);
            if (this.#closed || !isCurrentStartup()) {
                running.startup.fail("Rig shut down while the plugin was starting.");
                await running.close({ force: true });
                return;
            }
            this.#running.set(folderName, running);
            const currentRunning = running;
            void running.retirement.then((retirement) =>
                withWorkerContext("plugin-retirement", (workerCtx) =>
                    retirement.status === "failed"
                        ? this.#failRunning(
                              workerCtx,
                              folderName,
                              name,
                              directory,
                              currentRunning,
                              retirement.reason,
                          )
                        : this.#stopRetiredRunning(workerCtx, folderName, currentRunning),
                ),
            );
            const startupElapsedMs = Date.now() - startupStartedAt;
            const startup = await waitForPluginStartup(
                running,
                Math.max(0, this.#startupTimeoutMs - startupElapsedMs),
                this.#startupTimeoutMs,
            );
            if (this.#closed || !isCurrentStartup() || this.#running.get(folderName) !== running) {
                await running.close({ force: true });
                return;
            }
            if (startup.status === "failed") {
                this.#running.delete(folderName);
                const diagnostic = boundPluginLogText(startup.error);
                this.#states.set(folderName, {
                    error: diagnostic.text,
                    logPath: running.logPath,
                    logTruncated: diagnostic.truncated,
                    status: "failed",
                    ...(running.statusMessage === undefined
                        ? {}
                        : { statusMessage: running.statusMessage }),
                    updatedAt: this.#now(),
                });
                this.#daemonLog.record(
                    "error",
                    "plugin_start_failed",
                    `Rig could not start the ${name} plugin.`,
                    { error: diagnostic.text, plugin: name, pluginDirectory: directory },
                );
                await running.close({ force: true });
                return;
            }
            this.#states.set(folderName, {
                logPath: running.logPath,
                status: "running",
                ...(running.statusMessage === undefined
                    ? {}
                    : { statusMessage: running.statusMessage }),
                updatedAt: this.#now(),
            });
            this.#daemonLog.record("info", "plugin_started", `The ${name} plugin started.`, {
                dataDirectory: running.dataDirectory,
                logPath: running.logPath,
                pid: running.pid,
                plugin: name,
                pluginDirectory: directory,
            });
            void running.completion.then(
                ({ code, signal }) =>
                    withWorkerContext("plugin-process-exit", async (workerCtx) => {
                        const exitError =
                            code !== null && code !== 0
                                ? `The plugin exited with code ${String(code)}.`
                                : signal === null
                                  ? undefined
                                  : `The plugin exited after receiving ${signal}.`;
                        this.#forgetExited(
                            workerCtx,
                            folderName,
                            currentRunning,
                            exitError === undefined ? {} : { error: exitError },
                        );
                        this.#daemonLog.record(
                            code === 0 ? "info" : "warning",
                            "plugin_exited",
                            `The ${name} plugin exited.`,
                            {
                                ...(code === null ? {} : { exitCode: code }),
                                plugin: name,
                                ...(signal === null ? {} : { signal }),
                            },
                        );
                    }),
                (error: unknown) =>
                    withWorkerContext("plugin-process-failure", async (workerCtx) => {
                        this.#forgetExited(workerCtx, folderName, currentRunning, {
                            error: errorToMessage(error),
                        });
                        this.#daemonLog.record(
                            "error",
                            "plugin_process_failed",
                            `The ${name} plugin process failed.`,
                            { error: errorToMessage(error), plugin: name },
                        );
                    }),
            );
        } catch (error) {
            if (this.#closed || !isCurrentStartup()) {
                if (running !== undefined) await running.close({ force: true });
                return;
            }
            if (running !== undefined) {
                if (this.#running.get(folderName) === running) {
                    this.#running.delete(folderName);
                }
                await running.close({ force: true });
            }
            const diagnostic = boundPluginLogText(errorToMessage(error));
            this.#states.set(folderName, {
                error: diagnostic.text,
                logTruncated: diagnostic.truncated,
                status: "failed",
                updatedAt: this.#now(),
            });
            this.#daemonLog.record(
                "error",
                "plugin_start_failed",
                `Rig could not start the ${name} plugin.`,
                { error: diagnostic.text, plugin: name, pluginDirectory: directory },
            );
        } finally {
            if (isCurrentStartup()) this.#startupGenerations.delete(folderName);
        }
    }

    async #stopRunning(ctx: Context, folderName: string, publishStopped = false): Promise<void> {
        this.#startupGenerations.delete(folderName);
        const running = this.#running.get(folderName);
        if (running === undefined) {
            if (this.#states.get(folderName)?.status !== "running") return;
            this.#states.set(folderName, {
                status: "stopped",
                updatedAt: this.#now(),
            });
            if (publishStopped) await this.#publishChanged(ctx);
            return;
        }
        this.#running.delete(folderName);
        await running.close().catch((error: unknown) => {
            this.#daemonLog.record(
                "warning",
                "plugin_stop_cleanup_failed",
                `Rig could not completely clean up the ${running.name} plugin while stopping it.`,
                { error: errorToMessage(error), plugin: running.name },
            );
        });
        this.#states.set(folderName, {
            logPath: running.logPath,
            status: "stopped",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        if (publishStopped) await this.#publishChanged(ctx);
    }

    #recordDockerCleanupFailure(plugin: string, action: string, error: unknown): void {
        this.#daemonLog.record(
            "warning",
            "plugin_docker_cleanup_failed",
            `Rig could not ${action} for the ${plugin} plugin. The plugin change still completed.`,
            { error: errorToMessage(error), plugin },
        );
    }

    #updatePluginStatus(folderName: string, statusMessage: string): void {
        const state = this.#states.get(folderName);
        if (state?.status !== "running") return;
        this.#states.set(folderName, {
            ...state,
            statusMessage,
            updatedAt: this.#now(),
        });
        this.#scheduleStatusPublication();
    }

    #scheduleStatusPublication(): void {
        if (this.#closed) return;
        if (this.#statusPublication.status === "publishing") {
            this.#statusPublication = { status: "publishing_pending" };
            return;
        }
        if (this.#statusPublication.status !== "idle") return;
        const timer = setTimeout(() => {
            if (
                this.#statusPublication.status !== "scheduled" ||
                this.#statusPublication.timer !== timer
            ) {
                return;
            }
            this.#statusPublication = { status: "publishing" };
            void withWorkerContext("plugin-status-publication", (workerCtx) =>
                this.#publishChanged(workerCtx),
            ).finally(() => this.#finishStatusPublication());
        }, PLUGIN_STATUS_PUBLICATION_INTERVAL_MS);
        timer.unref();
        this.#statusPublication = { status: "scheduled", timer };
    }

    #finishStatusPublication(): void {
        if (this.#closed) {
            this.#statusPublication = { status: "idle" };
            return;
        }
        const publishAgain = this.#statusPublication.status === "publishing_pending";
        this.#statusPublication = { status: "idle" };
        if (publishAgain) this.#scheduleStatusPublication();
    }

    async #failRunning(
        ctx: Context,
        folderName: string,
        name: string,
        directory: string,
        running: RunningPlugin,
        error: string,
    ): Promise<void> {
        if (this.#closed || this.#running.get(folderName) !== running) return;
        if (await exitsWithin(running.completion, PLUGIN_PROCESS_EXIT_SETTLE_MS)) return;
        if (this.#closed || this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        const diagnostic = boundPluginLogText(error);
        this.#states.set(folderName, {
            error: diagnostic.text,
            logPath: running.logPath,
            logTruncated: diagnostic.truncated,
            status: "failed",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        this.#daemonLog.record(
            "error",
            "plugin_runtime_failed",
            `The ${name} plugin failed while it was running.`,
            { error: diagnostic.text, plugin: name, pluginDirectory: directory },
        );
        await Promise.allSettled([running.close({ force: true }), this.#publishChanged(ctx)]);
    }

    async #stopRetiredRunning(
        ctx: Context,
        folderName: string,
        running: RunningPlugin,
    ): Promise<void> {
        if (this.#closed || this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        await running.close();
        this.#states.set(folderName, {
            logPath: running.logPath,
            status: "stopped",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        await this.#publishChanged(ctx);
    }

    /** A plugin that ends on its own leaves the running set, and clients see it stop. */
    #forgetExited(
        ctx: Context,
        folderName: string,
        running: RunningPlugin,
        options: { error?: string },
    ): void {
        if (this.#running.get(folderName) !== running) return;
        this.#running.delete(folderName);
        const boundedError =
            options.error === undefined ? undefined : boundPluginLogText(options.error);
        this.#states.set(folderName, {
            ...(boundedError === undefined
                ? {}
                : { error: boundedError.text, logTruncated: boundedError.truncated }),
            logPath: running.logPath,
            status: "stopped",
            ...(running.statusMessage === undefined
                ? {}
                : { statusMessage: running.statusMessage }),
            updatedAt: this.#now(),
        });
        void this.#publishChanged(ctx);
    }

    async #publishChanged(
        ctx: Context,
        options: { installation?: InstalledPlugin } = {},
    ): Promise<void> {
        const eventId = this.#createEventId();
        this.#catalogVersion = eventId;
        const publish = async () => {
            if (this.#closed) return;
            let catalog: Awaited<ReturnType<PluginManager["list"]>>;
            try {
                catalog = await this.list(ctx);
            } catch (error) {
                this.#daemonLog.record(
                    "warning",
                    "plugins_unreadable",
                    "Rig could not read the plugins folder to announce a change.",
                    { error: errorToMessage(error) },
                );
                return;
            }
            if (this.#closed || catalog.version !== eventId) return;
            const event = {
                createdAt: this.#now(),
                data: {
                    ...catalog,
                    ...(options.installation === undefined
                        ? {}
                        : { installation: options.installation }),
                },
                id: eventId,
                type: "plugins_changed" as const,
            };
            this.#store.globalEventQueue.publishLive(event);
            this.#store.liveEvents.publish(event);
        };
        const next = this.#publication.then(publish, publish);
        this.#publication = next.catch(() => undefined);
        await next;
    }

    async #publishComputePreparation(
        ctx: Context,
        progress: Extract<PluginComputeRegistryEvent, { type: "preparation" }>,
    ): Promise<void> {
        const event: ComputePreparationEvent = {
            computeInstanceId: progress.instanceId,
            createdAt: progress.createdAt,
            data: {
                ...(progress.elapsedMs === undefined ? {} : { elapsedMs: progress.elapsedMs }),
                ...(progress.error === undefined ? {} : { error: progress.error }),
                ...(progress.lastProgressAt === undefined
                    ? {}
                    : { lastProgressAt: progress.lastProgressAt }),
                message: progress.message,
                ...(progress.percent === undefined ? {} : { percent: progress.percent }),
                phase: progress.phase,
                provider: progress.provider,
                ...(progress.startedAt === undefined ? {} : { startedAt: progress.startedAt }),
                state: progress.state,
            },
            id: this.#createEventId(),
            type: "compute_preparation",
        };
        try {
            const entry = await this.#store.globalEventQueue.append(ctx, event);
            if (entry === undefined) {
                this.#daemonLog.record(
                    "warning",
                    "compute_preparation_event_unstored",
                    "Rig could not retain a compute preparation event.",
                    {
                        error: "The durable event queue did not append the event.",
                        instanceId: progress.instanceId,
                        phase: progress.phase,
                        provider: progress.provider,
                    },
                );
                return;
            }
            this.#store.globalEventQueue.publish(entry);
        } catch (error) {
            this.#daemonLog.record(
                "warning",
                "compute_preparation_event_unstored",
                "Rig could not retain a compute preparation event.",
                {
                    error: errorToMessage(error),
                    instanceId: progress.instanceId,
                    phase: progress.phase,
                    provider: progress.provider,
                },
            );
            return;
        }
        this.#store.liveEvents.publish(event);
        const previous = this.#computeSessionPreparation.get(event.computeInstanceId);
        try {
            await this.#publishComputePreparationToSessions(ctx, progress, event);
        } catch (error) {
            if (previous === undefined) {
                this.#computeSessionPreparation.delete(event.computeInstanceId);
            } else {
                this.#computeSessionPreparation.set(event.computeInstanceId, previous);
            }
            this.#daemonLog.record(
                "warning",
                "compute_preparation_projection_failed",
                "Rig could not project a compute preparation event into session history.",
                {
                    error: errorToMessage(error),
                    instanceId: event.computeInstanceId,
                    phase: event.data.phase,
                    provider: event.data.provider,
                },
            );
        }
    }

    async #publishComputePreparationToSessions(
        ctx: Context,
        progress: Extract<PluginComputeRegistryEvent, { type: "preparation" }>,
        event: ComputePreparationEvent,
    ): Promise<void> {
        if (progress.workspaceSource.type !== "local_directory") return;
        const previous = this.#computeSessionPreparation.get(event.computeInstanceId);
        const samePhase =
            previous?.phase === event.data.phase && previous.state === event.data.state;
        const closesLifecycle = closesComputePreparationLifecycle(event);
        const settlesArchived = settlesArchivedComputePreparation(event, previous?.state);
        const payload = formatComputePreparationNotice(event);
        const current =
            samePhase && previous !== undefined
                ? previous
                : {
                      delivered: new WeakSet<InMemorySession>(),
                      phase: event.data.phase,
                      sessions: previous?.sessions ?? new WeakSet<InMemorySession>(),
                      state: event.data.state,
                  };
        const sourcePath = resolve(progress.workspaceSource.path);
        const recipients: { session: InMemorySession; settleArchived: boolean }[] = [];
        for (const session of this.#store.loadedSessions()) {
            const summary = session.summary();
            if (resolve(summary.cwd) !== sourcePath) continue;
            const settleArchived =
                summary.archived && settlesArchived && previous?.sessions.has(session) === true;
            if (summary.archived && !settleArchived) continue;
            if (!summary.archived && current.delivered.has(session)) continue;
            recipients.push({ session, settleArchived });
        }
        if (!closesLifecycle) {
            if (
                !this.#computeSessionPreparation.has(event.computeInstanceId) &&
                this.#computeSessionPreparation.size >= MAX_COMPUTE_SESSION_PREPARATIONS
            ) {
                const oldest = this.#computeSessionPreparation.keys().next().value;
                if (oldest !== undefined) this.#computeSessionPreparation.delete(oldest);
            }
            this.#computeSessionPreparation.set(event.computeInstanceId, current);
        }

        /*
         * Attribution follows the matching loaded session, including subagents. An archived
         * session cannot begin or resume a lifecycle, but a weakly retained recipient gets the
         * terminal row that settles work it observed before archival. Cold sessions are never
         * hydrated merely to receive progress. `resolve` normalizes path syntax but does not
         * resolve symlinks, so aliases such as `/tmp` and `/private/tmp` intentionally do not
         * match. Phase coalescing is process-local and bounded; a daemon restart or extreme
         * concurrent-preparation eviction may append the current phase once more.
         *
         * Formatting, session enumeration, and summary reads finish before the lifecycle map is
         * changed or a notice is written. From that point onward each durable write is caught
         * independently, and weak recipient state changes only after that write succeeds. The
         * outer rollback therefore never has to clone or undo a WeakSet after partial delivery.
         */
        for (const { session, settleArchived } of recipients) {
            try {
                await session.recordSystemNotice(
                    ctx,
                    payload,
                    settleArchived ? { settleArchived: true } : {},
                );
                current.delivered.add(session);
                if (!settleArchived) current.sessions.add(session);
            } catch (error) {
                this.#daemonLog.record(
                    "warning",
                    "compute_preparation_session_notice_failed",
                    "Rig could not append compute preparation progress to a session.",
                    {
                        error: errorToMessage(error),
                        instanceId: event.computeInstanceId,
                        phase: event.data.phase,
                        provider: event.data.provider,
                        sessionId: session.id,
                    },
                );
            }
        }
        if (closesLifecycle) this.#computeSessionPreparation.delete(event.computeInstanceId);
    }
}

function closesComputePreparationLifecycle(event: ComputePreparationEvent): boolean {
    return (
        event.data.phase === "failed" ||
        event.data.phase === "stopped" ||
        event.data.phase === "ready" ||
        event.data.state === "failed" ||
        event.data.state === "stopped" ||
        event.data.state === "ready"
    );
}

function settlesArchivedComputePreparation(
    event: ComputePreparationEvent,
    previousState: ComputePreparationEvent["data"]["state"] | undefined,
): boolean {
    return (
        event.data.phase === "failed" ||
        event.data.phase === "stopped" ||
        event.data.state === "failed" ||
        event.data.state === "stopped" ||
        ((event.data.phase === "ready" || event.data.state === "ready") &&
            previousState === "provisioning")
    );
}

async function waitForPluginStartup(
    running: RunningPlugin,
    timeoutMs: number,
    reportedTimeoutMs = timeoutMs,
): Promise<{ status: "running" } | { error: string; status: "failed" }> {
    const timer = setTimeout(
        () =>
            running.startup.fail(
                `The plugin did not report ready within ${formatStartupDuration(reportedTimeoutMs)}.`,
            ),
        timeoutMs,
    );
    timer.unref();
    void running.completion.then(
        ({ code, signal }) => {
            running.startup.fail(
                code !== null && code !== 0
                    ? `The plugin exited with code ${String(code)} before reporting ready.`
                    : signal === null
                      ? "The plugin exited before reporting ready."
                      : `The plugin exited after receiving ${signal} before reporting ready.`,
            );
        },
        (error: unknown) => {
            running.startup.fail(errorToMessage(error));
        },
    );
    try {
        return await running.startup.settled;
    } finally {
        clearTimeout(timer);
    }
}

async function startPluginWithin(
    starting: Promise<RunningPlugin>,
    timeoutMs: number,
): Promise<RunningPlugin> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    void starting.then(
        async (running) => {
            if (timedOut) await running.close({ force: true });
        },
        () => {},
    );
    try {
        return await Promise.race([
            starting,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(
                        new Error(
                            `The plugin did not report ready within ${formatStartupDuration(timeoutMs)}.`,
                        ),
                    );
                }, timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function exitsWithin(
    completion: RunningPlugin["completion"],
    timeoutMs: number,
): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            completion.then(
                () => true,
                () => true,
            ),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function formatStartupDuration(timeoutMs: number): string {
    if (timeoutMs < 1_000) {
        return `${String(timeoutMs)} ${timeoutMs === 1 ? "millisecond" : "milliseconds"}`;
    }
    const seconds = timeoutMs / 1_000;
    const formatted = Number(seconds.toFixed(3));
    return `${String(formatted)} ${formatted === 1 ? "second" : "seconds"}`;
}
