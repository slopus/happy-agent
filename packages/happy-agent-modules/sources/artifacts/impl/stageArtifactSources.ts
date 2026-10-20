import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../../compute/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import {
    ArtifactInputError,
    artifactPathSchema,
    type ArtifactPlacement,
    type ArtifactType,
} from "../Artifact.js";
import type { ArtifactsModule } from "../ArtifactsModule.js";
import { ARTIFACT_TYPE_RULES, artifactTypeNoun, formatBytes } from "../ArtifactTypes.js";

/** One file on the agent's machine a call publishes in an artifact's next version. */
export interface ArtifactToolSource {
    readonly fromPath: string;
    readonly path?: string | undefined;
}

/** Whether reading any of these files crosses the agent's filesystem boundary. */
export async function shouldReviewArtifactSources(
    ctx: Context,
    computeModule: ComputeModule,
    agentId: string,
    sources: readonly ArtifactToolSource[] | undefined,
): Promise<boolean> {
    if (sources === undefined || sources.length === 0) return false;
    const compute = await computeModule.resolve(ctx, agentId);
    if (compute === undefined) return false;
    for (const source of sources) {
        if (await computeModule.shouldReviewPath(ctx, compute, source.fromPath, { write: false })) {
            return true;
        }
    }
    return false;
}

/** What a reviewer is deciding on: which local files are read, quoted so nothing can hide. */
export function describeArtifactSources(
    sources: readonly ArtifactToolSource[] | undefined,
): string {
    return sources === undefined || sources.length === 0
        ? "no files"
        : `${sources.map((source) => quoteVisibleExact(source.fromPath)).join(", ")} from this machine`;
}

/**
 * Read files on the agent's machine under the call's permissions and stage them as uploads, each
 * bounded by what the artifact type accepts before it is read. A path left out is the file's own
 * name. Each upload commits on its own, so this runs outside a transaction.
 */
export async function stageArtifactSources(
    ctx: Context,
    artifacts: ArtifactsModule,
    computeModule: ComputeModule,
    agentId: string,
    type: ArtifactType,
    sources: readonly ArtifactToolSource[],
): Promise<ArtifactPlacement[]> {
    if (sources.length === 0) return [];
    const compute = await computeModule.resolve(ctx, agentId);
    if (compute === undefined) {
        throw new ArtifactInputError("This conversation has no machine to copy files from.");
    }
    const rule = ARTIFACT_TYPE_RULES[type];
    const permissions = computeModule.permissionsForContext(ctx);
    const copies = sources.map((source) => {
        const resolved = computeModule.resolvePath(compute, source.fromPath);
        return { source, resolved, path: source.path ?? computeModule.pathName(resolved) };
    });
    if (new Set(copies.map((copy) => copy.path)).size !== copies.length) {
        throw new ArtifactInputError("Each path can be copied to only once.");
    }
    const placements: ArtifactPlacement[] = [];
    let total = 0;
    for (const { source, resolved, path } of copies) {
        if (!Value.Check(artifactPathSchema, path)) {
            throw new ArtifactInputError(
                `${quoteVisibleExact(path)} cannot be a path in an artifact; name the file's path explicitly.`,
            );
        }
        const facts = await compute.fs.stat(permissions, resolved);
        if (!facts.isFile) {
            throw new ArtifactInputError(`${quoteVisibleExact(source.fromPath)} is not a file.`);
        }
        if (facts.size === 0) {
            throw new ArtifactInputError(`${quoteVisibleExact(source.fromPath)} is empty.`);
        }
        if (facts.size > rule.maxFileBytes) {
            throw new ArtifactInputError(
                `${quoteVisibleExact(source.fromPath)} is larger than the ${formatBytes(rule.maxFileBytes)} ${artifactTypeNoun(rule)} file may be.`,
            );
        }
        total += facts.size;
        if (total > rule.maxTotalBytes) {
            throw new ArtifactInputError(
                `${artifactTypeNoun(rule, true)} artifact may hold at most ${formatBytes(rule.maxTotalBytes)} in all.`,
            );
        }
        const bytes = await compute.fs.readFileBuffer(permissions, resolved, {
            maxBytes: rule.maxFileBytes,
        });
        placements.push({ path, uploadId: (await artifacts.stageUpload(ctx, bytes)).id });
    }
    return placements;
}
