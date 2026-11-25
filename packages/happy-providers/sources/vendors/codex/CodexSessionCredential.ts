import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { BaseCredential } from "@/core/BaseCredential.js";
import { CredentialRefresh, waitForCredentialRefresh } from "@/core/impl/credentialRefresh.js";
import { CodexCredentialRefreshError } from "@/vendors/codex/errors/codexErrors.js";
import {
    getCodexAuthPath,
    type CodexQuotaAuth,
    readCodexQuotaAuth,
    readCodexQuotaAuthFile,
} from "@/vendors/codex/impl/auth.js";
import {
    isCodexAuthRefreshDue,
    refreshCodexAuthFile,
} from "@/vendors/codex/impl/refreshCodexAuthFile.js";

const refreshes = new CredentialRefresh<CodexQuotaAuth | undefined>();

/**
 * Logins whose refresh token OpenAI rejected for good, keyed by auth file and fingerprinted by its
 * contents. Maintenance does not spend that token again; any change to the file, such as a new
 * sign-in, lets it try once more.
 */
const permanentFailures = new Map<
    string,
    { fingerprint: string; error: CodexCredentialRefreshError }
>();

export type CodexSessionCredentialValue = {
    readonly accessToken: string;
    readonly accountId?: string;
};

export interface CodexSessionCredentialLoadOptions {
    authFile?: string;
    env?: NodeJS.ProcessEnv;
}

export class CodexSessionCredential extends BaseCredential<
    "codex-session",
    CodexSessionCredentialValue
> {
    readonly authFile: string;
    readonly clientId: string;
    readonly refreshTokenUrl: string;

    static async tryLoad(
        options: CodexSessionCredentialLoadOptions = {},
    ): Promise<CodexSessionCredential | null> {
        const authPath = getCodexAuthPath({
            ...(options.authFile === undefined ? {} : { authFile: options.authFile }),
            ...(options.env === undefined ? {} : { env: options.env }),
        });
        const auth = await readCodexQuotaAuthFile(authPath);
        if (auth === undefined) {
            return null;
        }

        return CodexSessionCredential.fromAuth(auth, {
            authFile: authPath,
            ...(options.env === undefined ? {} : { env: options.env }),
        });
    }

    static fromAuth(
        auth: CodexQuotaAuth,
        options: { authFile: string; env?: NodeJS.ProcessEnv },
    ): CodexSessionCredential {
        const env = options.env ?? process.env;
        return new CodexSessionCredential(
            {
                accessToken: auth.accessToken,
                ...(auth.accountId === undefined ? {} : { accountId: auth.accountId }),
            },
            {
                authFile: options.authFile,
                clientId:
                    env.CODEX_APP_SERVER_LOGIN_CLIENT_ID?.trim() || "app_EMoamEEZ73f0CkXaXp7hrann",
                refreshTokenUrl:
                    env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() ||
                    "https://auth.openai.com/oauth/token",
            },
        );
    }

    async reloadForUnauthorized(): Promise<CodexSessionCredential | undefined> {
        const auth = await readCodexQuotaAuthFile(this.authFile);
        if (auth === undefined || !this.matchesAccount(auth.accountId)) return undefined;
        return this.withAuth(auth);
    }

    async refreshForUnauthorized(): Promise<CodexSessionCredential | undefined> {
        const refreshed = await refreshes.run(this.authFile, async (authFile) => {
            const current = await readCodexQuotaAuthFile(authFile);
            if (current === undefined || !this.matchesAccount(current.accountId)) return undefined;
            // Another session or the native CLI may already have rotated this credential.
            if (current.accessToken !== this.credential.accessToken) return current;
            return await this.exchange(authFile, current);
        });
        if (refreshed === undefined || !this.matchesAccount(refreshed.accountId)) return undefined;
        return this.withAuth(refreshed);
    }

    /**
     * Renew a stored login without inference, sharing work with unauthorized recovery. Unlike
     * recovery, this spends the refresh token only when the login is due, and never again after
     * OpenAI rejected it until the auth file changes.
     */
    async refreshForMaintenance(
        options: { signal?: AbortSignal } = {},
    ): Promise<CodexSessionCredential | undefined> {
        options.signal?.throwIfAborted();
        const refreshed = await waitForCredentialRefresh(
            refreshes.run(this.authFile, (authFile) => this.maintain(authFile)),
            options.signal,
        );
        if (refreshed === undefined || !this.matchesAccount(refreshed.accountId)) return undefined;
        return this.withAuth(refreshed);
    }

    private async maintain(authFile: string): Promise<CodexQuotaAuth | undefined> {
        const contents = await readFile(authFile, "utf8").catch((error: unknown) => {
            if (hasCode(error, "ENOENT")) return undefined;
            throw error;
        });
        if (contents === undefined) return undefined;
        const current = readCodexQuotaAuth(contents);
        if (current === undefined || !this.matchesAccount(current.accountId)) return undefined;
        const fingerprint = createHash("sha256").update(contents).digest("hex");
        const failure = permanentFailures.get(authFile);
        if (failure?.fingerprint === fingerprint) throw failure.error;
        permanentFailures.delete(authFile);
        if (!isCodexAuthRefreshDue(contents, Date.now())) return current;
        try {
            return await this.exchange(authFile, current);
        } catch (error) {
            // A rotation by another owner can also reject our token; only remember the login we sent.
            if (
                error instanceof CodexCredentialRefreshError &&
                error.permanent &&
                (await readFile(authFile, "utf8").catch(() => undefined)) === contents
            ) {
                permanentFailures.set(authFile, { fingerprint, error });
            }
            throw error;
        }
    }

    private async exchange(authFile: string, current: CodexQuotaAuth): Promise<CodexQuotaAuth> {
        try {
            return await refreshCodexAuthFile({
                authFile,
                clientId: this.clientId,
                refreshTokenUrl: this.refreshTokenUrl,
            });
        } catch (error) {
            // An external owner can rotate while our exchange is pending, either invalidating
            // its refresh token or winning the guarded file write. Adopt one newer token only
            // when its account is the one we already know; never retry the exchange or restore
            // a removed/changed login. A failed reread preserves the original refresh error.
            const replacement = await readCodexQuotaAuthFile(authFile).catch(() => undefined);
            if (
                this.credential.accountId !== undefined &&
                replacement?.accountId === this.credential.accountId &&
                replacement.accessToken !== current.accessToken
            ) {
                return replacement;
            }
            throw error;
        }
    }

    private constructor(
        credential: CodexSessionCredentialValue,
        configuration: { authFile: string; clientId: string; refreshTokenUrl: string },
    ) {
        super("codex-session", credential);
        this.authFile = configuration.authFile;
        this.clientId = configuration.clientId;
        this.refreshTokenUrl = configuration.refreshTokenUrl;
    }

    private matchesAccount(accountId: string | undefined): boolean {
        return this.credential.accountId === undefined || this.credential.accountId === accountId;
    }

    private withAuth(auth: { accessToken: string; accountId?: string }): CodexSessionCredential {
        return new CodexSessionCredential(
            {
                accessToken: auth.accessToken,
                ...(auth.accountId === undefined ? {} : { accountId: auth.accountId }),
            },
            {
                authFile: this.authFile,
                clientId: this.clientId,
                refreshTokenUrl: this.refreshTokenUrl,
            },
        );
    }
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
