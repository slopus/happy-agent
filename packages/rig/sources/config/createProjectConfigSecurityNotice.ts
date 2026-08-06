import type { PartialRigConfig } from "./types.js";

export function createProjectConfigSecurityNotice(
    config: PartialRigConfig,
    configFileName = "rig.toml",
): string | undefined {
    const permission = config.defaults?.permissionMode !== undefined;
    const docker = config.docker !== undefined;
    const providers = config.providerDefaultEnable !== undefined || config.providers !== undefined;
    const inferenceRetries = config.settings?.inferenceMaxRetries !== undefined;
    const daemonHeapSnapshots = config.settings?.daemonHeapSnapshots !== undefined;
    const durableEventQueue = config.settings?.durableGlobalEventQueue !== undefined;
    const happyIntegration = config.settings?.happyIntegration !== undefined;
    const p2p = config.p2p !== undefined;
    if (
        !inferenceRetries &&
        !daemonHeapSnapshots &&
        !durableEventQueue &&
        !happyIntegration &&
        !p2p
    ) {
        if (!permission && !docker && !providers) return undefined;
        if (providers && !permission && !docker) {
            return `This project's ${configFileName} requested provider availability. Rig applied the other project preferences but kept provider and native authentication choices under your machine-level control.`;
        }
        if (providers && permission && docker) {
            return `This project's ${configFileName} requested machine-level settings. Rig applied the other project preferences but kept permissions, container execution, and provider availability under your machine-level control.`;
        }
        if (providers && permission) {
            return `This project's ${configFileName} requested machine-level settings. Rig applied the other project preferences but kept permissions and provider availability under your machine-level control.`;
        }
        if (providers && docker) {
            return `This project's ${configFileName} requested machine-level settings. Rig applied the other project preferences but kept container execution and provider availability under your machine-level control.`;
        }
        if (permission && docker) {
            return `This project's ${configFileName} requested a permission mode and Docker environment. Rig applied the other project preferences but kept execution settings under your machine-level control.`;
        }
        return permission
            ? `This project's ${configFileName} requested a permission mode. Rig applied the other project preferences but kept your user-level permission choice.`
            : `This project's ${configFileName} requested a Docker environment. Rig applied the other project preferences but kept container execution under your machine-level control.`;
    }
    const ignoredSettings = [
        ...(permission ? ["permissions"] : []),
        ...(docker ? ["container execution"] : []),
        ...(providers ? ["provider availability"] : []),
        ...(inferenceRetries ? ["inference retries"] : []),
        ...(daemonHeapSnapshots ? ["daemon heap snapshots"] : []),
        ...(durableEventQueue ? ["the durable event queue"] : []),
        ...(happyIntegration ? ["the Happy integration"] : []),
        ...(p2p ? ["P2P networking"] : []),
    ];
    if (ignoredSettings.length === 0) return undefined;

    const lastSetting = ignoredSettings.at(-1)!;
    const settingList =
        ignoredSettings.length === 1
            ? lastSetting
            : ignoredSettings.length === 2
              ? `${ignoredSettings[0]} and ${lastSetting}`
              : `${ignoredSettings.slice(0, -1).join(", ")}, and ${lastSetting}`;
    const request = ignoredSettings.length === 1 ? settingList : "machine-level settings";
    return `This project's ${configFileName} requested ${request}. Rig applied the other project preferences but kept ${settingList} under your machine-level control.`;
}
