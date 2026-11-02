import { defineAgentTool } from "@slopus/happy-agent-base";
import { connectionIdSchema, connectionListResponseSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { ConnectionsModule } from "../ConnectionsModule.js";

export function listConnectionsTool(module: ConnectionsModule, agentId: string) {
    return defineAgentTool({
        name: "list_remote_connections",
        defer: true,
        capabilities: ["Configure and inspect remote Happy Agent connections."],
        searchKeywords: ["remote agent roster", "list connections", "Tailcat nodes"],
        description:
            "List configured remote Happy Agent installations without exposing credentials or contacting them. Only active admin bots may use this tool.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: connectionListResponseSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({ connections: await module.listForAdmin(ctx, agentId) }),
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}

export function setConnectionTool(module: ConnectionsModule, agentId: string) {
    return defineAgentTool({
        name: "set_remote_connection",
        defer: true,
        capabilities: ["Configure and inspect remote Happy Agent connections."],
        searchKeywords: ["add remote agent", "configure connection", "Tailcat bearer WorkOS"],
        description:
            "Register or replace a remote Happy Agent after deploying it. Supply its case-sensitive Tailcat address and API port, plus its fixed standalone bearer token or WorkOS organization ID. This enables authenticated clients of this installation to access the remote's entire API. Saves machine runtime configuration; never deploys or deletes a remote. Only active admin bots may use this tool.",
        parameters: Type.Object(
            { id: connectionIdSchema, connection: module.entrySchema },
            { additionalProperties: false },
        ),
        returnType: connectionListResponseSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        autoPermissionInstructions:
            "Registers remote API authority for this installation's authenticated clients and writes private machine configuration. Credentials must not be repeated in output.",
        describeAutoPermissionAction: () =>
            "configuring a Tailcat remote and granting this installation's clients access to its authenticated API",
        execute: async (ctx, args) => ({
            connections: await module.set(ctx, agentId, args.id, args.connection),
        }),
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}

export function removeConnectionTool(module: ConnectionsModule, agentId: string) {
    return defineAgentTool({
        name: "remove_remote_connection",
        defer: true,
        capabilities: ["Configure and inspect remote Happy Agent connections."],
        searchKeywords: ["remove remote agent", "disconnect endpoint", "remote roster"],
        description:
            "Remove a remote Happy Agent from the local connection roster and close its active proxy requests. Does not delete the remote or its data. Only active admin bots may use this tool.",
        parameters: Type.Object({ id: connectionIdSchema }, { additionalProperties: false }),
        returnType: connectionListResponseSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "removing a configured remote connection and closing its active streams",
        execute: async (ctx, args) => ({
            connections: await module.set(ctx, agentId, args.id, { enabled: false }),
        }),
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}

export function addServerConnectionTool(module: ConnectionsModule, agentId: string) {
    return defineAgentTool({
        name: "add_server_connection",
        defer: true,
        capabilities: ["Configure and inspect remote Happy Agent connections."],
        searchKeywords: ["add team server", "server URL", "SSO server", "connect to a team"],
        description:
            "Add a team Happy server by its HTTPS address, for example when the person asks to connect to their organization's server. Checks that the address is a Happy server offering single sign-on, then adds it to the connection roster. Holds no credential: each person's app signs in to the server itself. Agents cannot use it through this daemon. Remove it with remove_remote_connection. Personal Happy Agent only. Only active admin bots may use this tool.",
        parameters: Type.Object(
            {
                url: Type.String({
                    minLength: 1,
                    maxLength: 2048,
                    description: "The server's https:// address, as the person gave it.",
                }),
                name: Type.Optional(
                    Type.String({
                        minLength: 1,
                        maxLength: 256,
                        description: "A display name; defaults to the address's host.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: connectionListResponseSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        autoPermissionInstructions:
            "Contacts the address the person gave to check it is a Happy server, and writes private machine configuration. It stores no credential.",
        describeAutoPermissionAction: () =>
            "checking a team server's address and adding it to this installation's connections",
        execute: async (ctx, args) => ({
            connections: await module.addServer(ctx, agentId, args.url, args.name),
        }),
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}
