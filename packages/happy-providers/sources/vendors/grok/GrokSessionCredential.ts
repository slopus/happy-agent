import { BaseCredential } from "@/core/BaseCredential.js";
import {
    CredentialRefresh,
    credentialRefreshRequest,
    readCredentialRefreshJson,
    waitForCredentialRefresh,
} from "@/core/impl/credentialRefresh.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { unlink } from "node:fs/promises";
import {
    GROK_OAUTH_SCOPE,
    getGrokAuthPath,
    isGrokAuthExpired,
    readGrokAuthStore,
    type GrokAuthRecord,
} from "@/vendors/grok/impl/auth.js";
import { writeGrokAuthRecord } from "@/vendors/grok/impl/writeGrokAuthRecord.js";

/** Refresh this far ahead of expiry so a request cannot race the cutoff. */
const EARLY_REFRESH_MS = 5 * 60 * 1_000;
const refreshes = new CredentialRefresh<{ path: string; record: GrokAuthRecord } | undefined>();
const discoverySchema = Type.Object({ token_endpoint: Type.String({ minLength: 1 }) });
const tokensSchema = Type.Object({
    access_token: Type.String({ minLength: 1 }),
    expires_in: Type.Optional(Type.Number({ minimum: 0 })),
    refresh_token: Type.Optional(Type.String({ minLength: 1 })),
});

export type GrokSessionCredentialValue = {
    readonly source: "session";
    token: string;
};

export interface GrokSessionCredentialLoadOptions {
    authFile?: string;
    env?: NodeJS.ProcessEnv;
    recoveryAuthFile?: string;
}

export class GrokSessionCredential extends BaseCredential<
    "grok-session",
    GrokSessionCredentialValue
> {
    private authPath: string;
    private readonly recoveryAuthFile: string | undefined;
    private record: GrokAuthRecord;

    static async tryLoad(
        options: GrokSessionCredentialLoadOptions = {},
    ): Promise<GrokSessionCredential | null> {
        const env = options.env ?? process.env;
        const authPath = getGrokAuthPath({
            ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
            env,
        });
        let selectedAuthPath = authPath;
        if (options.recoveryAuthFile !== undefined) {
            const recovered = (await readGrokAuthStore(options.recoveryAuthFile))[GROK_OAUTH_SCOPE];
            if (recovered !== undefined) {
                try {
                    await writeGrokAuthRecord(authPath, GROK_OAUTH_SCOPE, recovered);
                    await unlink(options.recoveryAuthFile).catch(() => undefined);
                } catch {
                    selectedAuthPath = options.recoveryAuthFile;
                }
            }
        }
        const store = await readGrokAuthStore(selectedAuthPath);
        const session = store[GROK_OAUTH_SCOPE];
        if (typeof session?.key !== "string" || session.key.trim().length === 0) {
            return null;
        }

        return new GrokSessionCredential(
            { source: "session", token: session.key },
            selectedAuthPath,
            session,
            options.recoveryAuthFile,
        );
    }

    /**
     * Renews the token before it is sent upstream when the stored expiry has passed or
     * is about to. Failure is not fatal: the request proceeds with the current token so
     * the upstream response decides the outcome.
     */
    async ensureFresh(options: { now?: number } = {}): Promise<void> {
        const expired = isGrokAuthExpired(this.record, {
            earlyInvalidationMs: EARLY_REFRESH_MS,
            ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (!expired) return;
        await this.refresh();
    }

    /** Refreshes an exported access lease only when its rotated owner state was saved durably. */
    async ensureFreshForLease(options: { now?: number } = {}): Promise<void> {
        const expired = isGrokAuthExpired(this.record, {
            earlyInvalidationMs: EARLY_REFRESH_MS,
            ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (!expired) return;
        if (!(await this.refresh())) {
            throw new Error("Grok could not durably refresh the exported access-token lease.");
        }
    }

    async refreshAfterUnauthorized(): Promise<boolean> {
        return this.refresh();
    }

    /** Rotate a stored login without inference, sharing work with all sessions using its file. */
    async refreshForMaintenance(options: { signal?: AbortSignal } = {}): Promise<boolean> {
        options.signal?.throwIfAborted();
        return await waitForCredentialRefresh(this.refresh(), options.signal);
    }

    /** Collapses concurrent callers onto one exchange so the refresh token is spent once. */
    private async refresh(): Promise<boolean> {
        const refreshed = await refreshes
            .run(this.authPath, (path) => this.performRefresh(path))
            .catch(() => undefined);
        if (refreshed === undefined) return false;
        this.authPath = refreshed.path;
        this.record = refreshed.record;
        this.credential.token = refreshed.record.key!;
        return true;
    }

    private async performRefresh(
        path: string,
    ): Promise<{ path: string; record: GrokAuthRecord } | undefined> {
        const disk = (await readGrokAuthStore(path))[GROK_OAUTH_SCOPE];
        // A sign-out is authoritative; never recreate a deleted login from an in-memory token.
        if (disk === undefined) return undefined;
        if (
            typeof disk?.key === "string" &&
            disk.key !== this.credential.token &&
            !isGrokAuthExpired(disk)
        ) {
            return { path, record: disk };
        }

        const record = disk;
        const refreshToken = stringField(record, "refresh_token");
        const issuer = stringField(record, "oidc_issuer");
        const clientId = stringField(record, "oidc_client_id");
        if (refreshToken === undefined || issuer === undefined || clientId === undefined) {
            return undefined;
        }

        const tokens = await requestGrokTokens(issuer, clientId, refreshToken);
        if (tokens === undefined) return undefined;

        const current = (await readGrokAuthStore(path))[GROK_OAUTH_SCOPE];
        if (
            current === undefined ||
            current.key !== record.key ||
            current.refresh_token !== record.refresh_token
        ) {
            return undefined;
        }

        const patch: GrokAuthRecord = {
            key: tokens.accessToken,
            ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
            ...(tokens.expiresAt === undefined ? {} : { expires_at: tokens.expiresAt }),
        };
        try {
            await writeGrokAuthRecord(path, GROK_OAUTH_SCOPE, patch);
        } catch {
            if (this.recoveryAuthFile === undefined || this.recoveryAuthFile === path) {
                return undefined;
            }
            try {
                await writeGrokAuthRecord(this.recoveryAuthFile, GROK_OAUTH_SCOPE, {
                    ...record,
                    ...patch,
                });
                path = this.recoveryAuthFile;
            } catch {
                return undefined;
            }
        }
        return { path, record: { ...record, ...patch } };
    }

    private constructor(
        credential: GrokSessionCredentialValue,
        authPath: string,
        record: GrokAuthRecord,
        recoveryAuthFile?: string,
    ) {
        super("grok-session", credential);
        this.authPath = authPath;
        this.record = record;
        this.recoveryAuthFile = recoveryAuthFile;
    }
}

async function requestGrokTokens(
    issuer: string,
    clientId: string,
    refreshToken: string,
): Promise<{ accessToken: string; expiresAt?: string; refreshToken?: string } | undefined> {
    try {
        return await credentialRefreshRequest(async (signal) => {
            const discovery = await fetch(
                `${issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`,
                { signal },
            );
            if (!discovery.ok) {
                await discovery.body?.cancel();
                return undefined;
            }
            const metadata = await readCredentialRefreshJson(discovery);
            if (!Value.Check(discoverySchema, metadata)) return undefined;

            const response = await fetch(metadata.token_endpoint, {
                method: "POST",
                signal,
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                    client_id: clientId,
                }),
            });
            if (!response.ok) {
                await response.body?.cancel();
                return undefined;
            }
            const tokens = await readCredentialRefreshJson(response);
            if (!Value.Check(tokensSchema, tokens)) {
                return undefined;
            }
            return {
                accessToken: tokens.access_token,
                ...(tokens.expires_in !== undefined
                    ? { expiresAt: new Date(Date.now() + tokens.expires_in * 1_000).toISOString() }
                    : {}),
                ...(tokens.refresh_token !== undefined
                    ? { refreshToken: tokens.refresh_token }
                    : {}),
            };
        });
    } catch {
        return undefined;
    }
}

function stringField(record: GrokAuthRecord, name: string): string | undefined {
    const value = record[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
