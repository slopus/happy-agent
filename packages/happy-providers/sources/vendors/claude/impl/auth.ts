import { execFileHidden } from "@/core/hiddenChildProcess.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileHidden);
const MACOS_KEYCHAIN_TIMEOUT_MS = 500;
const MACOS_KEYCHAIN_ATTEMPTS = 3;
const MACOS_KEYCHAIN_RETRY_DELAY_MS = 20;

interface ClaudeCodeCredentials {
    claudeAiOauth?: {
        accessToken?: string;
        scopes?: unknown;
    };
}

/** A Claude Code OAuth token and what is known about the grant behind it. */
export interface ClaudeCodeOAuthCredential {
    accessToken: string;
    /**
     * `environment` is a `CLAUDE_CODE_OAUTH_TOKEN`, which `claude setup-token` issues for
     * inference only. `login` is the credential `claude auth login` stores.
     */
    source: "environment" | "login";
    /** The OAuth scopes the stored login was granted, or undefined when it does not say. */
    scopes: readonly string[] | undefined;
}

export interface ReadClaudeCodeOAuthTokenOptions {
    env?: NodeJS.ProcessEnv;
}

export function getClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

export function parseClaudeOAuthAccessToken(value: string): string | undefined {
    return parseClaudeOAuthCredential(value)?.accessToken;
}

function parseClaudeOAuthCredential(value: string): ClaudeCodeOAuthCredential | undefined {
    try {
        const credentials = JSON.parse(value) as ClaudeCodeCredentials;
        const token = credentials.claudeAiOauth?.accessToken;
        if (typeof token !== "string" || token.trim().length === 0) return undefined;
        const scopes = credentials.claudeAiOauth?.scopes;
        return {
            accessToken: token,
            source: "login",
            scopes: Array.isArray(scopes)
                ? scopes.filter((scope): scope is string => typeof scope === "string")
                : undefined,
        };
    } catch {
        return undefined;
    }
}

export async function readClaudeCodeOAuthToken(
    options: ReadClaudeCodeOAuthTokenOptions = {},
): Promise<string | undefined> {
    return (await readClaudeCodeOAuthCredential(options))?.accessToken;
}

/** Reads the native Claude Code token together with the kind of grant it came from. */
export async function readClaudeCodeOAuthCredential(
    options: ReadClaudeCodeOAuthTokenOptions = {},
): Promise<ClaudeCodeOAuthCredential | undefined> {
    const env = options.env ?? process.env;
    if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
        return {
            accessToken: env.CLAUDE_CODE_OAUTH_TOKEN,
            source: "environment",
            scopes: undefined,
        };
    }

    const configDirectory = getClaudeConfigDir(env);

    if (process.platform === "darwin") {
        const keychainCredential = await readCredentialFromMacOsKeychain(configDirectory, env);
        if (keychainCredential !== undefined) {
            return keychainCredential;
        }
    }

    try {
        return parseClaudeOAuthCredential(
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
    /** How long one `security` child may run, launch included; tests not about the deadline lift it. */
    attemptTimeoutMs = MACOS_KEYCHAIN_TIMEOUT_MS,
): Promise<string | undefined> {
    return (await readCredentialFromMacOsKeychain(configDirectory, env, attemptTimeoutMs))
        ?.accessToken;
}

async function readCredentialFromMacOsKeychain(
    configDirectory: string,
    env: NodeJS.ProcessEnv,
    attemptTimeoutMs = MACOS_KEYCHAIN_TIMEOUT_MS,
): Promise<ClaudeCodeOAuthCredential | undefined> {
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
        const credential = await readCredentialFromMacOsKeychainOnce(
            account,
            service,
            attemptTimeoutMs,
        );
        if (credential !== undefined) {
            return credential;
        }

        if (attempt < MACOS_KEYCHAIN_ATTEMPTS) {
            await delay(MACOS_KEYCHAIN_RETRY_DELAY_MS * attempt);
        }
    }

    return undefined;
}

async function readCredentialFromMacOsKeychainOnce(
    account: string,
    service: string,
    timeoutMs: number,
): Promise<ClaudeCodeOAuthCredential | undefined> {
    try {
        const { stdout } = await execFileAsync(
            "security",
            ["find-generic-password", "-a", account, "-w", "-s", service],
            {
                encoding: "utf8",
                killSignal: "SIGKILL",
                timeout: timeoutMs,
            },
        );
        return parseClaudeOAuthCredential(stdout);
    } catch {
        return undefined;
    }
}

function isFileNotFound(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
