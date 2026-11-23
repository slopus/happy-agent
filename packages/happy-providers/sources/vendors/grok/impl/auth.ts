import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_API_KEY_SCOPE = "xai::api_key";
export const GROK_OAUTH_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

export interface GrokAuthRecord {
    auth_mode?: "api_key" | "external" | "oidc";
    create_time?: string;
    expires_at?: string;
    key?: string;
    refresh_token?: string;
    [key: string]: unknown;
}

export type GrokAuthStore = Record<string, GrokAuthRecord>;

export function getGrokAuthPath(
    options: { authFile?: string; env?: NodeJS.ProcessEnv } = {},
): string {
    if (options.authFile?.trim()) return options.authFile;

    const grokHome = options.env?.GROK_HOME?.trim();
    return join(grokHome || homedir(), grokHome ? "auth.json" : ".grok/auth.json");
}

export async function readGrokAuthStore(path: string): Promise<GrokAuthStore> {
    try {
        const source = (await readFile(path, "utf8")).replace(/^\uFEFF/u, "");
        if (source.trim().length === 0) return {};
        const value: unknown = JSON.parse(source);
        if (value === null || Array.isArray(value) || typeof value !== "object") {
            return {};
        }
        return value as GrokAuthStore;
    } catch (error) {
        if (isFileNotFound(error)) return {};
        throw error;
    }
}

export function isGrokAuthExpired(
    record: GrokAuthRecord,
    options: { earlyInvalidationMs?: number; now?: number } = {},
): boolean {
    const now = options.now ?? Date.now();
    const buffer = options.earlyInvalidationMs ?? 0;
    const expiresAt = parseTime(record.expires_at);
    if (expiresAt !== undefined) return now >= expiresAt - buffer;

    const createdAt = parseTime(record.create_time);
    const fallbackTtlMs = 30 * 24 * 60 * 60 * 1_000;
    return createdAt === undefined || now >= createdAt + fallbackTtlMs - buffer;
}

function parseTime(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isFileNotFound(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}
