import { open } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// A settings file is a few kilobytes; anything far larger is not one Claude Code would read.
const MAX_SETTINGS_BYTES = 1024 * 1024;

const settingValueSchema = Type.String();
const claudeSettingsSchema = Type.Object(
    { env: Type.Optional(Type.Record(Type.String(), Type.Unknown())) },
    { additionalProperties: true },
);

export interface ClaudeSettingsEnvironment {
    readonly path: string;
    readonly env: Readonly<Record<string, string>>;
}

/**
 * The `env` block of Claude Code's user settings, which is where people put a gateway's
 * `ANTHROPIC_BASE_URL` and token. Rig starts Claude Code without setting sources, so it never
 * reads this file itself. A missing, unreadable, or invalid file contributes nothing, exactly as
 * an absent block would; only string values are kept.
 */
export async function readClaudeSettingsEnvironment(
    configDirectory: string,
): Promise<ClaudeSettingsEnvironment> {
    const path = join(configDirectory, "settings.json");
    let text: string;
    try {
        const file = await open(path, "r");
        try {
            const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_SETTINGS_BYTES) return { path, env: {} };
            text = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
            await file.close();
        }
    } catch {
        return { path, env: {} };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { path, env: {} };
    }
    if (!Value.Check(claudeSettingsSchema, parsed)) return { path, env: {} };
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.env ?? {})) {
        if (Value.Check(settingValueSchema, value)) env[name] = value;
    }
    return { path, env };
}
