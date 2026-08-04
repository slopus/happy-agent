import type { CodexCredential } from "@/vendors/VendorCredential.js";
import { CodexApiKeyCredential } from "@/vendors/codex/CodexApiKeyCredential.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";
import { getCodexAuthPath, readCodexAuthFile } from "@/vendors/codex/impl/auth.js";

export interface LoadCodexCredentialOptions {
    apiKey?: string;
    authFile?: string;
    env?: NodeJS.ProcessEnv;
}

export async function loadCodexCredential(
    options: LoadCodexCredentialOptions = {},
): Promise<CodexCredential | null> {
    const env = options.env ?? process.env;
    const explicitApiKey =
        (await tryLoadApiKey(options.apiKey)) ?? (await tryLoadApiKey(env.OPENAI_API_KEY));
    if (explicitApiKey !== null) {
        return explicitApiKey;
    }

    const authFile = getCodexAuthPath({
        env,
        ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
    });
    const storedAuth = await readCodexAuthFile(authFile);
    if (storedAuth === undefined) {
        return null;
    }
    if (storedAuth.authMode === "apikey") {
        return tryLoadApiKey(storedAuth.apiKey);
    }

    return storedAuth.quotaAuth === undefined
        ? null
        : CodexSessionCredential.fromAuth(storedAuth.quotaAuth, { authFile, env });
}

function tryLoadApiKey(apiKey: string | undefined): Promise<CodexApiKeyCredential | null> {
    return CodexApiKeyCredential.tryLoad(apiKey === undefined ? {} : { apiKey });
}
