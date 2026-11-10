import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HappyAgentConfigValues } from "../../config/index.js";
import type { ProviderCliId } from "../ProviderCli.js";

type ConfiguredProvider = HappyAgentConfigValues["providers"][string];

/**
 * The variable that points each vendor's program at another account's home folder. Grok's is only
 * read to check an account; adding one needs a folder-based sign-in, which only Claude Code and
 * Codex have.
 */
const HOME_VARIABLES: Partial<Record<ProviderCliId, string>> = {
    claude: "CLAUDE_CONFIG_DIR",
    codex: "CODEX_HOME",
    grok: "GROK_HOME",
};

/** The assistants that can sign in another account in a home folder of its own. */
export type AccountHomeCliId = "claude" | "codex";

export function addsAccountHomes(id: ProviderCliId): id is AccountHomeCliId {
    return id === "claude" || id === "codex";
}

/** The folder an account's own sign-in lives in, when its configuration names one. */
export function accountHome(provider: ConfiguredProvider): string | undefined {
    switch (provider.type) {
        case "claude":
            return provider.configDir;
        case "codex":
        case "grok":
            return provider.authFile === undefined ? undefined : dirname(provider.authFile);
        default:
            return undefined;
    }
}

/** Whether an account carries its own key or token, needing no program sign-in. */
export function hasOwnCredential(provider: ConfiguredProvider): boolean {
    return (
        ("apiKey" in provider && provider.apiKey !== undefined) ||
        ("oauthToken" in provider && provider.oauthToken !== undefined) ||
        ("authToken" in provider && provider.authToken !== undefined)
    );
}

/** The program's environment pointed at one account's home folder. */
export function accountEnvironment(
    id: ProviderCliId,
    home: string,
    env: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
    const variable = HOME_VARIABLES[id];
    return variable === undefined ? env : { ...env, [variable]: home };
}

/**
 * Make the home folder for another account: `~/.claude-N` or `~/.codex-N`, the names the vendors'
 * own multi-account setups use, with the provider ID `claude_N` or `codex_N`, for the lowest N from
 * 2 whose ID is free and whose folder is missing or empty. An empty folder is one an abandoned
 * attempt left behind.
 */
export async function allocateAccountHome(
    id: AccountHomeCliId,
    home: string,
    taken: (providerId: string) => boolean,
): Promise<{ readonly providerId: string; readonly home: string }> {
    for (let n = 2; n < 100; n += 1) {
        const providerId = `${id}_${n}`;
        if (taken(providerId)) continue;
        const folder = join(home, `.${id}-${n}`);
        try {
            await mkdir(folder, { mode: 0o700 });
            return { providerId, home: folder };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const entries = await readdir(folder).catch(() => undefined);
        if (entries?.length === 0) return { providerId, home: folder };
    }
    throw new Error("No free folder is left for another account.");
}

/** The provider table that runs a newly signed-in account from its home folder. */
export function accountProviderTable(
    id: AccountHomeCliId,
    name: string,
    home: string,
): Readonly<Record<string, unknown>> {
    return id === "claude"
        ? { type: "claude", name, config_dir: home }
        : { type: "codex", name, auth_file: join(home, "auth.json") };
}
