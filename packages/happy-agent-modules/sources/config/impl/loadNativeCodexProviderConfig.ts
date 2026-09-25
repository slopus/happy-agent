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

export const supportedNativeCodexWireApi = "responses";

export interface NativeCodexProviderConfig {
    baseUrl?: string;
    experimentalBearerToken?: string;
    requiresOpenAiAuth?: boolean;
    wireApi: string;
}

export type NativeCodexCredentialAccess =
    | { apiKey?: string; status: "available" }
    | { status: "unavailable" }
    | { status: "unsupported_wire_api"; wireApi: string };

/** Read the provider selected by the installed Codex CLI without exposing any other account. */
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
    return normalizeProvider(provider);
}

/** Keep endpoint selection and credential disclosure in one shared, fail-closed decision. */
export function resolveNativeCodexCredentialAccess(options: {
    apiKey?: string;
    authFile?: string;
    configuredBaseUrl?: string;
    nativeConfiguration: NativeCodexProviderConfig | null;
}): NativeCodexCredentialAccess {
    const explicitApiKey = options.apiKey?.trim() ? options.apiKey : undefined;
    const available = (apiKey?: string): NativeCodexCredentialAccess => ({
        ...(apiKey === undefined ? {} : { apiKey }),
        status: "available",
    });

    // A Happy endpoint is an explicit replacement for the native Codex provider.
    if (options.configuredBaseUrl !== undefined) return available(explicitApiKey);
    const nativeConfiguration = options.nativeConfiguration;
    if (nativeConfiguration === null) return available(explicitApiKey);
    if (nativeConfiguration.wireApi !== supportedNativeCodexWireApi) {
        return { status: "unsupported_wire_api", wireApi: nativeConfiguration.wireApi };
    }
    if (nativeConfiguration.baseUrl === undefined) return available(explicitApiKey);
    if (explicitApiKey !== undefined) return available(explicitApiKey);
    if (options.authFile !== undefined) return available();
    if (nativeConfiguration.experimentalBearerToken !== undefined) {
        return available(nativeConfiguration.experimentalBearerToken);
    }

    // Match Codex's false-by-default policy for disclosing OpenAI credentials to another host.
    return nativeConfiguration.requiresOpenAiAuth === true
        ? available()
        : { status: "unavailable" };
}

function normalizeProvider(provider: NativeProvider): NativeCodexProviderConfig {
    const baseUrl = provider.base_url?.trim();
    const experimentalBearerToken = provider.experimental_bearer_token?.trim();
    const wireApi = provider.wire_api?.trim();
    return {
        ...(baseUrl ? { baseUrl } : {}),
        ...(experimentalBearerToken ? { experimentalBearerToken } : {}),
        ...(provider.requires_openai_auth === undefined
            ? {}
            : { requiresOpenAiAuth: provider.requires_openai_auth }),
        wireApi: wireApi || supportedNativeCodexWireApi,
    };
}
