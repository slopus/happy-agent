import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { formatHappyReferenceTag } from "@slopus/happy-agent-client";

import { ArtifactInputError, artifactPathSchema } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import {
    describeArtifactWrite,
    requireWritableArtifact,
    shouldReviewArtifactWrite,
} from "../impl/artifactWriteAccess.js";
import { formatArtifactVersion } from "../impl/formatArtifact.js";
import { replaceArtifactText } from "../impl/replaceArtifactText.js";
import {
    ARTIFACT_TOOL_CAPABILITY,
    artifactFileWriteResultSchema,
    type ArtifactFileWriteResult,
} from "./common.js";

const editArtifactFileToolInputSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        path: Type.String({
            ...artifactPathSchema,
            description: 'The path of the file inside the artifact, such as "index.html"',
        }),
        old_string: Type.String({ description: "The text to replace" }),
        new_string: Type.String({
            description: "The text to replace it with (must be different from old_string)",
        }),
        replace_all: Type.Optional(
            Type.Boolean({
                default: false,
                description: "Replace all occurrences of old_string (default false)",
            }),
        ),
    },
    { additionalProperties: false },
);
type EditArtifactFileToolInput = Static<typeof editArtifactFileToolInputSchema>;

/** Replace exact text in one text file of an artifact, in a new version made by this agent. */
export function editArtifactFileTool(artifacts: ArtifactsModule, agentId: string) {
    return defineAgentTool({
        name: "edit_artifact_file",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: ["edit artifact", "patch artifact", "change artifact page", "fix artifact"],
        description: [
            "Performs exact string replacements in one text file of an artifact, straight in this installation's artifact catalog. The edit applies to the artifact's latest version and makes its next version, keeping every earlier one, and records the change as made by you.",
            "Usage:",
            "- When editing text from read_artifact_file output, preserve the exact indentation as it appears AFTER the line number prefix: a line number, then a tab. Never include any part of the prefix in old_string or new_string.",
            "- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.",
            "- Use replace_all for replacing and renaming strings across the file.",
            "- The edit also fails, changing nothing, when someone else changed the artifact while it ran; read the file again and repeat it.",
        ].join("\n"),
        parameters: editArtifactFileToolInputSchema,
        returnType: artifactFileWriteResultSchema,
        // The version is keyed by the call, so a call repeated after a restart finds it made
        // instead of applying the edit to text it already changed.
        durable: true,
        shouldReviewInAutoMode: ({ artifactId }, ctx) =>
            shouldReviewArtifactWrite(ctx, artifacts, agentId, artifactId),
        describeAutoPermissionAction: ({ artifactId, path }) =>
            describeArtifactWrite(artifactId, `editing ${JSON.stringify(path)}`),
        execute: async (
            ctx,
            input: EditArtifactFileToolInput,
            call,
        ): Promise<ArtifactFileWriteResult> => {
            const operationId = call.id;
            const done = await artifacts.madeByOperation(ctx, input.artifactId, operationId);
            if (done !== undefined) return { ...done, path: input.path, changed: true };
            await requireWritableArtifact(ctx, artifacts, agentId, input.artifactId);
            const read = await artifacts.readText(ctx, input.artifactId, input.path);
            const edited = replaceArtifactText(read.text, input.path, {
                oldText: input.old_string,
                newText: input.new_string,
                replaceAll: input.replace_all === true,
            });
            const { artifact, changed } = await artifacts.commitFileChanges(ctx, {
                agentId,
                artifactId: input.artifactId,
                expectedRevision: read.artifact.revision,
                operationId,
                writes: new Map([[input.path, new TextEncoder().encode(edited.text)]]),
                removes: [],
            });
            if (!changed) throw new ArtifactInputError("The edit left the file as it was.");
            return { ...artifact, path: input.path, changed, replacements: edited.replacements };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Edited ${JSON.stringify(result.path)}${result.replacements === undefined || result.replacements === 1 ? "" : ` in ${String(result.replacements)} places`}: artifact ${result.id} is now at ${formatArtifactVersion(result)}. Reference it in chat as ${formatHappyReferenceTag({ kind: "artifact", id: result.id })}.`,
            },
        ],
    });
}
