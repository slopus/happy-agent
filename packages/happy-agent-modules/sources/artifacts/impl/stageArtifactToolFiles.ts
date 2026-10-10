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

/** One file a tool call writes into an artifact: its whole text, or a file on the agent's machine. */
export interface ArtifactToolFile {
    readonly path?: string | undefined;
    readonly content?: string | undefined;
    readonly fromPath?: string | undefined;
}

/** The files on the agent's machine a call would read. */
export function artifactToolSourcePaths(files: readonly ArtifactToolFile[] | undefined): string[] {
    return (files ?? []).flatMap((file) => (file.fromPath === undefined ? [] : [file.fromPath]));
}

/** Whether reading any of these files crosses the agent's filesystem boundary. */
export async function shouldReviewArtifactSources(
    ctx: Context,
    computeModule: ComputeModule,
    agentId: string,
    files: readonly ArtifactToolFile[] | undefined,
): Promise<boolean> {
    const paths = artifactToolSourcePaths(files);
    if (paths.length === 0) return false;
    const compute = await computeModule.resolve(ctx, agentId);
    if (compute === undefined) return false;
    for (const path of paths) {
        if (await computeModule.shouldReviewPath(ctx, compute, path, { write: false })) return true;
    }
    return false;
}

/** What a reviewer is deciding on: which local files are read, quoted so nothing can hide. */
export function describeArtifactSources(files: readonly ArtifactToolFile[] | undefined): string {
    const paths = artifactToolSourcePaths(files);
    return paths.length === 0
        ? "inline text"
        : `${paths.map(quoteVisibleExact).join(", ")} from this machine`;
}

/**
 * Stage a tool call's files as uploads and say where each goes. A text is staged as it is; a file
 * on the agent's machine is read through that machine under the call's permissions, one at a
 * time, bounded by what the artifact type accepts. A path left out is the type's entry for a text,
 * and the file's own name for a file. Each upload commits on its own, so this runs outside a
 * transaction.
 */
export async function stageArtifactToolFiles(
    ctx: Context,
    artifacts: ArtifactsModule,
    computeModule: ComputeModule,
    agentId: string,
    type: ArtifactType,
    files: readonly ArtifactToolFile[],
): Promise<ArtifactPlacement[]> {
    const rule = ARTIFACT_TYPE_RULES[type];
    const placements: ArtifactPlacement[] = [];
    let total = 0;
    for (const file of files) {
        if ((file.content === undefined) === (file.fromPath === undefined)) {
            throw new ArtifactInputError(
                "Give each file either its content as text or fromPath, the file to copy, but not both.",
            );
        }
        if (file.content !== undefined) {
            const path = file.path ?? rule.entry?.path;
            if (path === undefined) {
                throw new ArtifactInputError(
                    "Name the path of every text file, such as notes/summary.txt.",
                );
            }
            placements.push({ path, uploadId: (await artifacts.stageText(ctx, file.content)).id });
            continue;
        }
        const compute = await computeModule.resolve(ctx, agentId);
        if (compute === undefined) {
            throw new ArtifactInputError(
                "This conversation has no files to copy from; give each file's content as text.",
            );
        }
        const source = file.fromPath ?? "";
        const resolved = computeModule.resolvePath(compute, source);
        const path = file.path ?? computeModule.pathName(resolved);
        if (!Value.Check(artifactPathSchema, path)) {
            throw new ArtifactInputError(
                `${quoteVisibleExact(path)} cannot be a path in an artifact; name the file's path explicitly.`,
            );
        }
        const permissions = computeModule.permissionsForContext(ctx);
        const facts = await compute.fs.stat(permissions, resolved);
        if (!facts.isFile)
            throw new ArtifactInputError(`${quoteVisibleExact(source)} is not a file.`);
        if (facts.size === 0)
            throw new ArtifactInputError(`${quoteVisibleExact(source)} is empty.`);
        if (facts.size > rule.maxFileBytes) {
            throw new ArtifactInputError(
                `${quoteVisibleExact(source)} is larger than the ${formatBytes(rule.maxFileBytes)} ${artifactTypeNoun(rule)} file may be.`,
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
