import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "smol-toml";

import type { PartialHappyTerminalConfig } from "./types.js";

const tableSchema = Type.Record(Type.String(), Type.Unknown());
const permissionModeSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("workspace_write"),
    Type.Literal("read_only"),
    Type.Literal("full_access"),
]);
const defaultsSchema = Type.Partial(
    Type.Object(
        {
            effort: Type.String(),
            instructions: Type.String(),
            model: Type.String(),
            permission_mode: permissionModeSchema,
            provider: Type.String(),
            service_tier: Type.Union([Type.Literal("default"), Type.Literal("fast")]),
        },
        { additionalProperties: false },
    ),
);
const settingsSchema = Type.Partial(
    Type.Object(
        {
            compact_completed_turns: Type.Boolean(),
            completion_chime: Type.Boolean(),
            show_reasoning: Type.Boolean(),
            show_usage: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
);
const themeSchema = Type.Partial(
    Type.Object(
        {
            accent: Type.String(),
            brand: Type.String(),
            error: Type.String(),
            primary: Type.String(),
            secondary: Type.String(),
            success: Type.String(),
            warning: Type.String(),
        },
        { additionalProperties: false },
    ),
);

type DefaultsDocument = Static<typeof defaultsSchema>;
type SettingsDocument = Static<typeof settingsSchema>;
type ThemeDocument = Static<typeof themeSchema>;

export interface ParsedConfigToml {
    unknownSettings: readonly string[];
    values: PartialHappyTerminalConfig;
}

export function parseConfigToml(source: string): PartialHappyTerminalConfig {
    return parseConfigTomlWithUnknownSettings(source).values;
}

export function parseConfigTomlWithUnknownSettings(source: string): ParsedConfigToml {
    const document = parse(source);
    if (!Value.Check(tableSchema, document)) {
        throw new Error("Happy Terminal config must contain TOML tables.");
    }

    const unknownSettings: string[] = [];
    for (const key of Object.keys(document)) {
        if (key !== "defaults" && key !== "settings" && key !== "theme") {
            unknownSettings.push(key);
        }
    }

    const defaults = readKnownTable(document.defaults, "defaults", defaultsSchema, unknownSettings);
    const settings = readKnownTable(document.settings, "settings", settingsSchema, unknownSettings);
    const theme = readKnownTable(document.theme, "theme", themeSchema, unknownSettings);

    const values: PartialHappyTerminalConfig = {};
    if (defaults !== undefined) values.defaults = mapDefaults(defaults);
    if (settings !== undefined) values.settings = mapSettings(settings);
    if (theme !== undefined) values.theme = theme;
    return { unknownSettings, values };
}

function readKnownTable<
    T extends typeof defaultsSchema | typeof settingsSchema | typeof themeSchema,
>(value: unknown, path: string, schema: T, unknownSettings: string[]): Static<T> | undefined {
    if (value === undefined) return undefined;
    if (!Value.Check(tableSchema, value)) throw new Error(`${path} must be a TOML table.`);

    const knownKeys = new Set(Object.keys(schema.properties));
    const known: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (knownKeys.has(key)) known[key] = entry;
        else unknownSettings.push(`${path}.${key}`);
    }
    if (!Value.Check(schema, known)) {
        throw new Error(`${path} contains a value with the wrong type.`);
    }
    return known as Static<T>;
}

function mapDefaults(
    defaults: DefaultsDocument,
): NonNullable<PartialHappyTerminalConfig["defaults"]> {
    return {
        ...(defaults.effort === undefined ? {} : { effort: defaults.effort }),
        ...(defaults.instructions === undefined ? {} : { instructions: defaults.instructions }),
        ...(defaults.model === undefined ? {} : { modelId: defaults.model }),
        ...(defaults.permission_mode === undefined
            ? {}
            : { permissionMode: defaults.permission_mode }),
        ...(defaults.provider === undefined ? {} : { providerId: defaults.provider }),
        ...(defaults.service_tier === undefined
            ? {}
            : { serviceTier: defaults.service_tier === "default" ? null : "fast" }),
    };
}

function mapSettings(
    settings: SettingsDocument,
): NonNullable<PartialHappyTerminalConfig["settings"]> {
    return {
        ...(settings.compact_completed_turns === undefined
            ? {}
            : { compactCompletedTurns: settings.compact_completed_turns }),
        ...(settings.completion_chime === undefined
            ? {}
            : { completionChime: settings.completion_chime }),
        ...(settings.show_reasoning === undefined
            ? {}
            : { showReasoning: settings.show_reasoning }),
        ...(settings.show_usage === undefined ? {} : { showUsage: settings.show_usage }),
    };
}
