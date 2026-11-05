import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import {
    InvalidClientError,
    InvalidGrantError,
    UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpLogin } from "./McpLoginStore.js";
import { mcpOAuthFetch } from "./mcpOAuthFetch.js";

/** A token this close to expiring is refreshed before it is sent. */
const REFRESH_AHEAD_MS = 60_000;

export interface McpLoginClient {
    readonly client_id: string;
    readonly client_secret?: string;
}

/**
 * Presents one saved login's token to its MCP server and refreshes it, one refresh at a time. It
 * never discovers, registers, or starts a login. When the login can no longer be refreshed, its
 * tokens are cleared and the server sees no token, so the connection reports that it needs a login.
 */
export class McpLoginSession {
    readonly #read: () => McpLogin | undefined;
    readonly #save: (login: McpLogin) => Promise<void>;
    readonly #client: (login: McpLogin) => McpLoginClient | undefined;
    readonly #oauthFetch: FetchLike;
    #refreshing: Promise<string | undefined> | undefined;

    /**
     * @param read The login as it is saved now.
     * @param save Keep a refreshed or cleared login.
     * @param client The OAuth client the login was made with, or undefined once it is gone.
     */
    constructor(options: {
        readonly serverUrl: URL;
        readonly read: () => McpLogin | undefined;
        readonly save: (login: McpLogin) => Promise<void>;
        readonly client: (login: McpLogin) => McpLoginClient | undefined;
    }) {
        this.#read = options.read;
        this.#save = options.save;
        this.#client = options.client;
        this.#oauthFetch = mcpOAuthFetch(options.serverUrl);
    }

    /** The fetch an MCP transport sends its requests through. */
    readonly fetch: FetchLike = async (input, init) => {
        const token = this.#read()?.tokens;
        if (token === undefined) return unauthorized();
        let accessToken = token.accessToken;
        if (
            token.expiresAt !== undefined &&
            token.expiresAt - REFRESH_AHEAD_MS <= Date.now() &&
            token.refreshToken !== undefined
        ) {
            const refreshed = await this.#refresh(accessToken);
            if (refreshed === undefined) return unauthorized();
            accessToken = refreshed;
        }
        const response = await fetch(input, withBearer(init, accessToken));
        if (response.status !== 401) return response;
        const refreshed = await this.#refresh(accessToken);
        if (refreshed === undefined) return response;
        await response.body?.cancel();
        return await fetch(input, withBearer(init, refreshed));
    };

    /**
     * A fresh access token in place of `stale`. Requests that find the same stale token share one
     * refresh, and one that finds it already replaced takes the replacement.
     */
    async #refresh(stale: string): Promise<string | undefined> {
        const current = this.#read()?.tokens?.accessToken;
        if (current !== undefined && current !== stale) return current;
        this.#refreshing ??= this.#refreshOnce().finally(() => {
            this.#refreshing = undefined;
        });
        return await this.#refreshing;
    }

    async #refreshOnce(): Promise<string | undefined> {
        const login = this.#read();
        const refreshToken = login?.tokens?.refreshToken;
        if (login === undefined) return undefined;
        const client = this.#client(login);
        if (refreshToken === undefined || client === undefined) {
            await this.#forget(login);
            return undefined;
        }
        try {
            const tokens = await refreshAuthorization(login.authorizationServerUrl, {
                metadata: login.metadata,
                clientInformation: client,
                refreshToken,
                resource: new URL(login.resource),
                fetchFn: this.#oauthFetch,
            });
            await this.#save({
                ...login,
                tokens: {
                    accessToken: tokens.access_token,
                    tokenType: tokens.token_type,
                    ...(tokens.refresh_token === undefined
                        ? {}
                        : { refreshToken: tokens.refresh_token }),
                    ...(tokens.expires_in === undefined
                        ? {}
                        : { expiresAt: Date.now() + tokens.expires_in * 1_000 }),
                    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
                },
            });
            return tokens.access_token;
        } catch (error) {
            // The authorization server no longer honours this login, so a person has to log in again.
            if (
                error instanceof InvalidGrantError ||
                error instanceof InvalidClientError ||
                error instanceof UnauthorizedClientError
            ) {
                await this.#forget(login);
                return undefined;
            }
            throw new Error("The MCP login could not be refreshed.", { cause: error });
        }
    }

    async #forget(login: McpLogin): Promise<void> {
        const { tokens: _tokens, ...rest } = login;
        await this.#save(rest);
    }
}

function withBearer(init: RequestInit | undefined, accessToken: string): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    return { ...init, headers };
}

function unauthorized(): Response {
    return new Response(null, { status: 401 });
}
