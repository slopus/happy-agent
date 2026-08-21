import { DEFAULT_HAPPY_TERMINAL_CONFIG } from "./defaultConfig.js";
import { mergeConfigValues } from "./mergeConfigValues.js";
import { readConfigFile } from "./readConfigFile.js";
import { readProjectConfigFile } from "./readProjectConfigFile.js";
import { resolveConfigPaths } from "./resolveConfigPaths.js";
import { withoutProjectMachineSettings } from "./withoutProjectMachineSettings.js";
import type { LoadedConfig, LoadConfigOptions } from "./types.js";

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
    const paths = resolveConfigPaths(options);
    const globalSource = await readConfigFile(paths.global);
    const localSource = await readProjectConfigFile(paths.local);
    const runtimeSource = await readConfigFile(paths.runtime);
    const sources = {
        global: globalSource,
        local: localSource,
        runtime: runtimeSource,
    };

    return {
        config: mergeConfigValues(
            DEFAULT_HAPPY_TERMINAL_CONFIG,
            globalSource.values,
            withoutProjectMachineSettings(localSource.values),
            runtimeSource.values,
        ),
        paths,
        sources,
    };
}
