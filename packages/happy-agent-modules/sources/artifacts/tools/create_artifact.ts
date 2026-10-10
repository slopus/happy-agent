import { createId } from "@paralleldrive/cuid2";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    artifactRecordSchema,
    artifactTitleSchema,
    artifactTypeSchema,
    MAX_ARTIFACT_FILES,
} from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { formatArtifactSource } from "../impl/formatArtifact.js";
import {
    describeArtifactSources,
    shouldReviewArtifactSources,
    stageArtifactToolFiles,
} from "../impl/stageArtifactToolFiles.js";
import {
    ARTIFACT_FILES_GUIDANCE,
    ARTIFACT_TOOL_CAPABILITY,
    artifactToolFileSchema,
} from "./common.js";

const createArtifactToolInputSchema = Type.Object(
    {
        type: artifactTypeSchema,
        title: artifactTitleSchema,
        files: Type.Array(artifactToolFileSchema, { minItems: 1, maxItems: MAX_ARTIFACT_FILES }),
    },
    { additionalProperties: false },
);
type CreateArtifactToolInput = Static<typeof createArtifactToolInputSchema>;

/** Publish finished work as a new artifact, recorded as made by this agent where it works. */
export function createArtifactTool(
    artifacts: ArtifactsModule,
    compute: ComputeModule,
    agentId: string,
) {
    return defineAgentTool({
        name: "create_artifact",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: [
            "publish artifact",
            "share report",
            "html page",
            "markdown document",
            "image gallery",
            "video",
            "pdf",
        ],
        description: [
            "Publish finished work as an artifact: a titled, versioned item in this installation's shared catalog, visible to everyone who uses it. It is recorded as made by you, in the bot, task, project, or workspace you are working in.",
            ARTIFACT_FILES_GUIDANCE,
            "Change it later with update_artifact, which keeps every earlier version and carries over the files you do not change.",
        ].join("\n\n"),
        parameters: createArtifactToolInputSchema,
        returnType: artifactRecordSchema,
        durable: true,
        shouldReviewInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        shouldRunInFullAccessInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        describeAutoPermissionAction: ({ type, title, files }) =>
            `publishing ${describeArtifactSources(files)} as a new ${type} artifact titled ${quoteVisibleExact(title)}. Access: local file read (outside-workspace or symlink targets require full access) and a write to this installation's shared artifact catalog`,
        // The artifact's identity is minted once and remembered in this invocation's own store,
        // so a call repeated after an interruption returns the artifact it already made.
        execute: async (ctx, input: CreateArtifactToolInput, call) => {
            const id = await call.kv.getOrCreate(ctx, "artifactId", () => createId());
            const existing = await artifacts.get(ctx, id);
            if (existing !== undefined) return existing;
            const actor = await artifacts.actorFor(ctx, agentId);
            const files = await stageArtifactToolFiles(
                ctx,
                artifacts,
                compute,
                agentId,
                input.type,
                input.files,
            );
            const creation = await artifacts.create(ctx, {
                id,
                type: input.type,
                title: input.title,
                files,
                author: actor.author,
                source: actor.source,
            });
            return creation.artifact;
        },
        toLLM: (artifact) => [
            {
                type: "text",
                text: [
                    `Artifact created: ${JSON.stringify(artifact.title)} — id ${artifact.id}, ${artifact.type}, version ${String(artifact.latestVersion)}, ${String(artifact.fileCount)} ${artifact.fileCount === 1 ? "file" : "files"}, opening ${JSON.stringify(artifact.entry.path)}.`,
                    ...(artifact.source === undefined
                        ? []
                        : [`Made in ${formatArtifactSource(artifact.source)}.`]),
                    "Change it with update_artifact.",
                ].join(" "),
            },
        ],
    });
}
