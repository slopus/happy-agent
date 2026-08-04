import { BaseCredential } from "@/core/BaseCredential.js";
import {
    getCodexAuthPath,
    type CodexQuotaAuth,
    readCodexQuotaAuthFile,
} from "@/vendors/codex/impl/auth.js";
import { refreshCodexAuthFile } from "@/vendors/codex/impl/refreshCodexAuthFile.js";

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
        const current = await readCodexQuotaAuthFile(this.authFile);
        if (current === undefined || !this.matchesAccount(current.accountId)) return undefined;
        const refreshed = await refreshCodexAuthFile({
            authFile: this.authFile,
            clientId: this.clientId,
            refreshTokenUrl: this.refreshTokenUrl,
        });
        if (!this.matchesAccount(refreshed.accountId)) return undefined;
        return this.withAuth(refreshed);
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
