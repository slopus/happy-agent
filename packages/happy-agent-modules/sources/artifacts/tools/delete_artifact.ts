import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { artifactRecordSchema } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { ARTIFACT_TOOL_CAPABILITY } from "./common.js";

const deleteArtifactToolInputSchema = Type.Object(
    { artifactId: cuid2Schema },
    { additionalProperties: false },
);
type DeleteArtifactToolInput = Static<typeof deleteArtifactToolInputSchema>;

/** Delete an artifact for everyone, recorded as done by this agent where it works. */
export function deleteArtifactTool(artifacts: ArtifactsModule, agentId: string) {
    return defineAgentTool({
        name: "delete_artifact",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: ["delete artifact", "remove artifact", "unpublish"],
        description:
            "Delete an artifact for everyone using this installation. Its title and history of who made and changed it stay listed as deleted, but none of its versions or files can be opened again, and it cannot be restored. Deleting an artifact that is already deleted changes nothing.",
        parameters: deleteArtifactToolInputSchema,
        returnType: artifactRecordSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ artifactId }) =>
            `deleting artifact ${JSON.stringify(artifactId)} for everyone using this installation; its versions and files can no longer be opened and it cannot be restored`,
        execute: async (ctx, input: DeleteArtifactToolInput) => {
            const actor = await artifacts.actorFor(ctx, agentId);
            return await artifacts.delete(ctx, {
                artifactId: input.artifactId,
                author: actor.author,
                source: actor.source,
            });
        },
        toLLM: (artifact) => [
            {
                type: "text",
                text: `Deleted artifact ${JSON.stringify(artifact.title)} (${artifact.id}).`,
            },
        ],
    });
}
