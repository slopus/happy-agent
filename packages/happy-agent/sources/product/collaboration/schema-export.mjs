// Build-time original TypeBox capture. Native execution never loads JavaScript.
import { createRequire } from "node:module";
import * as original from "../../../../happy-agent-modules/sources/collaboration/CollaborationAgent.ts";
import { createAgentTool } from "../../../../happy-agent-modules/sources/collaboration/tools/create_agent.ts";
import { sendMessageTool } from "../../../../happy-agent-modules/sources/collaboration/tools/send_message.ts";
import {
    interruptAgentTool,
    interruptAgentInputSchema,
} from "../../../../happy-agent-modules/sources/collaboration/tools/interrupt_agent.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";
const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
const privates = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/collaboration/CollaborationModule.ts",
        import.meta.url,
    ),
    ["archivedAgentMetadataSchema"],
);
export const collaborationTools = [
    createAgentTool(undefined, "source-agent", "", [], 3, 3),
    sendMessageTool(undefined, "source-agent", true),
    interruptAgentTool(undefined, "source-agent"),
];
export const collaborationSchemas = {
    ownerCollaborationId: original.collaborationAgentIdSchema,
    ownerCollaborationCreateInput: original.collaborationCreateInputSchema,
    ownerCollaborationOptions: original.collaborationCreateOptionsSchema,
    ownerCollaborationSelection: original.collaborationAgentSelectionSchema,
    ownerCollaborationSendInput: original.collaborationSendInputSchema,
    ownerCollaborationResult: original.collaborationCreateResultSchema,
    ownerCollaborationArchivedMetadata: privates.archivedAgentMetadataSchema,
    // Exact structural predicates used by the original runtime for these two markers.
    ownerCollaborationNoReport: Type.Object({
        collaboration: Type.Object({ reportToCreator: Type.Literal(false) }),
    }),
    ownerCollaborationWorkflowMetadata: Type.Object({ workflow: Type.Object({}) }),
    ownerCollaborationInterrupt: interruptAgentInputSchema,
};
for (const tool of collaborationTools) {
    collaborationSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
