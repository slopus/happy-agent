import { agentPermissionMode } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { ArtifactInputError, ArtifactNotFoundError, type ArtifactRecord } from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";

/** Whether an agent created this artifact itself, and so changes it as freely as its own files. */
export function isOwnArtifact(artifact: ArtifactRecord, agentId: string): boolean {
    return artifact.createdBy.kind === "agent" && artifact.createdBy.agentId === agentId;
}

/**
 * Whether Auto reviews an agent writing this artifact: only when someone else made it, since the
 * new version is published to everyone. A missing or deleted artifact fails the call before
 * anything changes, so there is nothing to review.
 */
export async function shouldReviewArtifactWrite(
    ctx: Context,
    artifacts: ArtifactsModule,
    agentId: string,
    artifactId: string,
): Promise<boolean> {
    const artifact = await artifacts.get(ctx, artifactId);
    if (artifact === undefined || artifact.status === "deleted") return false;
    return !isOwnArtifact(artifact, agentId);
}

/** What a reviewer is deciding on when an agent writes an artifact someone else made. */
export function describeArtifactWrite(artifactId: string, change: string): string {
    return `${change} in a new version of artifact ${JSON.stringify(artifactId)}, which this agent did not create, published in this installation's shared artifact catalog for everyone who uses it. Access: the artifact catalog only; nothing on this machine changes`;
}

/**
 * Refuse a write the agent's permission mode does not allow: Read only writes no artifact, and
 * Workspace write writes only the agent's own. Auto has reviewed the write before it runs.
 */
export function assertArtifactWritable(
    ctx: Context,
    artifact: ArtifactRecord,
    agentId: string,
): void {
    const mode = agentPermissionMode(ctx);
    if (mode === "read_only") {
        throw new ArtifactInputError("Read only mode cannot change artifacts.");
    }
    if (mode === "workspace_write" && !isOwnArtifact(artifact, agentId)) {
        throw new ArtifactInputError(
            `Workspace write mode cannot change artifact ${artifact.id}, which you did not create.`,
        );
    }
}

/** An active artifact this agent's permission mode lets it write, as it is now. */
export async function requireWritableArtifact(
    ctx: Context,
    artifacts: ArtifactsModule,
    agentId: string,
    artifactId: string,
): Promise<ArtifactRecord> {
    const artifact = await artifacts.get(ctx, artifactId);
    if (artifact === undefined) throw new ArtifactNotFoundError();
    if (artifact.status === "deleted") {
        throw new ArtifactNotFoundError("The artifact was deleted, so it cannot change.");
    }
    assertArtifactWritable(ctx, artifact, agentId);
    return artifact;
}
