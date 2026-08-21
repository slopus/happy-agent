const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function replacePackageVersion(contents: string, version: string): string {
    if (!SEMANTIC_VERSION.test(version)) {
        throw new Error(`Release version ${version || "<empty>"} is not semantic.`);
    }

    const versionEntry = /"version":\s*"([^"]+)"/u;
    const current = versionEntry.exec(contents)?.[1];
    if (current === undefined) {
        throw new Error("Could not replace the package version.");
    }
    if (current === version) return contents;

    return contents.replace(versionEntry, () => `"version": "${version}"`);
}
