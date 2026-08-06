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
    const explicitApiKey = await tryLoadApiKey(options.apiKey);
    if (explicitApiKey !== null) {
        return explicitApiKey;
    }

    const authFile = getCodexAuthPath({
        env,
        ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
    });
    const storedAuth = await readCodexAuthFile(authFile);

    /*
     * A ChatGPT login outranks OPENAI_API_KEY because the two bill differently:
     * the session spends the subscription the user already pays for, while the
     * environment key bills per token. Developers routinely export OPENAI_API_KEY
     * for unrelated tooling, so letting an ambient value win here would silently
     * move a Plus/Pro subscriber onto metered API billing. `options.apiKey` is a
     * deliberate per-call choice and still wins above; the key stored inside an
     * `auth_mode: "apikey"` file is not a subscription, so the environment still
     * outranks it below.
     */
    if (storedAuth?.authMode === "session" && storedAuth.quotaAuth !== undefined) {
        return CodexSessionCredential.fromAuth(storedAuth.quotaAuth, { authFile, env });
    }

    const environmentApiKey = await tryLoadApiKey(env.OPENAI_API_KEY);
    if (environmentApiKey !== null) {
        return environmentApiKey;
    }

    return storedAuth?.authMode === "apikey" ? tryLoadApiKey(storedAuth.apiKey) : null;
}

function tryLoadApiKey(apiKey: string | undefined): Promise<CodexApiKeyCredential | null> {
    return CodexApiKeyCredential.tryLoad(apiKey === undefined ? {} : { apiKey });
}
