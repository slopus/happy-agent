import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse } from "smol-toml";

const nativeProviderSchema = Type.Object(
    {
        base_url: Type.Optional(Type.String()),
        experimental_bearer_token: Type.Optional(Type.String()),
        requires_openai_auth: Type.Optional(Type.Boolean()),
        wire_api: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const nativeConfigSchema = Type.Object(
    {
        model_provider: Type.Optional(Type.String()),
        model_providers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    },
    { additionalProperties: true },
);

type NativeProvider = Static<typeof nativeProviderSchema>;

export interface NativeCodexProviderConfig {
    baseUrl?: string;
    experimentalBearerToken?: string;
    requiresOpenAiAuth?: boolean;
    wireApi: "responses";
}

export async function loadNativeCodexProviderConfig(
    env: NodeJS.ProcessEnv = process.env,
): Promise<NativeCodexProviderConfig | null> {
    let parsed: unknown;
    try {
        const codexHome = env.CODEX_HOME?.trim();
        const path = join(codexHome || homedir(), codexHome ? "config.toml" : ".codex/config.toml");
        parsed = parse(await readFile(path, "utf8"));
    } catch {
        return null;
    }
    if (!Value.Check(nativeConfigSchema, parsed)) return null;

    const providerId = parsed.model_provider?.trim();
    if (!providerId) return null;
    const provider: unknown = parsed.model_providers?.[providerId];
    if (!Value.Check(nativeProviderSchema, provider)) return null;
    if (provider.wire_api !== undefined && provider.wire_api !== "responses") {
        throw new Error(
            "The selected native Codex provider uses an unsupported wire_api. Rig supports responses only.",
        );
    }
    return normalizeProvider(provider);
}

function normalizeProvider(provider: NativeProvider): NativeCodexProviderConfig {
    const baseUrl = provider.base_url?.trim();
    const experimentalBearerToken = provider.experimental_bearer_token?.trim();
    return {
        ...(baseUrl ? { baseUrl } : {}),
        ...(experimentalBearerToken ? { experimentalBearerToken } : {}),
        ...(provider.requires_openai_auth === undefined
            ? {}
            : { requiresOpenAiAuth: provider.requires_openai_auth }),
        wireApi: "responses",
    };
}
