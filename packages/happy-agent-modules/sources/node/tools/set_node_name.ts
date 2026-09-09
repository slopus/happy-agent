import { defineAgentTool } from "@slopus/happy-agent-base";
import { nodeConfigSchema, nodeNameSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { NodeModule } from "../NodeModule.js";

export function setNodeNameTool(node: NodeModule, agentId: string) {
    return defineAgentTool({
        name: "set_node_name",
        defer: true,
        capabilities: ["Set this Happy Agent installation's display name and avatar."],
        description:
            "Set this Happy Agent daemon's own display name. This is independent of the P2P name, bot names, and your human's profile. Only active admin bots may use it.",
        parameters: Type.Object({ name: nodeNameSchema }, { additionalProperties: false }),
        returnType: nodeConfigSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ name }) =>
            `renaming this Happy Agent installation to ${JSON.stringify(name)}. Access: installation-wide configuration write`,
        execute: async (ctx, { name }) => await node.setNameForAdmin(ctx, agentId, name),
        toLLM: (result) => [
            {
                type: "text",
                text: `This Happy Agent installation is now named ${JSON.stringify(result.name)}.`,
            },
        ],
    });
}
