import type { PartialHappyTerminalConfig } from "./types.js";

/**
 * A checked-in project file may carry preferences, never this machine's permission boundary.
 * The permission mode is dropped here so a hostile repository cannot elevate the session, and
 * the startup notice tells the person what was ignored.
 */
export function withoutProjectMachineSettings(
    config: PartialHappyTerminalConfig,
): PartialHappyTerminalConfig {
    const { defaults: projectDefaults, ...rest } = config;
    const { permissionMode: _permissionMode, ...defaults } = projectDefaults ?? {};
    return {
        ...rest,
        ...(Object.keys(defaults).length === 0 ? {} : { defaults }),
    };
}
