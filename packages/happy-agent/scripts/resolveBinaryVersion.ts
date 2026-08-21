const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function resolveBinaryVersion(
    packageVersion: string,
    releaseVersion: string | undefined,
): string {
    const version = releaseVersion ?? packageVersion;
    if (!SEMANTIC_VERSION.test(version)) {
        throw new Error(`Happy Agent binary version is not semantic: ${version}`);
    }
    return version;
}
