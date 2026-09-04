import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MACOS_KEYCHAIN_TIMEOUT_MS = 500;
const MACOS_KEYCHAIN_ATTEMPTS = 3;
const MACOS_KEYCHAIN_RETRY_DELAY_MS = 20;

interface ClaudeCodeCredentials {
    claudeAiOauth?: {
        accessToken?: string;
    };
}

export interface ReadClaudeCodeOAuthTokenOptions {
    env?: NodeJS.ProcessEnv;
}

export function getClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

export function parseClaudeOAuthAccessToken(value: string): string | undefined {
    try {
        const credentials = JSON.parse(value) as ClaudeCodeCredentials;
        const token = credentials.claudeAiOauth?.accessToken;
        return typeof token === "string" && token.trim().length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}

export async function readClaudeCodeOAuthToken(
    options: ReadClaudeCodeOAuthTokenOptions = {},
): Promise<string | undefined> {
    const env = options.env ?? process.env;
    if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        return env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    const configDirectory = getClaudeConfigDir(env);

    if (process.platform === "darwin") {
        const keychainToken = await readTokenFromMacOsKeychain(configDirectory, env);
        if (keychainToken !== undefined) {
            return keychainToken;
        }
    }

    try {
        return parseClaudeOAuthAccessToken(
            await readFile(join(configDirectory, ".credentials.json"), "utf8"),
        );
    } catch (error) {
        if (isFileNotFound(error)) {
            return undefined;
        }
        throw error;
    }
}

export async function readTokenFromMacOsKeychain(
    configDirectory: string,
    env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    const defaultDirectory = env.CLAUDE_CONFIG_DIR === undefined;
    const directorySuffix = defaultDirectory
        ? ""
        : `-${createHash("sha256").update(configDirectory).digest("hex").slice(0, 8)}`;
    const oauthSuffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
    const service = `Claude Code${oauthSuffix}-credentials${directorySuffix}`;
    const account = env.USER ?? userInfo().username;

    // Claude Code stores a refreshed token with `security add-generic-password -U`, which deletes
    // the item and adds it again. A read landing in that window fails with errSecItemNotFound for a
    // credential that is present and valid, and `security` itself occasionally dies on a signal.
    // Claude Code absorbs both behind a cache that keeps serving the last value it read; this
    // function has no cache, so a single swallowed failure is reported to the caller as a missing
    // credential. Retry instead, since the window closes within milliseconds.
    for (let attempt = 1; attempt <= MACOS_KEYCHAIN_ATTEMPTS; attempt++) {
        const token = await readTokenFromMacOsKeychainOnce(account, service);
        if (token !== undefined) {
            return token;
        }

        if (attempt < MACOS_KEYCHAIN_ATTEMPTS) {
            await delay(MACOS_KEYCHAIN_RETRY_DELAY_MS * attempt);
        }
    }

    return undefined;
}

async function readTokenFromMacOsKeychainOnce(
    account: string,
    service: string,
): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync(
            "security",
            ["find-generic-password", "-a", account, "-w", "-s", service],
            {
                encoding: "utf8",
                killSignal: "SIGKILL",
                timeout: MACOS_KEYCHAIN_TIMEOUT_MS,
            },
        );
        return parseClaudeOAuthAccessToken(stdout);
    } catch {
        return undefined;
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isFileNotFound(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
