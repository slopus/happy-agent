import { SEMANTIC_VERSION_PATTERN } from "./happyAgentBinaryConfig.js";

interface SemanticVersion {
    readonly core: readonly [bigint, bigint, bigint];
    readonly prerelease: readonly string[] | undefined;
}

/** Compares semantic-version precedence while ignoring build metadata. */
export function isNewerSemanticVersion(candidate: string, current: string): boolean {
    const left = parseSemanticVersion(candidate);
    const right = parseSemanticVersion(current);
    if (left === undefined || right === undefined) return false;

    for (let index = 0; index < left.core.length; index += 1) {
        const leftPart = left.core[index] ?? 0n;
        const rightPart = right.core[index] ?? 0n;
        if (leftPart !== rightPart) return leftPart > rightPart;
    }

    if (left.prerelease === undefined) return right.prerelease !== undefined;
    if (right.prerelease === undefined) return false;
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = left.prerelease[index];
        const rightPart = right.prerelease[index];
        if (leftPart === undefined) return false;
        if (rightPart === undefined) return true;
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/u.test(leftPart);
        const rightNumeric = /^\d+$/u.test(rightPart);
        if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart);
        if (leftNumeric !== rightNumeric) return !leftNumeric;
        return leftPart > rightPart;
    }
    return false;
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
    if (!new RegExp(SEMANTIC_VERSION_PATTERN, "u").test(value)) return undefined;
    const withoutBuild = value.split("+", 1)[0] ?? value;
    const prereleaseStart = withoutBuild.indexOf("-");
    const core = prereleaseStart < 0 ? withoutBuild : withoutBuild.slice(0, prereleaseStart);
    const prerelease = prereleaseStart < 0 ? undefined : withoutBuild.slice(prereleaseStart + 1);
    const parts = core?.split(".");
    if (parts?.length !== 3) return undefined;
    return {
        core: [BigInt(parts[0] ?? "0"), BigInt(parts[1] ?? "0"), BigInt(parts[2] ?? "0")],
        prerelease: prerelease === undefined ? undefined : prerelease.split("."),
    };
}
