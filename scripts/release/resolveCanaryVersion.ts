export interface CanaryVersionInput {
    baseVersion: string;
    buildNumber: string;
    commit: string;
}

/**
 * The version a canary build publishes under.
 *
 * A canary is newer than the release it was built from and older than the release that will
 * follow, and the version says so: it is a prerelease of the next patch, which sorts above the
 * current release and below every real version after it. Reading one tells you what it is built on
 * without looking up a commit.
 *
 * Being a prerelease is what keeps it out of the way. npm excludes prereleases from ranges that do
 * not ask for them, so no `*`, `^`, or `~` an ordinary install uses can resolve a canary; the
 * `canary` distribution tag is the only way to ask for one, and it never moves `latest`.
 */
export function resolveCanaryVersion({
    baseVersion,
    buildNumber,
    commit,
}: CanaryVersionInput): string {
    const build = buildNumber.trim();
    if (!/^\d+$/.test(build)) {
        throw new Error(`${buildNumber} is not a canary build number.`);
    }
    const shortCommit = commit.trim().toLowerCase().slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(shortCommit)) {
        throw new Error(`${commit} is not a commit the canary version can reference.`);
    }
    const release = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(baseVersion.trim());
    if (release === null) {
        throw new Error(`${baseVersion} is not a version a canary build can follow.`);
    }
    const [, major, minor, patch] = release;
    const next = `${major}.${minor}.${Number(patch) + 1}`;

    return `${next}-canary.${Number(build)}.${shortCommit}`;
}
