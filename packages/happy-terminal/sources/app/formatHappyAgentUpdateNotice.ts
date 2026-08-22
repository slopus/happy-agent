import type { HappyAgentUpdate } from "../daemon/index.js";

export interface HappyAgentUpdateNotice {
    readonly text: string;
    readonly title: string;
}

export function formatHappyAgentUpdateNotice(
    update: HappyAgentUpdate,
    commandName: string,
): HappyAgentUpdateNotice {
    return {
        text: `Happy Agent ${update.latestVersion} is available; this terminal is using ${update.currentVersion}. Run '${commandName} upgrade' to download it and restart Happy Agent.`,
        title: "Happy Agent update available",
    };
}
