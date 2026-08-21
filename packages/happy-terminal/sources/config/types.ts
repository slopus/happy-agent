import type { PermissionMode, ServiceTier } from "../protocol/index.js";

export interface ConfigDefaults {
    effort?: string;
    instructions?: string;
    modelId: string;
    permissionMode: PermissionMode;
    providerId?: string;
    serviceTier?: ServiceTier;
}

export interface PartialConfigDefaults {
    effort?: string;
    instructions?: string;
    modelId?: string;
    permissionMode?: PermissionMode;
    providerId?: string;
    serviceTier?: ServiceTier | null;
}

export interface ConfigSettings {
    compactCompletedTurns: boolean;
    completionChime: boolean;
    showReasoning: boolean;
    showUsage: boolean;
}

export interface PartialConfigSettings {
    compactCompletedTurns?: boolean;
    completionChime?: boolean;
    showReasoning?: boolean;
    showUsage?: boolean;
}

export interface ConfigTheme {
    accent: string;
    brand: string;
    error: string;
    primary: string;
    secondary: string;
    success: string;
    warning: string;
}

export type PartialConfigTheme = Partial<ConfigTheme>;

export interface HappyTerminalConfig {
    defaults: ConfigDefaults;
    settings: ConfigSettings;
    theme: ConfigTheme;
}

export interface PartialHappyTerminalConfig {
    defaults?: PartialConfigDefaults;
    settings?: PartialConfigSettings;
    theme?: PartialConfigTheme;
}

export interface ConfigPaths {
    global: string;
    local: string;
    runtime: string;
}

export interface ConfigSource {
    exists: boolean;
    path: string;
    values: PartialHappyTerminalConfig;
    unknownSettings: readonly string[];
}

export interface LoadedConfig {
    config: HappyTerminalConfig;
    paths: ConfigPaths;
    sources: {
        global: ConfigSource;
        local: ConfigSource;
        runtime: ConfigSource;
    };
}

export interface LoadConfigOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
}
