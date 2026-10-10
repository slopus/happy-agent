import type { ArtifactAuthor, ArtifactFile, ArtifactRecord, ArtifactSource } from "../Artifact.js";
import { ARTIFACT_TYPE_RULES, formatBytes } from "../ArtifactTypes.js";

/** One catalog line a model reads: identity, kind, title, latest version, size, and last change. */
export function formatArtifactLine(artifact: ArtifactRecord): string {
    const parts = [
        artifact.id,
        ARTIFACT_TYPE_RULES[artifact.type].label,
        JSON.stringify(artifact.title),
        `version ${String(artifact.latestVersion)}`,
        `${formatFileCount(artifact.fileCount)} (${formatBytes(artifact.size)}) opening ${JSON.stringify(artifact.entry.path)}`,
        `${artifact.status === "deleted" ? "deleted" : "updated"} ${new Date(artifact.updatedAt).toISOString()} by ${formatArtifactAuthor(artifact.updatedBy)}`,
    ];
    if (artifact.source !== undefined)
        parts.push(`made in ${formatArtifactSource(artifact.source)}`);
    return `- ${parts.join(" · ")}`;
}

export function formatArtifactAuthor(author: ArtifactAuthor): string {
    if (author.kind === "user") {
        return author.userId === undefined ? "a person" : `user ${author.userId}`;
    }
    return author.botId === undefined
        ? `agent ${author.agentId}`
        : `agent ${author.agentId} of bot ${author.botId}`;
}

export function formatArtifactSource(source: ArtifactSource): string {
    switch (source.kind) {
        case "bot":
            return `bot ${source.botId}`;
        case "task":
            return `task ${source.taskId}`;
        case "project":
            return `project ${source.projectId}`;
        case "workspace":
            return `workspace ${source.workspaceId} of project ${source.projectId}`;
        case "agent":
            return `conversation ${source.agentId}`;
    }
}

export function formatArtifactFile(file: ArtifactFile): string {
    return `- ${JSON.stringify(file.path)} · ${file.mimeType} · ${formatBytes(file.size)}`;
}

export function formatFileCount(count: number): string {
    return count === 1 ? "1 file" : `${String(count)} files`;
}
