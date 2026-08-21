import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "smol-toml";

import { runWithRuntimeConfigLock } from "./runtimeConfigLock.js";
import type { PartialHappyTerminalConfig } from "./types.js";

export async function writeRuntimeConfig(
    path: string,
    config: PartialHappyTerminalConfig,
): Promise<void> {
    await runWithRuntimeConfigLock(() => writeRuntimeConfigInsideLock(path, config));
}

export async function writeRuntimeConfigInsideLock(
    path: string,
    config: PartialHappyTerminalConfig,
): Promise<void> {
    const document = {
        ...(config.defaults === undefined
            ? {}
            : {
                  defaults: {
                      ...(config.defaults.effort === undefined
                          ? {}
                          : { effort: config.defaults.effort }),
                      ...(config.defaults.instructions === undefined
                          ? {}
                          : { instructions: config.defaults.instructions }),
                      ...(config.defaults.modelId === undefined
                          ? {}
                          : { model: config.defaults.modelId }),
                      ...(config.defaults.permissionMode === undefined
                          ? {}
                          : { permission_mode: config.defaults.permissionMode }),
                      ...(config.defaults.providerId === undefined
                          ? {}
                          : { provider: config.defaults.providerId }),
                      ...(config.defaults.serviceTier === undefined
                          ? {}
                          : { service_tier: config.defaults.serviceTier ?? "default" }),
                  },
              }),
        ...(config.settings === undefined
            ? {}
            : {
                  settings: {
                      ...(config.settings.compactCompletedTurns === undefined
                          ? {}
                          : {
                                compact_completed_turns: config.settings.compactCompletedTurns,
                            }),
                      ...(config.settings.completionChime === undefined
                          ? {}
                          : { completion_chime: config.settings.completionChime }),
                      ...(config.settings.showReasoning === undefined
                          ? {}
                          : { show_reasoning: config.settings.showReasoning }),
                      ...(config.settings.showUsage === undefined
                          ? {}
                          : { show_usage: config.settings.showUsage }),
                  },
              }),
        ...(config.theme === undefined ? {} : { theme: config.theme }),
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringify(document), "utf8");
}
