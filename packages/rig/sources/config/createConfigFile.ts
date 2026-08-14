import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "smol-toml";

import { DEFAULT_RIG_CONFIG } from "./defaultConfig.js";
import { serializeMcpServers } from "./serializeMcpServers.js";
import { serializeProviders } from "./serializeProviders.js";
import type { RigConfig } from "./types.js";

export async function createConfigFile(
    path: string,
    config: RigConfig = DEFAULT_RIG_CONFIG,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
        path,
        stringify({
            defaults: {
                model: config.defaults.modelId,
                permission_mode: config.defaults.permissionMode,
                ...(config.defaults.providerId !== undefined
                    ? { provider: config.defaults.providerId }
                    : {}),
                ...(config.defaults.effort !== undefined ? { effort: config.defaults.effort } : {}),
                ...(config.defaults.instructions !== undefined
                    ? { instructions: config.defaults.instructions }
                    : {}),
                ...(config.defaults.serviceTier !== undefined
                    ? { service_tier: config.defaults.serviceTier }
                    : {}),
            },
            settings: {
                inference_max_retries: config.settings.inferenceMaxRetries,
                inference_fatal_retries: config.settings.inferenceFatalRetries,
                compact_completed_turns: config.settings.compactCompletedTurns,
                completion_chime: config.settings.completionChime,
                daemon_heap_snapshots: config.settings.daemonHeapSnapshots,
                durable_global_event_queue: config.settings.durableGlobalEventQueue,
                happy_integration: config.settings.happyIntegration,
                show_reasoning: config.settings.showReasoning,
                show_usage: config.settings.showUsage,
                tool_result_retention_days: config.settings.toolResultRetentionDays,
            },
            features: {
                cross_workspace: config.features.crossWorkspace,
                workflows: config.features.workflows,
                workspaces: config.features.workspaces,
            },
            ...(!config.p2p.enableDirect &&
            !config.p2p.enableIroh &&
            !config.p2p.enableSsh &&
            !config.p2p.exposeApi &&
            config.p2p.direct.listen === undefined &&
            config.p2p.iroh.relayUrl === undefined
                ? {}
                : {
                      p2p: {
                          enable_direct: config.p2p.enableDirect,
                          enable_iroh: config.p2p.enableIroh,
                          enable_ssh: config.p2p.enableSsh,
                          expose_api: config.p2p.exposeApi,
                          name: config.p2p.name,
                          role: config.p2p.role,
                          ...(config.p2p.primaryId === undefined
                              ? {}
                              : { primary_id: config.p2p.primaryId }),
                          direct:
                              config.p2p.direct.listen === undefined
                                  ? {}
                                  : { listen: config.p2p.direct.listen },
                          iroh:
                              config.p2p.iroh.relayUrl === undefined
                                  ? {}
                                  : { relay_url: config.p2p.iroh.relayUrl },
                      },
                  }),
            providers: serializeProviders(config.providers, config.providerDefaultEnable),
            ...(config.permissions.protectedPaths.length === 0
                ? {}
                : {
                      permissions: {
                          protected_paths: config.permissions.protectedPaths,
                      },
                  }),
            theme: config.theme,
            ...(config.workspace.sync.length === 0 &&
            config.workspace.protectedSync.length === 0 &&
            config.workspace.setupCommands.length === 0
                ? {}
                : {
                      workspace: {
                          ...(config.workspace.sync.length === 0
                              ? {}
                              : { sync: config.workspace.sync }),
                          ...(config.workspace.protectedSync.length === 0
                              ? {}
                              : { protected_sync: config.workspace.protectedSync }),
                          ...(config.workspace.setupCommands.length === 0
                              ? {}
                              : { setup_commands: config.workspace.setupCommands }),
                      },
                  }),
            ...(config.docker === undefined
                ? {}
                : {
                      docker: {
                          ...(config.docker.container === undefined
                              ? {}
                              : { container: config.docker.container }),
                          ...(config.docker.image === undefined
                              ? {}
                              : { image: config.docker.image }),
                          workdir: config.docker.workingDirectory,
                          ...(config.docker.name === undefined ? {} : { name: config.docker.name }),
                          ...(config.docker.socketPath === undefined
                              ? {}
                              : { socket_path: config.docker.socketPath }),
                          ...(config.docker.environment === undefined
                              ? {}
                              : { env: config.docker.environment }),
                          ...(config.docker.mounts === undefined
                              ? {}
                              : {
                                    mounts: config.docker.mounts.map((mount) => ({
                                        source: mount.source,
                                        target: mount.target,
                                        ...(mount.readOnly === undefined
                                            ? {}
                                            : { read_only: mount.readOnly }),
                                    })),
                                }),
                      },
                  }),
            ...(Object.keys(config.mcpServers).length > 0
                ? { mcp_servers: serializeMcpServers(config.mcpServers) }
                : {}),
        }),
        { encoding: "utf8", flag: "wx" },
    );
}
