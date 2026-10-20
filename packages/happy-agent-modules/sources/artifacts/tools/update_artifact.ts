import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { formatHappyReferenceTag } from "@slopus/happy-agent-client";

import type { ComputeModule } from "../../compute/index.js";
import { artifactPathSchema, artifactTitleSchema, MAX_ARTIFACT_FILES } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import {
    describeArtifactWrite,
    requireWritableArtifact,
    shouldReviewArtifactWrite,
} from "../impl/artifactWriteAccess.js";
import { formatArtifactBackground, formatArtifactVersion } from "../impl/formatArtifact.js";
import {
    describeArtifactSources,
    shouldReviewArtifactSources,
    stageArtifactSources,
} from "../impl/stageArtifactSources.js";
import {
    ARTIFACT_PRESENTED_NOTICE,
    ARTIFACT_TOOL_CAPABILITY,
    artifactToolBackgroundChangeSchema,
    artifactToolDisplayChangeSchema,
    artifactToolResultSchema,
    artifactToolSourcesSchema,
    presentedArtifact,
} from "./common.js";

const updateArtifactToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        title: Type.Optional(artifactTitleSchema),
        background: Type.Optional(artifactToolBackgroundChangeSchema),
        display: Type.Optional(artifactToolDisplayChangeSchema),
        files: Type.Optional(artifactToolSourcesSchema),
        remove: Type.Optional(
            Type.Array(artifactPathSchema, {
                maxItems: MAX_ARTIFACT_FILES,
                description: "Paths of files to take out of the artifact",
            }),
        ),
        major: Type.Optional(
            Type.Integer({
                minimum: 2,
                maximum: Number.MAX_SAFE_INTEGER,
                description:
                    "Make this version the next major version: exactly one more than the latest version's major, allowed once something changed since the last major version",
            }),
        ),
    },
    { additionalProperties: false },
);
type UpdateArtifactToolInput = Static<typeof updateArtifactToolInputSchema>;

/**
 * Change an artifact's title, background, and display, copy files in from the agent's machine,
 * remove files, or mark a major version, in one new version recorded as made by this agent where
 * it works.
 */
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
            "rename artifact",
            "artifact title",
            "artifact display",
            "artifact background",
            "major version",
            "add image to artifact",
            "remove artifact file",
        ],
        description: [
            "Change an artifact in one new version that keeps every earlier one, recorded as made by you, where you are working. title renames it, background changes the colour behind it, which almost every artifact leaves unset, and display changes where an html artifact is shown.",
            'files copies files from your machine in, adding each path or replacing the file there — for example { "fromPath": "out/chart.png", "path": "images/chart.png" } to place an image you generated, or the files of an app you built and tried with the shell. A copy keeps its own name unless you give it a path. remove takes paths out. Write and edit text files with write_artifact_file and edit_artifact_file instead.',
            "Every change makes a minor version, such as 1.3 after 1.2. When the artifact reaches a meaningful milestone, mark it with major, exactly one more than the latest major version: 2 makes this version 2.0, alone or together with the other changes. A major version needs at least one change since the last one.",
        ].join("\n\n"),
        parameters: updateArtifactToolInputSchema,
        returnType: artifactToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: async ({ artifactId, files }, ctx) =>
            (await shouldReviewArtifactWrite(ctx, artifacts, agentId, artifactId)) ||
            (await shouldReviewArtifactSources(ctx, compute, agentId, files)),
        // Only reading files outside the workspace needs the machine; the catalog never does.
        shouldRunInFullAccessInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        describeAutoPermissionAction: ({ artifactId, files }) =>
            files === undefined || files.length === 0
                ? describeArtifactWrite(artifactId, "changing it")
                : `publishing ${describeArtifactSources(files)} in a new version of artifact ${JSON.stringify(artifactId)}, which may be one this agent did not create, in this installation's shared artifact catalog for everyone who uses it. Access: local file read (outside-workspace or symlink targets require full access) and a write to the artifact catalog`,
        // The call's own ID keys the version, so a call repeated after an interruption finds the
        // version it already made instead of making another.
        execute: async (ctx, input: UpdateArtifactToolInput, call) => {
            const done = await artifacts.madeByOperation(ctx, input.artifactId, call.id);
            if (done !== undefined) return presentedArtifact(done, "version");
            const current = await requireWritableArtifact(
                ctx,
                artifacts,
                agentId,
                input.artifactId,
            );
            if (input.files !== undefined || input.remove !== undefined) {
                await artifacts.assertAgentVersionBudget(ctx, agentId, current.id);
            }
            const files =
                input.files === undefined
                    ? undefined
                    : await stageArtifactSources(
                          ctx,
                          artifacts,
                          compute,
                          agentId,
                          current.type,
                          input.files,
                      );
            const actor = await artifacts.actorFor(ctx, agentId);
            const updated = await artifacts.update(ctx, {
                artifactId: input.artifactId,
                operationId: call.id,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.background === undefined ? {} : { background: input.background }),
                ...(input.display === undefined ? {} : { display: input.display }),
                ...(files === undefined ? {} : { files }),
                ...(input.remove === undefined ? {} : { remove: input.remove }),
                ...(input.major === undefined ? {} : { major: input.major }),
                author: actor.author,
                source: actor.source,
            });
            return presentedArtifact(updated, "version");
        },
        toLLM: (artifact) => [
            {
                type: "text",
                text: [
                    `Artifact ${artifact.id} is now at ${formatArtifactVersion(artifact)}: ${JSON.stringify(artifact.title)}, ${String(artifact.fileCount)} ${artifact.fileCount === 1 ? "file" : "files"}, opening ${JSON.stringify(artifact.entry.path)}${formatArtifactBackground(artifact.background)}${artifact.display === undefined ? "" : `, shown ${artifact.display}`}.`,
                    ARTIFACT_PRESENTED_NOTICE,
                    `Reference it in chat as ${formatHappyReferenceTag({ kind: "artifact", id: artifact.id })}, or as ${formatHappyReferenceTag({ kind: "artifact", id: artifact.id, version: artifact.latestVersion })} for this version only.`,
                ].join(" "),
            },
        ],
    });
}
