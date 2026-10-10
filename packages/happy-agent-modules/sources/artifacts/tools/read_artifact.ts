import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import {
    ArtifactNotFoundError,
    artifactCounterSchema,
    artifactRecordSchema,
    artifactVersionSchema,
} from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { ARTIFACT_TYPE_RULES, formatBytes } from "../ArtifactTypes.js";
import { decodeArtifactText } from "../impl/decodeArtifactText.js";
import {
    formatArtifactAuthor,
    formatArtifactFile,
    formatArtifactSource,
    formatFileCount,
} from "../impl/formatArtifact.js";
import { ARTIFACT_TOOL_CAPABILITY } from "./common.js";

/** How much of a Markdown or HTML entry one read hands the model. */
const MAX_ENTRY_TEXT_BYTES = 64 * 1024;

const readArtifactToolInputSchema = Type.Object(
    { artifactId: cuid2Schema, version: Type.Optional(artifactCounterSchema) },
    { additionalProperties: false },
);
type ReadArtifactToolInput = Static<typeof readArtifactToolInputSchema>;

const artifactReadSchema = Type.Object({
    artifact: artifactRecordSchema,
    /** Absent for a deleted artifact, whose versions are no longer served. */
    version: Type.Optional(artifactVersionSchema),
    entryText: Type.Optional(Type.String()),
    entryTextTruncated: Type.Optional(Type.Boolean()),
});
type ArtifactRead = Static<typeof artifactReadSchema>;

/** Read one version of an artifact: who made it, where, every file, and a page's entry text. */
export function readArtifactTool(artifacts: ArtifactsModule) {
    return defineAgentTool({
        name: "read_artifact",
        defer: true,
        capabilities: [ARTIFACT_TOOL_CAPABILITY],
        searchKeywords: ["read artifact", "open artifact", "artifact files", "artifact history"],
        description: `Read one version of an artifact, the latest unless you name one: its title, who made it, where, and when, and every file it holds with its path, media type, and size. For markdown and html the entry's text follows, up to ${formatBytes(MAX_ENTRY_TEXT_BYTES)}. Read any single file, including images, with read_artifact_file.`,
        parameters: readArtifactToolInputSchema,
        returnType: artifactReadSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx: Context, input: ReadArtifactToolInput): Promise<ArtifactRead> => {
            const artifact = await artifacts.get(ctx, input.artifactId);
            if (artifact === undefined) throw new ArtifactNotFoundError();
            if (artifact.status === "deleted") return { artifact };
            const version = await artifacts.getVersion(
                ctx,
                artifact.id,
                input.version ?? artifact.latestVersion,
            );
            if (ARTIFACT_TYPE_RULES[artifact.type].entry === undefined) {
                return { artifact, version };
            }
            const read = await artifacts.readFile(
                ctx,
                artifact.id,
                version.number,
                version.entry.path,
                { maxBytes: MAX_ENTRY_TEXT_BYTES },
            );
            const decoded = decodeArtifactText(version.entry.mimeType, read.bytes, {
                atStart: true,
                atEnd: !read.more,
            });
            return {
                artifact,
                version,
                ...(decoded === undefined
                    ? {}
                    : { entryText: decoded.text, entryTextTruncated: read.more }),
            };
        },
        toLLM: (read) => [{ type: "text", text: formatArtifactRead(read) }],
    });
}

function formatArtifactRead({
    artifact,
    version,
    entryText,
    entryTextTruncated,
}: ArtifactRead): string {
    const lines = [
        `Artifact ${artifact.id}: ${JSON.stringify(artifact.title)}, ${ARTIFACT_TYPE_RULES[artifact.type].label}.`,
        `Created ${new Date(artifact.createdAt).toISOString()} by ${formatArtifactAuthor(artifact.createdBy)}${artifact.source === undefined ? "" : ` in ${formatArtifactSource(artifact.source)}`}.`,
    ];
    if (version === undefined) {
        lines.push(
            `Deleted ${new Date(artifact.deletedAt ?? artifact.updatedAt).toISOString()} by ${formatArtifactAuthor(artifact.deletedBy ?? artifact.updatedBy)}. Its versions and files are no longer available.`,
        );
        return lines.join("\n");
    }
    lines.push(
        `Version ${String(version.number)} of ${String(artifact.latestVersion)}, made ${new Date(version.createdAt).toISOString()} by ${formatArtifactAuthor(version.createdBy)}${version.source === undefined ? "" : ` in ${formatArtifactSource(version.source)}`}: ${JSON.stringify(version.title)}.`,
        `${formatFileCount(version.files.length)}, opening ${JSON.stringify(version.entry.path)}:`,
        ...version.files.map(formatArtifactFile),
    );
    if (entryText !== undefined) {
        lines.push("", `${version.entry.path}:`, entryText);
        if (entryTextTruncated === true) {
            lines.push(
                "",
                `[Only the first ${formatBytes(MAX_ENTRY_TEXT_BYTES)} are shown; read the rest with read_artifact_file.]`,
            );
        }
    }
    return lines.join("\n");
}
