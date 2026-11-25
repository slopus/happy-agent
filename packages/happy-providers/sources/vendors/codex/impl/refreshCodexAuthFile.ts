import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    credentialRefreshRequest,
    readCredentialRefreshJson,
} from "@/core/impl/credentialRefresh.js";

import { readCodexCredentialRefreshError } from "@/vendors/codex/errors/codexErrors.js";
import { readCodexQuotaAuth, type CodexQuotaAuth } from "@/vendors/codex/impl/auth.js";

const authSchema = Type.Object(
    {
        last_refresh: Type.Optional(Type.Unknown()),
        tokens: Type.Object(
            {
                access_token: Type.Optional(Type.String()),
                account_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                id_token: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                refresh_token: Type.String({ minLength: 1 }),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);
const responseSchema = Type.Object(
    {
        access_token: Type.String({ minLength: 1 }),
        id_token: Type.Optional(Type.String()),
        refresh_token: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: true },
);

const jwtClaimsSchema = Type.Object({ exp: Type.Number() }, { additionalProperties: true });

/**
 * Background maintenance has no check before each request like the Codex CLI's five-minute one,
 * so it renews a token that would otherwise lapse before a pass hours away comes round again.
 */
const MAINTENANCE_EXPIRY_WINDOW_MS = 4 * 60 * 60 * 1_000;
/** The Codex CLI's `TOKEN_REFRESH_INTERVAL`: a login not renewed for eight days is renewed. */
const MAINTENANCE_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1_000;

/**
 * Whether background maintenance should spend the refresh token now. ChatGPT refresh tokens are
 * single-use, so renewing a healthy login only invalidates every other holder of the file. A login
 * whose expiry or last renewal cannot be read is renewed.
 */
export function isCodexAuthRefreshDue(contents: string, now: number): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return true;
    }
    if (!Value.Check(authSchema, parsed)) return true;
    const lastRefresh =
        typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : Number.NaN;
    if (!Number.isFinite(lastRefresh) || now - lastRefresh >= MAINTENANCE_REFRESH_INTERVAL_MS) {
        return true;
    }
    const expiresAt = readJwtExpiry(parsed.tokens.access_token);
    return expiresAt === undefined || expiresAt - now <= MAINTENANCE_EXPIRY_WINDOW_MS;
}

function readJwtExpiry(token: string | undefined): number | undefined {
    const payload = token?.split(".")[1];
    if (payload === undefined) return undefined;
    try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Value.Check(jwtClaimsSchema, claims) ? claims.exp * 1_000 : undefined;
    } catch {
        return undefined;
    }
}

export async function refreshCodexAuthFile(options: {
    authFile: string;
    clientId: string;
    refreshTokenUrl: string;
}): Promise<CodexQuotaAuth> {
    const contents = await readFile(options.authFile, "utf8");
    const parsed: unknown = JSON.parse(contents);
    if (!Value.Check(authSchema, parsed)) {
        throw new Error("Codex authentication is missing a refresh token.");
    }
    const body = await credentialRefreshRequest(async (signal) => {
        const response = await fetch(options.refreshTokenUrl, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                client_id: options.clientId,
                grant_type: "refresh_token",
                refresh_token: parsed.tokens.refresh_token,
            }),
        });
        if (!response.ok) {
            // Keep only the OAuth error code; the body is bounded like a successful one.
            const failure = await readCredentialRefreshJson(response).catch(() => undefined);
            throw readCodexCredentialRefreshError(response.status, failure);
        }
        const body = await readCredentialRefreshJson(response);
        if (!Value.Check(responseSchema, body)) {
            throw new Error("Codex token refresh did not return an access token.");
        }
        return body;
    });

    // Do not resurrect a sign-out or overwrite credentials changed while the network was busy.
    if ((await readFile(options.authFile, "utf8")) !== contents) {
        throw new Error("Codex authentication changed during token refresh.");
    }

    const tokens = parsed.tokens;
    tokens.access_token = body.access_token;
    if (typeof body.id_token === "string") tokens.id_token = body.id_token;
    if (typeof body.refresh_token === "string") tokens.refresh_token = body.refresh_token;
    parsed.last_refresh = new Date().toISOString();

    const temporaryPath = `${options.authFile}.${process.pid}.${randomUUID()}.tmp`;
    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
        await temporary.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
        await temporary.sync();
    } finally {
        await temporary.close();
    }
    try {
        await rename(temporaryPath, options.authFile);
        await chmod(options.authFile, 0o600);
    } finally {
        await unlink(temporaryPath).catch((error: unknown) => {
            if (!hasCode(error, "ENOENT")) throw error;
        });
    }

    const refreshed = readCodexQuotaAuth(JSON.stringify(parsed));
    if (refreshed === undefined)
        throw new Error("Codex authentication was invalid after token refresh.");
    return refreshed;
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
