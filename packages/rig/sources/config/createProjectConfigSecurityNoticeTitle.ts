import type { PartialRigConfig } from "./types.js";

export function createProjectConfigSecurityNoticeTitle(config: PartialRigConfig): string {
    const permission = config.defaults?.permissionMode !== undefined;
    const docker = config.docker !== undefined;
    const providers = config.providerDefaultEnable !== undefined || config.providers !== undefined;
    const inferenceRetries =
        config.settings?.inferenceMaxRetries !== undefined ||
        config.settings?.inferenceFatalRetries !== undefined;
    const daemonHeapSnapshots = config.settings?.daemonHeapSnapshots !== undefined;
    const durableEventQueue = config.settings?.durableGlobalEventQueue !== undefined;
    const happyIntegration = config.settings?.happyIntegration !== undefined;
    const toolResultRetention = config.settings?.toolResultRetentionDays !== undefined;
    const daemonSetting =
        inferenceRetries ||
        daemonHeapSnapshots ||
        durableEventQueue ||
        happyIntegration ||
        toolResultRetention ||
        config.p2p !== undefined;
    if (daemonSetting && (permission || docker || providers)) {
        return "Project machine settings ignored";
    }
    if (daemonSetting) return "Project daemon setting ignored";
    if (providers && (permission || docker)) return "Project machine settings ignored";
    if (providers) return "Project provider settings ignored";
    if (permission && docker) return "Project execution settings ignored";
    if (docker) return "Project Docker ignored";
    if (permission) return "Project permission ignored";
    return "Project settings ignored";
}
