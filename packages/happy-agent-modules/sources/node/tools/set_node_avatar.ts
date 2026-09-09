import { defineAgentTool } from "@slopus/happy-agent-base";
import { nodeConfigSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { NodeModule } from "../NodeModule.js";

export function setNodeAvatarTool(node: NodeModule, agentId: string) {
    return defineAgentTool({
        name: "set_node_avatar",
        defer: true,
        capabilities: ["Set this Happy Agent installation's display name and avatar."],
        description:
            "Set the Happy Agent daemon's avatar from an absolute local PNG, JPEG, or WebP path, up to 8 MiB and 40 million pixels. Pass null to remove it. Only active admin bots may use it. The daemon stores its own image and computes the ThumbHash.",
        parameters: Type.Object(
            {
                path: Type.Union([
                    Type.String({
                        minLength: 1,
                        maxLength: 4096,
                        pattern: "^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\u0000]*$",
                    }),
                    Type.Null(),
                ]),
            },
            { additionalProperties: false },
        ),
        returnType: nodeConfigSchema,
        // Replaying a file read could select a different image after interruption.
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            node.shouldElevateImageRead(ctx, agentId, path),
        describeAutoPermissionAction: ({ path }) =>
            path === null
                ? "removing this Happy Agent installation's avatar. Access: installation-wide configuration write"
                : `setting this Happy Agent installation's avatar from ${JSON.stringify(path)}. Access: local image read (outside-workspace or symlink targets require full access) and installation-wide configuration write`,
        execute: async (ctx, { path }) => await node.setAvatarFromPath(ctx, agentId, path),
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.avatar === null
                        ? "The installation avatar is removed."
                        : "The installation avatar is set.",
            },
        ],
    });
}
