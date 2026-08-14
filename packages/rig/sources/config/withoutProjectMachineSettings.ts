import type { PartialRigConfig } from "./types.js";

export function withoutProjectMachineSettings(config: PartialRigConfig): PartialRigConfig {
    const {
        defaults: projectDefaults,
        docker: _docker,
        p2p: _p2p,
        providerDefaultEnable: _providerDefaultEnable,
        providers: _providers,
        settings: projectSettings,
        ...rest
    } = config;
    const { permissionMode: _permissionMode, ...defaults } = projectDefaults ?? {};
    const {
        inferenceMaxRetries: _inferenceMaxRetries,
        inferenceFatalRetries: _inferenceFatalRetries,
        daemonHeapSnapshots: _daemonHeapSnapshots,
        durableGlobalEventQueue: _durableGlobalEventQueue,
        happyIntegration: _happyIntegration,
        toolResultRetentionDays: _toolResultRetentionDays,
        ...settings
    } = projectSettings ?? {};

    return {
        ...rest,
        ...(Object.keys(defaults).length === 0 ? {} : { defaults }),
        ...(Object.keys(settings).length === 0 ? {} : { settings }),
    };
}
