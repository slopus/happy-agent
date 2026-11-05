import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

const MAX_URL = 2_048;
const MAX_TOKEN = 16_384;
const urlSchema = Type.String({ minLength: 1, maxLength: MAX_URL });
const shortSchema = Type.String({ minLength: 1, maxLength: 1_024 });

/**
 * One saved login, kept by the MCP module alone. It is never in the secrets catalog, which can be
 * attached to agents and injected into their shells, and it never reaches a model.
 */
export const mcpLoginSchema = Type.Object(
    {
        authorizationServerUrl: urlSchema,
        /** What refreshing needs of the authorization server's metadata. */
        metadata: Type.Object(
            {
                issuer: urlSchema,
                authorization_endpoint: urlSchema,
                token_endpoint: urlSchema,
                response_types_supported: Type.Array(shortSchema, { maxItems: 32 }),
                token_endpoint_auth_methods_supported: Type.Optional(
                    Type.Array(shortSchema, { maxItems: 32 }),
                ),
            },
            { additionalProperties: false },
        ),
        /**
         * A client registered for this login, or the one configured in mcp.toml, whose ID and secret
         * are read from their environment variables whenever they are needed.
         */
        client: Type.Union([
            Type.Object(
                {
                    kind: Type.Literal("registered"),
                    clientId: shortSchema,
                    clientSecret: Type.Optional(
                        Type.String({ minLength: 1, maxLength: MAX_TOKEN }),
                    ),
                    tokenEndpointAuthMethod: Type.Optional(shortSchema),
                },
                { additionalProperties: false },
            ),
            Type.Object({ kind: Type.Literal("configured") }, { additionalProperties: false }),
        ]),
        resource: urlSchema,
        /** Absent once the login stopped working; the server then needs a login again. */
        tokens: Type.Optional(
            Type.Object(
                {
                    accessToken: Type.String({ minLength: 1, maxLength: MAX_TOKEN }),
                    tokenType: shortSchema,
                    refreshToken: Type.Optional(
                        Type.String({ minLength: 1, maxLength: MAX_TOKEN }),
                    ),
                    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
                    scope: Type.Optional(Type.String({ maxLength: MAX_TOKEN })),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type McpLogin = Static<typeof mcpLoginSchema>;

/**
 * Whose login it is: the catalog it belongs to, the server's name there, and the server's URL, so
 * a server whose URL changes needs a new login rather than presenting the old one elsewhere.
 */
export interface McpLoginKey {
    /** `user` for the user-wide catalog, or the folder catalog's own ID. */
    readonly catalog: string;
    readonly name: string;
    readonly url: string;
}

export function mcpLoginKeyId(key: McpLoginKey): string {
    return JSON.stringify([key.catalog, key.name, key.url]);
}

export const mcpLoginMigration = [
    "002-mcp-logins",
    async (_ctx: Context, database: AgentDatabase) => {
        await agentDatabaseRun(
            database,
            sql`CREATE TABLE IF NOT EXISTS mcp_module_logins (
                catalog TEXT NOT NULL,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                login TEXT NOT NULL,
                updated_at BIGINT NOT NULL,
                PRIMARY KEY (catalog, name, url)
            )`,
        );
    },
] as const;

interface McpLoginRow {
    readonly catalog: string;
    readonly name: string;
    readonly url: string;
    readonly login: string;
}

/** Every saved login. A row that no longer fits the schema is skipped, never trusted. */
export async function readMcpLogins(
    ctx: Context,
): Promise<ReadonlyMap<string, { readonly key: McpLoginKey; readonly login: McpLogin }>> {
    const rows = await ctx.inTx(
        async (txCtx) =>
            await agentDatabaseRows<McpLoginRow>(
                txCtx.db,
                sql`SELECT catalog, name, url, login FROM mcp_module_logins`,
            ),
    );
    const logins = new Map<string, { readonly key: McpLoginKey; readonly login: McpLogin }>();
    for (const row of rows) {
        let login: unknown;
        try {
            login = JSON.parse(row.login);
        } catch {
            continue;
        }
        if (!Value.Check(mcpLoginSchema, login)) continue;
        const key = { catalog: row.catalog, name: row.name, url: row.url };
        logins.set(mcpLoginKeyId(key), { key, login });
    }
    return logins;
}

export async function writeMcpLogin(
    ctx: Context,
    key: McpLoginKey,
    login: McpLogin,
): Promise<void> {
    if (!Value.Check(mcpLoginSchema, login)) throw new Error("The MCP login is invalid.");
    const encoded = JSON.stringify(login);
    await ctx.inTx(async (txCtx) => {
        await agentDatabaseRun(
            txCtx.db,
            sql`INSERT INTO mcp_module_logins (catalog, name, url, login, updated_at)
                VALUES (${key.catalog}, ${key.name}, ${key.url}, ${encoded}, ${Date.now()})
                ON CONFLICT (catalog, name, url)
                DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at`,
        );
    });
}
