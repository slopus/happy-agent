import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** One request the fixture received, as it arrived. */
export interface OAuthFixtureRequest {
    readonly method: string;
    readonly path: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
}

interface PendingCode {
    readonly clientId: string;
    readonly challenge: string;
    readonly redirectUri: string;
    readonly resource: string | null;
}

/**
 * An HTTP MCP server on 127.0.0.1 that answers only a bearer token it issued, together with the
 * authorization server that issues them: protected-resource and authorization-server metadata,
 * dynamic client registration, and a token endpoint checking S256 PKCE, the redirect URI, and the
 * resource. `authorize` plays the person's browser: it approves an authorization link and returns
 * the address the browser would land on.
 *
 * With `clientAuth: "client_secret_post"`, the authorization server advertises both secret methods
 * but registers every client as a confidential one that must authenticate with its secret in the
 * form, and refuses HTTP Basic with invalid_client, as servers that chose post do.
 */
export async function startOAuthMcpServer(
    options: {
        readonly label?: string;
        readonly scope?: string;
        readonly clientAuth?: "client_secret_post";
    } = {},
) {
    const label = options.label ?? "oauth";
    const requests: OAuthFixtureRequest[] = [];
    const clients = new Set<string>();
    const secrets = new Map<string, string>();
    const codes = new Map<string, PendingCode>();
    const accessTokens = new Set<string>();
    const refreshTokens = new Set<string>();
    let origin = "";

    const http: HttpServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const url = new URL(request.url ?? "/", origin);
            requests.push({
                method: request.method ?? "GET",
                path: url.pathname,
                headers: request.headers,
                body,
            });
            const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
                response.writeHead(status, { "content-type": "application/json", ...headers });
                response.end(JSON.stringify(value));
            };
            if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
                json(200, {
                    resource: `${origin}/mcp`,
                    authorization_servers: [origin],
                    ...(options.scope === undefined ? {} : { scopes_supported: [options.scope] }),
                });
                return;
            }
            if (url.pathname === "/.well-known/oauth-authorization-server") {
                json(200, {
                    issuer: origin,
                    authorization_endpoint: `${origin}/authorize`,
                    token_endpoint: `${origin}/token`,
                    registration_endpoint: `${origin}/register`,
                    response_types_supported: ["code"],
                    grant_types_supported: ["authorization_code", "refresh_token"],
                    code_challenge_methods_supported: ["S256"],
                    token_endpoint_auth_methods_supported:
                        options.clientAuth === undefined
                            ? ["none"]
                            : ["client_secret_basic", "client_secret_post"],
                });
                return;
            }
            if (url.pathname === "/register" && request.method === "POST") {
                const clientId = `client-${randomUUID()}`;
                clients.add(clientId);
                if (options.clientAuth === undefined) {
                    json(201, { ...(JSON.parse(body) as object), client_id: clientId });
                    return;
                }
                const secret = `secret-${randomUUID()}`;
                secrets.set(clientId, secret);
                json(201, {
                    ...(JSON.parse(body) as object),
                    client_id: clientId,
                    client_secret: secret,
                    token_endpoint_auth_method: options.clientAuth,
                });
                return;
            }
            if (url.pathname === "/token" && request.method === "POST") {
                const form = new URLSearchParams(body);
                if (options.clientAuth !== undefined) {
                    const secret = secrets.get(form.get("client_id") ?? "");
                    if (
                        request.headers.authorization !== undefined ||
                        secret === undefined ||
                        form.get("client_secret") !== secret
                    ) {
                        json(401, { error: "invalid_client" });
                        return;
                    }
                }
                if (form.get("grant_type") === "authorization_code") {
                    const pending = codes.get(form.get("code") ?? "");
                    codes.delete(form.get("code") ?? "");
                    const verifier = form.get("code_verifier") ?? "";
                    const challenge = createHash("sha256").update(verifier).digest("base64url");
                    if (
                        pending === undefined ||
                        pending.clientId !== form.get("client_id") ||
                        pending.challenge !== challenge ||
                        pending.redirectUri !== form.get("redirect_uri") ||
                        pending.resource !== form.get("resource")
                    ) {
                        json(400, { error: "invalid_grant", error_description: "secret detail" });
                        return;
                    }
                    json(200, issue());
                    return;
                }
                if (form.get("grant_type") === "refresh_token") {
                    const refresh = form.get("refresh_token") ?? "";
                    if (!refreshTokens.delete(refresh)) {
                        json(400, { error: "invalid_grant" });
                        return;
                    }
                    json(200, issue());
                    return;
                }
                json(400, { error: "unsupported_grant_type" });
                return;
            }
            if (url.pathname === "/mcp") {
                const token = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
                if (token === undefined || !accessTokens.has(token)) {
                    json(
                        401,
                        { error: "unauthorized" },
                        {
                            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
                        },
                    );
                    return;
                }
                void serveMcp(request, response, body);
                return;
            }
            json(404, { error: "not_found" });
        });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("No fixture port.");
    origin = `http://127.0.0.1:${String(address.port)}`;

    function issue() {
        const access = `access-${randomUUID()}`;
        const refresh = `refresh-${randomUUID()}`;
        accessTokens.add(access);
        refreshTokens.add(refresh);
        return {
            access_token: access,
            token_type: "Bearer",
            expires_in: 3_600,
            refresh_token: refresh,
        };
    }

    async function serveMcp(
        request: IncomingMessage,
        response: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1],
        body: string,
    ): Promise<void> {
        const server = new Server(
            { name: `${label}-server`, version: "1.0.0" },
            { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "echo",
                    description: "Echo text.",
                    inputSchema: { type: "object", properties: { text: { type: "string" } } },
                },
            ],
        }));
        server.setRequestHandler(CallToolRequestSchema, async (call) => ({
            content: [{ type: "text", text: `${label}:${String(call.params.arguments?.text)}` }],
        }));
        // Without a session ID generator the transport is stateless: one request, one exchange.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        response.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(
            request,
            response,
            body.length === 0 ? undefined : JSON.parse(body),
        );
    }

    return {
        url: `${origin}/mcp`,
        origin,
        requests,
        /** Approve an authorization link as the person would, returning where the browser lands. */
        authorize(link: string): string {
            const url = new URL(link);
            const clientId = url.searchParams.get("client_id") ?? "";
            if (!clients.has(clientId)) throw new Error("The link names an unknown client.");
            if (url.searchParams.get("code_challenge_method") !== "S256") {
                throw new Error("The link does not use S256.");
            }
            const code = `code-${randomUUID()}`;
            const redirectUri = url.searchParams.get("redirect_uri") ?? "";
            codes.set(code, {
                clientId,
                challenge: url.searchParams.get("code_challenge") ?? "",
                redirectUri,
                resource: url.searchParams.get("resource"),
            });
            const landing = new URL(redirectUri);
            landing.searchParams.set("code", code);
            landing.searchParams.set("state", url.searchParams.get("state") ?? "");
            return landing.href;
        },
        /** Let every access token lapse while keeping refresh tokens, so the next call refreshes. */
        expireAccessTokens(): void {
            accessTokens.clear();
        },
        /** Forget every token, as a server does when it revokes a login. */
        revokeAll(): void {
            accessTokens.clear();
            refreshTokens.clear();
        },
        /** Requests to anything other than the MCP endpoint itself. */
        authRequests(): readonly OAuthFixtureRequest[] {
            return requests.filter((request) => request.path !== "/mcp");
        },
        mcpRequests(): readonly OAuthFixtureRequest[] {
            return requests.filter((request) => request.path === "/mcp");
        },
        async close(): Promise<void> {
            http.closeAllConnections();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        },
    };
}
