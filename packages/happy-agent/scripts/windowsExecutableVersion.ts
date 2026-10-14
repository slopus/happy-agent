const COMPONENT_LIMIT = 65535;
const SEMANTIC_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Turns a semantic version into the four-part numeric version Windows executables carry. */
export function windowsExecutableVersion(version: string): string {
    const match = SEMANTIC_VERSION.exec(version);
    const parts = match === null ? [] : match.slice(1, 4).map(Number);
    if (parts.length !== 3 || parts.some((part) => part > COMPONENT_LIMIT)) {
        throw new Error(`Cannot express ${version} as a Windows executable version.`);
    }
    return `${parts.join(".")}.0`;
}
