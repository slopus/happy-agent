import type { PartialHappyTerminalConfig, HappyTerminalConfig } from "./types.js";

export function mergeConfigValues(
    base: HappyTerminalConfig,
    ...configs: readonly PartialHappyTerminalConfig[]
): HappyTerminalConfig {
    const defaults = { ...base.defaults };
    const settings = { ...base.settings };
    const theme = { ...base.theme };

    for (const config of configs) {
        if (config.defaults !== undefined) {
            const { serviceTier, ...rest } = config.defaults;
            Object.assign(defaults, rest);
            if (serviceTier === null) delete defaults.serviceTier;
            else if (serviceTier !== undefined) defaults.serviceTier = serviceTier;
        }
        if (config.settings !== undefined) Object.assign(settings, config.settings);
        if (config.theme !== undefined) Object.assign(theme, config.theme);
    }

    return { defaults, settings, theme };
}
