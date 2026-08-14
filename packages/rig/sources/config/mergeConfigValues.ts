import type {
    ConfigPresence,
    PartialConfigProvider,
    RigConfig,
    PartialRigConfig,
} from "./types.js";

export function mergeConfigValues(
    baseDefaults: RigConfig,
    ...configs: PartialRigConfig[]
): RigConfig {
    let docker = baseDefaults.docker;
    const defaults = { ...baseDefaults.defaults };
    const features = { ...baseDefaults.features };
    const mcpServers = { ...baseDefaults.mcpServers };
    let network = baseDefaults.network;
    const protectedPaths = new Set(baseDefaults.permissions.protectedPaths);
    const p2p = {
        ...baseDefaults.p2p,
        direct: { ...baseDefaults.p2p.direct },
        iroh: { ...baseDefaults.p2p.iroh },
    };
    const presence: ConfigPresence = {
        ...baseDefaults.presence,
        states: { ...baseDefaults.presence.states },
    };
    let providerDefaultEnable = baseDefaults.providerDefaultEnable;
    const providers: Record<string, PartialConfigProvider> = Object.fromEntries(
        Object.entries(baseDefaults.providers).map(([id, provider]) => {
            const { enabled: _enabled, ...settings } = provider;
            return [id, settings];
        }),
    );
    const providerEnabledOverrides = new Map<string, boolean>();
    const settings = { ...baseDefaults.settings };
    const theme = { ...baseDefaults.theme };
    const workspace = { ...baseDefaults.workspace };

    for (const config of configs) {
        if (config.docker !== undefined) docker = config.docker;
        if (config.defaults?.modelId !== undefined) {
            defaults.modelId = config.defaults.modelId;
        }
        if (config.defaults?.providerId !== undefined) {
            defaults.providerId = config.defaults.providerId;
        }
        if (config.defaults?.effort !== undefined) {
            defaults.effort = config.defaults.effort;
        }
        if (config.defaults?.instructions !== undefined) {
            defaults.instructions = config.defaults.instructions;
        }
        if (config.defaults?.permissionMode !== undefined) {
            defaults.permissionMode = config.defaults.permissionMode;
        }
        if (config.defaults?.serviceTier === null) {
            delete defaults.serviceTier;
        } else if (config.defaults?.serviceTier !== undefined) {
            defaults.serviceTier = config.defaults.serviceTier;
        }
        if (config.settings?.compactCompletedTurns !== undefined) {
            settings.compactCompletedTurns = config.settings.compactCompletedTurns;
        }
        if (config.settings?.inferenceMaxRetries !== undefined) {
            settings.inferenceMaxRetries = config.settings.inferenceMaxRetries;
        }
        if (config.settings?.inferenceFatalRetries !== undefined) {
            settings.inferenceFatalRetries = config.settings.inferenceFatalRetries;
        }
        if (config.settings?.showReasoning !== undefined) {
            settings.showReasoning = config.settings.showReasoning;
        }
        if (config.settings?.completionChime !== undefined) {
            settings.completionChime = config.settings.completionChime;
        }
        if (config.settings?.daemonHeapSnapshots !== undefined) {
            settings.daemonHeapSnapshots = config.settings.daemonHeapSnapshots;
        }
        if (config.settings?.durableGlobalEventQueue !== undefined) {
            settings.durableGlobalEventQueue = config.settings.durableGlobalEventQueue;
        }
        if (config.settings?.happyIntegration !== undefined) {
            settings.happyIntegration = config.settings.happyIntegration;
        }
        if (config.settings?.showUsage !== undefined)
            settings.showUsage = config.settings.showUsage;
        if (config.settings?.toolResultRetentionDays !== undefined) {
            settings.toolResultRetentionDays = config.settings.toolResultRetentionDays;
        }
        if (config.features?.workflows !== undefined) {
            features.workflows = config.features.workflows;
        }
        if (config.features?.workspaces !== undefined) {
            features.workspaces = config.features.workspaces;
        }
        if (config.features?.crossWorkspace !== undefined) {
            features.crossWorkspace = config.features.crossWorkspace;
        }
        if (config.p2p?.enableDirect !== undefined) p2p.enableDirect = config.p2p.enableDirect;
        if (config.p2p?.enableIroh !== undefined) p2p.enableIroh = config.p2p.enableIroh;
        if (config.p2p?.enableSsh !== undefined) p2p.enableSsh = config.p2p.enableSsh;
        if (config.p2p?.exposeApi !== undefined) p2p.exposeApi = config.p2p.exposeApi;
        if (config.p2p?.direct?.listen !== undefined) {
            p2p.direct.listen = config.p2p.direct.listen;
        }
        if (config.p2p?.iroh?.relayUrl !== undefined) {
            p2p.iroh.relayUrl = config.p2p.iroh.relayUrl;
        }
        if (config.p2p?.name !== undefined) p2p.name = config.p2p.name;
        if (config.p2p?.role !== undefined) {
            p2p.role = config.p2p.role;
            if (config.p2p.role === "primary") delete p2p.primaryId;
        }
        if (config.p2p?.primaryId !== undefined) p2p.primaryId = config.p2p.primaryId;
        if (config.providerDefaultEnable !== undefined) {
            providerDefaultEnable = config.providerDefaultEnable;
        }
        if (config.providers !== undefined) {
            for (const [id, provider] of Object.entries(config.providers)) {
                providers[id] = provider;
                if (provider.enabled !== undefined) {
                    providerEnabledOverrides.set(id, provider.enabled);
                } else {
                    providerEnabledOverrides.delete(id);
                }
            }
        }
        if (config.theme !== undefined) Object.assign(theme, config.theme);
        if (config.mcpServers !== undefined) {
            Object.assign(mcpServers, config.mcpServers);
        }
        if (config.network !== undefined) network = config.network;
        for (const path of config.permissions?.protectedPaths ?? []) protectedPaths.add(path);
        if (config.presence !== undefined) {
            if (config.presence.current !== undefined) {
                presence.current = config.presence.current;
                if (config.presence.fallback === undefined) delete presence.fallback;
                else presence.fallback = config.presence.fallback;
                if (config.presence.until === undefined) delete presence.until;
                else presence.until = config.presence.until;
            } else {
                if (config.presence.fallback !== undefined) {
                    presence.fallback = config.presence.fallback;
                }
                if (config.presence.until !== undefined) presence.until = config.presence.until;
            }
            for (const [id, state] of Object.entries(config.presence.states ?? {})) {
                presence.states = {
                    ...presence.states,
                    [id]: { ...presence.states[id], ...state },
                };
            }
        }
        if (config.workspace?.sync !== undefined) {
            workspace.sync = config.workspace.sync;
        }
        if (config.workspace?.protectedSync !== undefined) {
            workspace.protectedSync = config.workspace.protectedSync;
        }
        if (config.workspace?.setupCommands !== undefined) {
            workspace.setupCommands = config.workspace.setupCommands;
        }
    }

    return {
        defaults,
        features,
        mcpServers,
        ...(network === undefined ? {} : { network }),
        permissions: { protectedPaths: [...protectedPaths] },
        p2p,
        presence,
        providerDefaultEnable,
        providers: Object.fromEntries(
            Object.entries(providers).map(([id, provider]) => [
                id,
                {
                    ...provider,
                    enabled: providerEnabledOverrides.get(id) ?? providerDefaultEnable,
                },
            ]),
        ),
        settings,
        theme,
        workspace,
        ...(docker === undefined ? {} : { docker }),
    };
}
