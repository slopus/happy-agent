import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { formatHappyReferenceTag } from "@slopus/happy-agent-client";

import { artifactPathSchema } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import {
    describeArtifactWrite,
    requireWritableArtifact,
    shouldReviewArtifactWrite,
} from "../impl/artifactWriteAccess.js";
import { formatArtifactVersion } from "../impl/formatArtifact.js";
import {
    ARTIFACT_TOOL_CAPABILITY,
    artifactFileWriteResultSchema,
    type ArtifactFileWriteResult,
} from "./common.js";

const writeArtifactFileToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        path: Type.String({
            ...artifactPathSchema,
            description:
                'The path of the file inside the artifact, such as "index.html" or "styles/site.css"',
        }),
        content: Type.String({ description: "The content to write to the file" }),
    },
    { additionalProperties: false },
);
type WriteArtifactFileToolInput = Static<typeof writeArtifactFileToolInputSchema>;

/** Write one whole text file of an artifact, in a new version made by this agent. */
export function writeArtifactFileTool(artifacts: ArtifactsModule, agentId: string) {
    return defineAgentTool({
        name: "write_artifact_file",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: ["write artifact file", "artifact page", "artifact html", "artifact css"],
        description: [
            "Writes a whole text file of an artifact, straight in this installation's artifact catalog, adding the file or replacing the one at that path. The call makes the artifact's next version, keeping every other file and every earlier version, and records the change as made by you.",
            "Usage:",
            "- Prefer edit_artifact_file to change part of a file that exists; write a whole file only when it is new or most of it changes.",
            "- Write a page in this order: its CSS first, then its HTML, then its JavaScript at the very end.",
            "- The content is UTF-8 text. Publish images and other binary files, or files you built with the shell, with the fromPath files of update_artifact.",
            "- Writing a file exactly as it already is makes no version.",
        ].join("\n"),
        parameters: writeArtifactFileToolInputSchema,
        returnType: artifactFileWriteResultSchema,
        // The version is keyed by the call, so a call repeated after a restart finds it made.
        durable: true,
        shouldReviewInAutoMode: ({ artifactId }, ctx) =>
            shouldReviewArtifactWrite(ctx, artifacts, agentId, artifactId),
        describeAutoPermissionAction: ({ artifactId, path }) =>
            describeArtifactWrite(artifactId, `writing ${JSON.stringify(path)}`),
        execute: async (
            ctx,
            input: WriteArtifactFileToolInput,
            call,
        ): Promise<ArtifactFileWriteResult> => {
            const operationId = call.id;
            const done = await artifacts.madeByOperation(ctx, input.artifactId, operationId);
            if (done !== undefined) return { ...done, path: input.path, changed: true };
            await requireWritableArtifact(ctx, artifacts, agentId, input.artifactId);
            const { artifact, changed } = await artifacts.commitFileChanges(ctx, {
                agentId,
                artifactId: input.artifactId,
                operationId,
                writes: new Map([[input.path, new TextEncoder().encode(input.content)]]),
                removes: [],
            });
            return { ...artifact, path: input.path, changed };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: result.changed
                    ? `Wrote ${JSON.stringify(result.path)}: artifact ${result.id} is now at ${formatArtifactVersion(result)}. Reference it in chat as ${formatHappyReferenceTag({ kind: "artifact", id: result.id })}.`
                    : `${JSON.stringify(result.path)} already held exactly this content, so artifact ${result.id} stays at ${formatArtifactVersion(result)}.`,
            },
        ],
    });
}
