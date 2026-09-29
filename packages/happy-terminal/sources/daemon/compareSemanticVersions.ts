import { isNewerSemanticVersion } from "./isNewerSemanticVersion.js";

/** Sorts versions oldest first by precedence, breaking build-metadata ties by text. */
export function compareSemanticVersions(left: string, right: string): number {
    if (isNewerSemanticVersion(left, right)) return 1;
    if (isNewerSemanticVersion(right, left)) return -1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}
