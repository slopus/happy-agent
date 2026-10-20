import { createId } from "@paralleldrive/cuid2";
import { agentPermissionMode, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { formatHappyReferenceTag } from "@slopus/happy-agent-client";

import type { ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    ArtifactInputError,
    artifactTitleSchema,
    artifactTypeSchema,
    type ArtifactType,
} from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { ARTIFACT_TYPE_RULES } from "../ArtifactTypes.js";
import {
    formatArtifactBackground,
    formatArtifactSource,
    formatArtifactVersion,
} from "../impl/formatArtifact.js";
import {
    describeArtifactSources,
    shouldReviewArtifactSources,
    stageArtifactSources,
} from "../impl/stageArtifactSources.js";
import {
    ARTIFACT_FILES_GUIDANCE,
    ARTIFACT_PRESENTED_NOTICE,
    ARTIFACT_TOOL_CAPABILITY,
    artifactToolBackgroundSchema,
    artifactToolDisplaySchema,
    artifactToolResultSchema,
    artifactToolSourcesSchema,
    presentedArtifact,
} from "./common.js";

const createArtifactToolInputSchema = Type.Object(
    {
        type: artifactTypeSchema,
        title: artifactTitleSchema,
        display: Type.Optional(artifactToolDisplaySchema),
        background: Type.Optional(artifactToolBackgroundSchema),
        files: Type.Optional(artifactToolSourcesSchema),
    },
    { additionalProperties: false },
);
type CreateArtifactToolInput = Static<typeof createArtifactToolInputSchema>;

/**
 * Create an artifact and its first version, recorded as made by this agent where it works. The
 * model never chooses the ID.
 */
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
            "inline visualization",
            "image gallery",
            "video",
            "pdf",
        ],
        description: [
            "Create an artifact: a titled, versioned item in this installation's shared catalog, visible to everyone who uses it, whose files you then write with write_artifact_file and edit_artifact_file. It is recorded as made by you, in the bot, task, project, or workspace you are working in. The call gives you its ID.",
            'A markdown or html artifact starts with a short entry holding its title, so create it first and then write its files. An image, image series, video, or document needs its file from the start: pass it in files, such as { "fromPath": "out/chart.png" }; files copies any file on your machine in for the other types too. A copy keeps its own name unless you give it a path, so to publish a document you already wrote, copy it in as the entry: { "fromPath": "notes/plan.md", "path": "index.md" }.',
            ARTIFACT_FILES_GUIDANCE,
            "Change its title, background, or display later with update_artifact.",
        ].join("\n\n"),
        parameters: createArtifactToolInputSchema,
        returnType: artifactToolResultSchema,
        durable: true,
        shouldReviewInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        shouldRunInFullAccessInAutoMode: ({ files }, ctx) =>
            shouldReviewArtifactSources(ctx, compute, agentId, files),
        describeAutoPermissionAction: ({ type, title, files }) =>
            `creating a new ${type} artifact titled ${quoteVisibleExact(title)} from ${describeArtifactSources(files)}. Access: local file read (outside-workspace or symlink targets require full access) and a write to this installation's shared artifact catalog`,
        // The artifact's identity is minted once and remembered in this invocation's own store,
        // so a call repeated after an interruption finds the artifact it already made.
        execute: async (ctx, input: CreateArtifactToolInput, call) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new ArtifactInputError("Read only mode cannot create artifacts.");
            }
            const id = await call.kv.getOrCreate(ctx, "artifactId", () => createId());
            let artifact = await artifacts.get(ctx, id);
            if (artifact === undefined) {
                const files = await stageArtifactSources(
                    ctx,
                    artifacts,
                    compute,
                    agentId,
                    input.type,
                    input.files ?? [],
                );
                const entry = ARTIFACT_TYPE_RULES[input.type].entry;
                if (entry !== undefined && !files.some((file) => file.path === entry.path)) {
                    const text = seededEntry(input.type, input.title);
                    files.push({
                        path: entry.path,
                        uploadId: (await artifacts.stageText(ctx, text)).id,
                    });
                }
                const actor = await artifacts.actorFor(ctx, agentId);
                ({ artifact } = await artifacts.create(ctx, {
                    id,
                    type: input.type,
                    title: input.title,
                    files,
                    ...(input.background === undefined ? {} : { background: input.background }),
                    ...(input.display === undefined ? {} : { display: input.display }),
                    author: actor.author,
                    source: actor.source,
                }));
            }
            return presentedArtifact(artifact, "latest");
        },
        toLLM: (artifact) => [
            {
                type: "text",
                text: [
                    `Artifact created: ${JSON.stringify(artifact.title)} — id ${artifact.id}, ${artifact.type}, ${formatArtifactVersion(artifact)}, ${String(artifact.fileCount)} ${artifact.fileCount === 1 ? "file" : "files"}, opening ${JSON.stringify(artifact.entry.path)}${formatArtifactBackground(artifact.background)}${artifact.display === undefined ? "" : `, shown ${artifact.display}`}.`,
                    ...(artifact.source === undefined
                        ? []
                        : [`Made in ${formatArtifactSource(artifact.source)}.`]),
                    `Write and change its files with write_artifact_file and edit_artifact_file, starting with ${JSON.stringify(artifact.entry.path)}; each call makes its next version.`,
                    ARTIFACT_PRESENTED_NOTICE,
                    `Reference it in chat as ${formatHappyReferenceTag({ kind: "artifact", id: artifact.id })}.`,
                ].join(" "),
            },
        ],
    });
}

/** The first text of a markdown or html artifact's entry, holding its title. */
function seededEntry(type: ArtifactType, title: string): string {
    return type === "html"
        ? `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n</body>\n</html>\n`
        : `# ${title}\n`;
}

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
