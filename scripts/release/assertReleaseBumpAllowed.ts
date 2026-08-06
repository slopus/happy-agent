export interface ReleaseBumpInput {
    currentVersion: string;
    requested: string;
}

/**
 * Refuses a release that would leave `0.x` before Rig is ready to promise it.
 *
 * A major version is a promise about compatibility, and Rig is early enough to break its own
 * schemas, protocol, and configuration deliberately rather than carry migrations for them. Until
 * that stops being true, `0` is the honest major, and everything else stays available: a minor for
 * features, a patch for fixes.
 *
 * There is no flag to override this. Reaching 1.0.0 is a decision about the product rather than
 * about one release, so it is made by changing this rule.
 */
export function assertReleaseBumpAllowed({ currentVersion, requested }: ReleaseBumpInput): void {
    const currentMajor = Number(currentVersion.split(".")[0]);
    if (!Number.isInteger(currentMajor) || currentMajor > 0) return;

    if (requested === "major" || requested === "premajor") {
        throw new Error(
            `Rig is still on ${currentVersion}, so a '${requested}' release is not available. ` +
                `Use 'minor' for new features and 'patch' for fixes.`,
        );
    }

    const requestedMajor = Number(requested.split(".")[0]);
    if (Number.isInteger(requestedMajor) && requestedMajor > 0) {
        throw new Error(
            `Rig is still on ${currentVersion}, so it does not release ${requested} yet. ` +
                `Use 'minor' for new features and 'patch' for fixes.`,
        );
    }
}
