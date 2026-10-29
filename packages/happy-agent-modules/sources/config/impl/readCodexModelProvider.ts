import { open } from "node:fs/promises";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "smol-toml";

// Codex's own configuration is small; a file far larger than this is not one worth parsing.
const MAX_CONFIG_BYTES = 1024 * 1024;

const nonEmptyString = Type.String({ minLength: 1, pattern: "\\S" });
const urlString = Type.String({ pattern: "^\\s*https?://\\S+\\s*$" });
// Codex refuses to let configuration redefine these, so a table under one of their names is inert.
const BUILT_IN_PROVIDERS = new Set([
    "amazon-bedrock",
    "amazon-bedrock-runtime",
    "gcp",
    "lmstudio",
    "ollama",
]);
const modelProviderSchema = Type.Object(
    {
        base_url: Type.Optional(urlString),
        env_key: Type.Optional(nonEmptyString),
        experimental_bearer_token: Type.Optional(nonEmptyString),
        requires_openai_auth: Type.Optional(Type.Boolean()),
        supports_websockets: Type.Optional(Type.Boolean()),
        wire_api: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);
const codexConfigSchema = Type.Object(
    {
        model_provider: Type.Optional(nonEmptyString),
        model_providers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        openai_base_url: Type.Optional(urlString),
        profile: Type.Optional(nonEmptyString),
        profiles: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    },
    { additionalProperties: true },
);
const profileSchema = Type.Object(
    { model_provider: Type.Optional(nonEmptyString) },
    { additionalProperties: true },
);
type CodexModelProviderTable = Static<typeof modelProviderSchema>;

/** The endpoint Codex itself would call, when it is not OpenAI's own default. */
export type CodexModelProvider =
    | {
          /** The built-in OpenAI provider pointed at another base URL. */
          readonly kind: "openai";
          readonly baseUrl: string;
          /** The configuration file consulted, when it named the URL. */
          readonly path?: string;
      }
    | {
          /** A `[model_providers.<id>]` entry selected by `model_provider`. */
          readonly kind: "custom";
          readonly baseUrl: string;
          readonly bearerToken?: string;
          readonly envKey?: string;
          readonly path: string;
          readonly requiresOpenAIAuth: boolean;
          readonly supportsWebsockets: boolean;
      };

/**
 * Reads the provider Codex is set up to use from `config.toml` in the Codex home, then
 * `OPENAI_BASE_URL`. Only what Rig can speak is returned: a custom provider must name a
 * `base_url` and use the Responses API, which is the only wire API Codex still accepts. Built-in
 * providers other than OpenAI, and configurations Rig cannot read, return null so discovery keeps
 * its ordinary behaviour.
 */
export async function readCodexModelProvider(
    codexHome: string,
    env: NodeJS.ProcessEnv,
): Promise<CodexModelProvider | null> {
    const path = join(codexHome, "config.toml");
    const config = await readConfig(path);
    const profile =
        config?.profile === undefined ? undefined : config.profiles?.[config.profile.trim()];
    const profileProvider = Value.Check(profileSchema, profile)
        ? profile.model_provider
        : undefined;
    const providerId = (profileProvider ?? config?.model_provider)?.trim() ?? "openai";
    if (providerId === "openai") {
        const configured = config?.openai_base_url?.trim();
        if (configured !== undefined)
            return { kind: "openai", baseUrl: trimSlash(configured), path };
        const environment = env.OPENAI_BASE_URL?.trim();
        return environment && Value.Check(urlString, environment)
            ? { kind: "openai", baseUrl: trimSlash(environment) }
            : null;
    }
    if (BUILT_IN_PROVIDERS.has(providerId)) return null;
    const table = config?.model_providers?.[providerId];
    if (!Value.Check(modelProviderSchema, table)) return null;
    return customProvider(table, path);
}

function customProvider(table: CodexModelProviderTable, path: string): CodexModelProvider | null {
    if (table.base_url === undefined) return null;
    if (table.wire_api !== undefined && table.wire_api !== "responses") return null;
    return {
        kind: "custom",
        baseUrl: trimSlash(table.base_url.trim()),
        ...(table.experimental_bearer_token === undefined
            ? {}
            : { bearerToken: table.experimental_bearer_token.trim() }),
        ...(table.env_key === undefined ? {} : { envKey: table.env_key.trim() }),
        path,
        requiresOpenAIAuth: table.requires_openai_auth === true,
        supportsWebsockets: table.supports_websockets === true,
    };
}

async function readConfig(path: string): Promise<Static<typeof codexConfigSchema> | null> {
    let text: string;
    try {
        const file = await open(path, "r");
        try {
            const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > MAX_CONFIG_BYTES) return null;
            text = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
            await file.close();
        }
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = parse(text);
    } catch {
        return null;
    }
    return Value.Check(codexConfigSchema, parsed) ? parsed : null;
}

function trimSlash(url: string): string {
    return url.replace(/\/+$/u, "");
}
