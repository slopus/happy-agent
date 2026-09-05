import { defineAgentTool } from "@slopus/happy-agent-base";
import { connectionIdSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { connectionHealthSchema } from "../ConnectionHealth.js";
import type { ConnectionsModule } from "../ConnectionsModule.js";

export function checkConnectionHealthTool(module: ConnectionsModule, agentId: string) {
    return defineAgentTool({
        name: "check_remote_connection_health",
        defer: true,
        description:
            "Check a configured remote Happy Agent's authenticated health endpoint through Tailcat. Reports reachability, authentication, readiness, and protocol version without exposing credentials. Bounded to 30 seconds. Team checks use the connected Cloud user's organization-scoped token. Available only to active admin bots.",
        parameters: Type.Object({ id: connectionIdSchema }, { additionalProperties: false }),
        returnType: connectionHealthSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "contacting a configured remote Happy Agent health endpoint over Tailcat using its configured authentication",
        execute: async (ctx, { id }) => await module.checkHealth(ctx, agentId, id),
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}
