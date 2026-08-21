import { getDefaultGlobalConfigPath } from "./getDefaultGlobalConfigPath.js";
import { getDefaultLocalConfigPath } from "./getDefaultLocalConfigPath.js";
import { getDefaultRuntimeConfigPath } from "./getDefaultRuntimeConfigPath.js";
import type { ConfigPaths, LoadConfigOptions } from "./types.js";

export function resolveConfigPaths(options: LoadConfigOptions = {}): ConfigPaths {
    return {
        global: getDefaultGlobalConfigPath(options.env, options.homeDirectory),
        local: getDefaultLocalConfigPath(options.cwd),
        runtime: getDefaultRuntimeConfigPath(options.env, options.homeDirectory),
    };
}
