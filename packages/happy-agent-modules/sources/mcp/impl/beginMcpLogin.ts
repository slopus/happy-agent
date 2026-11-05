import { randomBytes } from "node:crypto";

import {
    discoverOAuthServerInfo,
    exchangeAuthorization,
    registerClient,
    startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import type { McpLogin } from "./McpLoginStore.js";
import type { McpLoginClient } from "./McpLoginSession.js";
import { assertMcpOAuthScheme, mcpOAuthFetch, McpOAuthRefusal } from "./mcpOAuthFetch.js";
import { parseMcpLoginRedirect } from "./parseMcpLoginRedirect.js";

const MAX_URL = 2_048;

/** A login step that did not work, in words the person and the model can both read. */
export class McpLoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpLoginError";
    }
}

/** A login waiting for the person: the link to open, and how to finish it with what they paste. */
export interface McpPendingLogin {
    readonly authorizationUrl: URL;
    /** Exchange the pasted address for tokens; the code is single use, like the state. */
    complete(pasted: string): Promise<McpLogin>;
}

/**
 * Prepare a login for one HTTP MCP server: find its authorization server through its protected
 * resource metadata, register a client unless one is configured, and build an S256 PKCE
 * authorization link with a random single-use state and the server's URL as the resource. Every
 * request goes through the guarded OAuth fetch, never carrying the server's own headers.
 *
 * @param configuredClient The client configured in mcp.toml, read from its environment variables,
 * or undefined to register one.
 */
export async function beginMcpLogin(options: {
    readonly serverUrl: URL;
    readonly redirectUri: string;
    readonly state?: string;
    readonly scope: string | undefined;
    readonly resourceMetadataUrl: string | undefined;
    readonly configuredClient: McpLoginClient | undefined;
}): Promise<McpPendingLogin> {
    const fetchFn = mcpOAuthFetch(options.serverUrl);
    const resource = new URL(options.serverUrl.href);
    resource.hash = "";
    const info = await step(
        "find the server's authorization server",
        async () =>
            await discoverOAuthServerInfo(options.serverUrl, {
                fetchFn,
                ...(options.resourceMetadataUrl === undefined
                    ? {}
                    : { resourceMetadataUrl: new URL(options.resourceMetadataUrl) }),
            }),
    );
    const metadata = info.authorizationServerMetadata;
    if (metadata === undefined) {
        throw new McpLoginError(
            "The server does not say how to log in to it: it publishes no OAuth metadata.",
        );
    }
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
        if (endpoint.length > MAX_URL)
            throw new McpLoginError("The authorization server's address is too long.");
        try {
            assertMcpOAuthScheme(new URL(endpoint), options.serverUrl);
        } catch (error) {
            throw new McpLoginError(error instanceof Error ? error.message : String(error));
        }
    }
    const scope = options.scope ?? info.resourceMetadata?.scopes_supported?.join(" ") ?? undefined;
    let client: McpLoginClient;
    let registered = false;
    if (options.configuredClient !== undefined) {
        client = options.configuredClient;
    } else {
        const full = await step(
            "register Happy with the authorization server",
            async () =>
                await registerClient(info.authorizationServerUrl, {
                    metadata,
                    clientMetadata: {
                        client_name: "Happy",
                        redirect_uris: [options.redirectUri],
                        grant_types: ["authorization_code", "refresh_token"],
                        response_types: ["code"],
                        token_endpoint_auth_method: "none",
                    },
                    ...(scope === undefined ? {} : { scope }),
                    fetchFn,
                }),
        );
        client = {
            client_id: full.client_id,
            ...(full.client_secret === undefined ? {} : { client_secret: full.client_secret }),
            ...(full.token_endpoint_auth_method === undefined
                ? {}
                : { token_endpoint_auth_method: full.token_endpoint_auth_method }),
        };
        registered = true;
    }
    const state = options.state ?? randomBytes(32).toString("base64url");
    const { authorizationUrl, codeVerifier } = await step(
        "prepare the sign-in link",
        async () =>
            await startAuthorization(info.authorizationServerUrl, {
                metadata,
                clientInformation: client,
                redirectUrl: options.redirectUri,
                state,
                resource,
                ...(scope === undefined ? {} : { scope }),
            }),
    );
    let used = false;
    return {
        authorizationUrl,
        complete: async (pasted) => {
            const parsed = parseMcpLoginRedirect(pasted, {
                redirectUri: options.redirectUri,
                state,
                issuer: metadata.issuer,
            });
            if (!parsed.ok) throw new McpLoginError(parsed.reason);
            if (used)
                throw new McpLoginError("This sign-in was already used. Ask to log in again.");
            used = true;
            const tokens = await step(
                "finish the sign-in",
                async () =>
                    await exchangeAuthorization(info.authorizationServerUrl, {
                        metadata,
                        clientInformation: client,
                        authorizationCode: parsed.code,
                        codeVerifier,
                        redirectUri: options.redirectUri,
                        resource,
                        fetchFn,
                    }),
            );
            return {
                authorizationServerUrl: String(info.authorizationServerUrl),
                metadata: {
                    issuer: metadata.issuer,
                    authorization_endpoint: metadata.authorization_endpoint,
                    token_endpoint: metadata.token_endpoint,
                    response_types_supported: [...metadata.response_types_supported],
                    ...(metadata.token_endpoint_auth_methods_supported === undefined
                        ? {}
                        : {
                              token_endpoint_auth_methods_supported: [
                                  ...metadata.token_endpoint_auth_methods_supported,
                              ],
                          }),
                },
                client: registered
                    ? {
                          kind: "registered",
                          clientId: client.client_id,
                          ...(client.client_secret === undefined
                              ? {}
                              : { clientSecret: client.client_secret }),
                          ...(client.token_endpoint_auth_method === undefined
                              ? {}
                              : { tokenEndpointAuthMethod: client.token_endpoint_auth_method }),
                      }
                    : { kind: "configured" },
                resource: resource.href,
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
            };
        },
    };
}

/**
 * Run one step, keeping only messages this module wrote. What an authorization server says in an
 * error is never passed on, since it may echo codes or credentials.
 */
async function step<Result>(what: string, work: () => Promise<Result>): Promise<Result> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof McpOAuthRefusal || error instanceof McpLoginError) {
            throw new McpLoginError(error.message);
        }
        if (error instanceof InvalidGrantError) {
            throw new McpLoginError(
                "The sign-in code was refused or had expired. Ask to log in again.",
            );
        }
        throw new McpLoginError(`Happy could not ${what}.`);
    }
}
