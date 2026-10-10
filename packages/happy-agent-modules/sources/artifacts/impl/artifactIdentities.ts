import type { ArtifactAuthor, ArtifactSource } from "../Artifact.js";

/** The one ID that names a source's place: its bot, task, project, workspace, or conversation. */
export function artifactSourceId(source: ArtifactSource): string {
    switch (source.kind) {
        case "bot":
            return source.botId;
        case "task":
            return source.taskId;
        case "project":
            return source.projectId;
        case "workspace":
            return source.workspaceId;
        case "agent":
            return source.agentId;
    }
}

/** The one ID that names an author: the agent's, or the person's when they have one. */
export function artifactAuthorId(author: ArtifactAuthor): string | undefined {
    return author.kind === "agent" ? author.agentId : author.userId;
}
