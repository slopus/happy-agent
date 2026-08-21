import { readConfigFile } from "./readConfigFile.js";
import type { PartialHappyTerminalConfig } from "./types.js";
import { updateRuntimeConfig } from "./updateRuntimeConfig.js";

export function updateRuntimePreferences(
    path: string,
    preferences: PartialHappyTerminalConfig,
): Promise<void> {
    return updateRuntimeConfig(path, async () => {
        const current = await readConfigFile(path);
        return { ...current.values, ...preferences };
    });
}
