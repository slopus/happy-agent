import type { PackageManifest } from "./PackageManifest.js";
import { readRegistryLatestVersion } from "./readRegistryLatestVersion.js";

export function assertRegistryLatestMatchesManifest(
    manifest: PackageManifest,
    registryLatestJson: string,
    options: { isTaggedUnpublishedVersion?: (version: string) => boolean } = {},
): void {
    const latest = readRegistryLatestVersion(registryLatestJson);
    if (latest !== manifest.version) {
        const unpublishedVersions = unpublishedPatchVersions(latest, manifest.version);
        if (
            unpublishedVersions !== undefined &&
            unpublishedVersions.length > 0 &&
            options.isTaggedUnpublishedVersion !== undefined &&
            unpublishedVersions.every(options.isTaggedUnpublishedVersion)
        ) {
            return;
        }
        throw new Error(
            `${manifest.name} is ${manifest.version} in the worktree but npm latest is ${String(latest)}. Record the published version before releasing again.`,
        );
    }
}

function unpublishedPatchVersions(published: string, current: string): string[] | undefined {
    const publishedParts = parseStableVersion(published);
    const currentParts = parseStableVersion(current);
    if (
        publishedParts === undefined ||
        currentParts === undefined ||
        publishedParts.major !== currentParts.major ||
        publishedParts.minor !== currentParts.minor ||
        publishedParts.patch >= currentParts.patch ||
        currentParts.patch - publishedParts.patch > 100
    ) {
        return undefined;
    }
    return Array.from(
        { length: currentParts.patch - publishedParts.patch },
        (_, index) =>
            `${String(currentParts.major)}.${String(currentParts.minor)}.${String(publishedParts.patch + index + 1)}`,
    );
}

function parseStableVersion(
    version: string,
): { major: number; minor: number; patch: number } | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
    if (match === null) return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}
