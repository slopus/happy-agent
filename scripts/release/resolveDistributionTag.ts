export interface DistributionTagInput {
    requestedTag: string | undefined;
    version: string;
}

/**
 * Which npm distribution tag a publish claims.
 *
 * `latest` is what an ordinary install resolves, so a version that is not ready to be an ordinary
 * install must never claim it. A prerelease version says that about itself in its own name, and a
 * publish that would hand one to every user is refused here rather than discovered afterwards,
 * because npm does not allow taking a published version back.
 */
export function resolveDistributionTag({ requestedTag, version }: DistributionTagInput): string {
    const tag = requestedTag === undefined || requestedTag.length === 0 ? "latest" : requestedTag;
    if (tag === "latest" && version.includes("-")) {
        throw new Error(
            `${version} is a prerelease version and must not be published as 'latest'. ` +
                `Set RELEASE_DIST_TAG to the channel it belongs to, such as 'canary'.`,
        );
    }
    return tag;
}
