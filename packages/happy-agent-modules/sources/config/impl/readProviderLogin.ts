import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { execFileHidden } from "../../utils/hiddenChildProcess.js";

const execFileAsync = promisify(execFileHidden);

/** A credential file larger than this is not a login this reader understands. */
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
const MACOS_KEYCHAIN_TIMEOUT_MS = 1_000;
const GROK_OAUTH_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const GROK_API_KEY_SCOPE = "xai::api_key";

/** When a stored login was last renewed and when its access token expires, as epoch ms. */
export interface ProviderLoginTimes {
    readonly refreshedAt: number | null;
    readonly expiresAt: number | null;
}

/** The sign-in an account is configured to use, or `none` when it uses no login at all. */
export type ProviderLoginLocation =
    | { readonly kind: "codex"; readonly authFile: string }
    | { readonly kind: "grok"; readonly authFile: string }
    | {
          readonly kind: "claude";
          /** The folder Claude Code was pointed at, or undefined for its own default. */
          readonly configDir: string | undefined;
          readonly defaultConfigDir: string;
          readonly customOAuth: boolean;
          readonly user: string | undefined;
      }
    | { readonly kind: "setup_token" }
    | { readonly kind: "none" };

const codexAuthSchema = Type.Object({
    tokens: Type.Object({ access_token: Type.String({ minLength: 1 }) }),
    last_refresh: Type.Optional(Type.Unknown()),
});
const jwtClaimsSchema = Type.Object({ exp: Type.Number() });
const grokRecordSchema = Type.Object({
    key: Type.Optional(Type.String()),
    expires_at: Type.Optional(Type.Unknown()),
});
const grokStoreSchema = Type.Record(Type.String(), Type.Unknown());
const claudeCredentialsSchema = Type.Object({
    claudeAiOauth: Type.Object({
        accessToken: Type.String({ minLength: 1 }),
        expiresAt: Type.Optional(Type.Unknown()),
    }),
});

/**
 * Read when one account's login was last renewed and when its access token expires.
 *
 * Only those two instants leave this function; tokens are parsed only to find them. Undefined
 * means the account has no login to describe: it uses an API key, or its credential is missing or
 * unreadable.
 */
export async function readProviderLogin(
    location: ProviderLoginLocation,
): Promise<ProviderLoginTimes | undefined> {
    switch (location.kind) {
        case "none":
            return undefined;
        case "setup_token":
            // A pasted setup token says nothing about when it was issued or when it expires.
            return { refreshedAt: null, expiresAt: null };
        case "codex": {
            const file = await readJsonFile(location.authFile, codexAuthSchema);
            if (file === undefined) return undefined;
            return {
                refreshedAt: parseInstant(file.value.last_refresh),
                expiresAt: readJwtExpiry(file.value.tokens.access_token),
            };
        }
        case "grok": {
            const file = await readJsonFile(location.authFile, grokStoreSchema);
            if (file === undefined) return undefined;
            // A stored API key outranks the sign-in, exactly as the provider loads it.
            const apiKey = file.value[GROK_API_KEY_SCOPE];
            if (Value.Check(grokRecordSchema, apiKey) && (apiKey.key?.trim().length ?? 0) > 0) {
                return undefined;
            }
            const record = file.value[GROK_OAUTH_SCOPE];
            if (!Value.Check(grokRecordSchema, record) || (record.key?.length ?? 0) === 0) {
                return undefined;
            }
            // Grok records no renewal time; the file is rewritten by every sign-in and renewal.
            return { refreshedAt: file.modifiedAt, expiresAt: parseInstant(record.expires_at) };
        }
        case "claude": {
            // Claude Code on macOS keeps its login in the keychain and falls back to the file,
            // and so does the provider that uses it.
            if (process.platform === "darwin") {
                const stored = await readClaudeKeychainExpiry(location);
                if (stored !== undefined) return { refreshedAt: null, expiresAt: stored };
            }
            const file = await readJsonFile(
                join(location.configDir ?? location.defaultConfigDir, ".credentials.json"),
                claudeCredentialsSchema,
            );
            if (file === undefined) return undefined;
            // Claude Code rewrites the file on every sign-in and renewal and records no time.
            return {
                refreshedAt: file.modifiedAt,
                expiresAt: parseInstant(file.value.claudeAiOauth.expiresAt),
            };
        }
    }
}

async function readJsonFile<Schema extends TSchema>(
    path: string,
    schema: Schema,
): Promise<{ readonly value: Static<Schema>; readonly modifiedAt: number } | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(path, "r");
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_CREDENTIAL_FILE_BYTES) return undefined;
        const value: unknown = JSON.parse(await handle.readFile("utf8"));
        if (!Value.Check(schema, value)) return undefined;
        return { value, modifiedAt: Math.trunc(stats.mtimeMs) };
    } catch {
        // A missing, unreadable, or malformed credential has no login to describe. Its contents
        // must never reach an error message.
        return undefined;
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/** The `exp` claim of a JWT access token, in epoch ms. The signature is irrelevant here. */
function readJwtExpiry(token: string): number | null {
    const payload = token.split(".")[1];
    if (payload === undefined) return null;
    try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Value.Check(jwtClaimsSchema, claims) && Number.isFinite(claims.exp)
            ? Math.trunc(claims.exp * 1_000)
            : null;
    } catch {
        return null;
    }
}

/** An ISO date string or an epoch-ms number, as epoch ms. */
function parseInstant(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The expiry of the login Claude Code stored in the macOS keychain, named the way Claude Code
 * names it: a custom OAuth server and a chosen config folder each get their own item.
 */
async function readClaudeKeychainExpiry(
    location: Extract<ProviderLoginLocation, { kind: "claude" }>,
): Promise<number | null | undefined> {
    const folder =
        location.configDir === undefined
            ? ""
            : `-${createHash("sha256").update(location.configDir).digest("hex").slice(0, 8)}`;
    const service = `Claude Code${location.customOAuth ? "-custom-oauth" : ""}-credentials${folder}`;
    try {
        const { stdout } = await execFileAsync(
            "security",
            [
                "find-generic-password",
                "-a",
                location.user ?? userInfo().username,
                "-s",
                service,
                "-w",
            ],
            { encoding: "utf8", timeout: MACOS_KEYCHAIN_TIMEOUT_MS },
        );
        const value: unknown = JSON.parse(stdout);
        if (!Value.Check(claudeCredentialsSchema, value)) return undefined;
        return parseInstant(value.claudeAiOauth.expiresAt);
    } catch {
        return undefined;
    }
}
