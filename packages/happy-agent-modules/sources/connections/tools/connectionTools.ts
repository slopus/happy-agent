import { defineAgentTool } from "@slopus/happy-agent-base";
import { connectionIdSchema, connectionListResponseSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { ConnectionsModule } from "../ConnectionsModule.js";

export function listConnectionsTool(module: ConnectionsModule, agentId: string) {
    return defineAgentTool({
        name: "list_remote_connections",
        defer: true,
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
