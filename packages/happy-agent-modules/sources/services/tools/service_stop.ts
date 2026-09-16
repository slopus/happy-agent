import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { ServicesModule } from "../ServicesModule.js";
import { serviceToolSnapshot, serviceToolSnapshotSchema } from "./ServiceToolOutput.js";

export function serviceStopTool(services: ServicesModule, agentId: string) {
    return defineAgentTool({
        name: "service_stop",
        defer: true,
        capabilities: ["Start, discover, read, write to, and stop sandboxed workspace services."],
        searchKeywords: ["stop service", "kill service", "service cleanup"],
        description:
            "Stop a service in your exact workspace, including one started by another agent there. Revokes browser attachments immediately, stops the entire process tree, and waits for confirmed sandbox cleanup. Graceful shutdown escalates to force after two seconds. Returns stopped:false if already terminal. Failure to confirm cleanup is an error; retain workspace files.",
        parameters: Type.Object({ service_id: cuid2Schema }, { additionalProperties: false }),
        returnType: Type.Object(
            { service: serviceToolSnapshotSchema, stopped: Type.Boolean() },
            { additionalProperties: false },
        ),
        requiresAutoOrFullAccess: true,
        durable: false,
        reloadable: false,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ service_id }) =>
            `revoke all attachments and stop the entire sandboxed process tree of workspace service ${JSON.stringify(service_id)}, including work started by another agent in this same workspace`,
        execute: async (ctx, { service_id }) => {
            const workspace = await services.workspaceForAgent(ctx, agentId);
            const result = await services.stopAndWait(ctx, workspace.workspaceId, service_id);
            return { service: serviceToolSnapshot(result.service), stopped: result.stopped };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Service ${result.service.service_id} ${result.stopped ? "stopped; process-tree and sandbox cleanup are confirmed" : "was already stopped"}.`,
            },
        ],
    });
}
