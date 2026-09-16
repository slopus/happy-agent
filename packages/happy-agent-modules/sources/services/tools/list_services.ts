import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { ServicesModule } from "../ServicesModule.js";
import { serviceToolSnapshot, serviceToolSnapshotSchema } from "./ServiceToolOutput.js";

const serviceListToolResultSchema = Type.Object(
    {
        services: Type.Array(serviceToolSnapshotSchema, { maxItems: 288 }),
        omitted_history: Type.Boolean(),
    },
    { additionalProperties: false },
);

export function listServicesTool(services: ServicesModule, agentId: string) {
    return defineAgentTool({
        name: "list_services",
        defer: true,
        capabilities: ["Start, discover, read, write to, and stop sandboxed workspace services."],
        searchKeywords: ["list services", "find dev server", "inspect service", "running previews"],
        description:
            "Discover services in your exact workspace, including services created by other agents there. By default returns all active or stopping services. include_stopped adds at most the newest 256 stopped services and explicitly reports omitted history. service_id inspects just one service, including a stopped one; it cannot select another workspace. Endpoint reachability is a connection check, not application health. Read output with service_input.",
        parameters: Type.Object(
            {
                include_stopped: Type.Optional(Type.Boolean()),
                service_id: Type.Optional(cuid2Schema),
            },
            { additionalProperties: false },
        ),
        returnType: serviceListToolResultSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, args): Promise<Static<typeof serviceListToolResultSchema>> => {
            if (args.service_id !== undefined) {
                const workspace = await services.workspaceForAgent(ctx, agentId);
                return {
                    services: [
                        serviceToolSnapshot(
                            await services.get(ctx, workspace.workspaceId, args.service_id),
                        ),
                    ],
                    omitted_history: false,
                };
            }
            const result = await services.listForAgent(ctx, agentId, args.include_stopped ?? false);
            return {
                services: result.services.map(serviceToolSnapshot),
                omitted_history: result.omittedHistory,
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: [
                    result.services.length === 0
                        ? "No matching workspace services."
                        : "Workspace services:",
                    ...result.services.map(
                        (service) =>
                            `${service.service_id}: ${JSON.stringify(service.name.slice(0, 32))}${service.name.length > 32 ? "…" : ""}; ${service.status}; endpoint ${service.endpoint_status}; port ${service.port}.`,
                    ),
                    ...(result.services.length === 1
                        ? [
                              JSON.stringify({
                                  ...result.services[0],
                                  cmd: result.services[0]!.cmd.slice(0, 10000),
                              }),
                              ...(result.services[0]!.cmd.length > 10000
                                  ? ["Command display truncated to 10000 characters."]
                                  : []),
                          ]
                        : []),
                    ...(result.omitted_history
                        ? [
                              "Older stopped-service history was omitted (newest 256 retained in this result). Inspect an older service by service_id.",
                          ]
                        : []),
                ].join("\n"),
            },
        ],
    });
}
