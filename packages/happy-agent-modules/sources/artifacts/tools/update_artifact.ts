import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { ComputeModule } from "../../compute/index.js";
import {
    ArtifactConflictError,
    ArtifactNotFoundError,
    artifactPathSchema,
    artifactRecordSchema,
    artifactTitleSchema,
    MAX_ARTIFACT_FILES,
} from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import {
    describeArtifactSources,
    shouldReviewArtifactSources,
    stageArtifactToolFiles,
} from "../impl/stageArtifactToolFiles.js";
import {
    ARTIFACT_FILES_GUIDANCE,
    ARTIFACT_TOOL_CAPABILITY,
    artifactToolFilesSchema,
} from "./common.js";

const updateArtifactToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        title: Type.Optional(artifactTitleSchema),
        files: Type.Optional(artifactToolFilesSchema),
        remove: Type.Optional(Type.Array(artifactPathSchema, { maxItems: MAX_ARTIFACT_FILES })),
        replaceAll: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
type UpdateArtifactToolInput = Static<typeof updateArtifactToolInputSchema>;

/** Make a new version of an artifact, recorded as made by this agent where it works. */
export function updateArtifactTool(
    artifacts: ArtifactsModule,
    compute: ComputeModule,
    agentId: string,
) {
    return defineAgentTool({
        name: "update_artifact",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: [
            "update artifact",
            "new artifact version",
            "revise artifact",
            "add image to artifact",
        ],
        description: [
            "Make a new version of an artifact. Every earlier version is kept, and the change is recorded as made by you, where you are working.",
            'The new version starts from the latest version\'s files. files adds a file at a new path or replaces the one already there — for example { "path": "images/chart.png", "fromPath": "/workspace/out/chart.png" } to place an image you generated, beside a new index.md that shows it — and remove takes paths out. Files you leave alone carry over unchanged. Pass replaceAll: true to start from no files instead. title renames it. The type cannot change, and a deleted artifact cannot change.',
            ARTIFACT_FILES_GUIDANCE,
        ].join("\n\n"),
        parameters: updateArtifactToolInputSchema,
        returnType: artifactRecordSchema,
        durable: true,
        shouldReviewInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        shouldRunInFullAccessInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        describeAutoPermissionAction: ({ artifactId, files }) =>
            `publishing ${describeArtifactSources(files)} in a new version of artifact ${JSON.stringify(artifactId)}. Access: local file read (outside-workspace or symlink targets require full access) and a write to this installation's shared artifact catalog`,
        // The call's own ID keys the version, so a call repeated after an interruption finds the
        // version it already made instead of making another.
        execute: async (ctx, input: UpdateArtifactToolInput, call) => {
            const current = await artifacts.get(ctx, input.artifactId);
            if (current === undefined) throw new ArtifactNotFoundError();
            if (current.status === "deleted") {
                throw new ArtifactConflictError("The artifact was deleted, so it cannot change.");
            }
            const actor = await artifacts.actorFor(ctx, agentId);
            const files =
                input.files === undefined
                    ? undefined
                    : await stageArtifactToolFiles(
                          ctx,
                          artifacts,
                          compute,
                          agentId,
                          current.type,
                          input.files,
                      );
            return await artifacts.update(ctx, {
                artifactId: input.artifactId,
                operationId: call.id,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(files === undefined ? {} : { files }),
                ...(input.remove === undefined ? {} : { remove: input.remove }),
                ...(input.replaceAll === undefined ? {} : { replaceAll: input.replaceAll }),
                author: actor.author,
                source: actor.source,
            });
        },
        toLLM: (artifact) => [
            {
                type: "text",
                text: `Artifact ${artifact.id} is now at version ${String(artifact.latestVersion)}: ${JSON.stringify(artifact.title)}, ${String(artifact.fileCount)} ${artifact.fileCount === 1 ? "file" : "files"}, opening ${JSON.stringify(artifact.entry.path)}.`,
            },
        ],
    });
}
