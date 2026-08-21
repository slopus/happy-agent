import type { PackageManifest } from "./PackageManifest.js";

const DAEMON_IMPLEMENTATION_PACKAGES = [
    "@slopus/happy-agent",
    "@slopus/happy-agent-base",
    "@slopus/happy-agent-compute",
    "@slopus/happy-agent-modules",
] as const;

/**
 * Keeps Rig on the public client contract. The daemon implementation is downloaded as a release
 * binary and local development resolves its source checkout without package dependencies.
 */
export function assertBundledHappyRuntimeDependencies(manifest: PackageManifest): void {
    const implementationDependencies = DAEMON_IMPLEMENTATION_PACKAGES.filter(
        (dependency) =>
            manifest.dependencies?.[dependency] !== undefined ||
            manifest.devDependencies?.[dependency] !== undefined,
    );
    if (implementationDependencies.length > 0) {
        throw new Error(
            `Rig must not depend on Happy Agent implementation packages: ${implementationDependencies.join(", ")}.`,
        );
    }
    if (manifest.dependencies?.["@slopus/happy-agent-client"] === undefined) {
        throw new Error("Rig must depend on @slopus/happy-agent-client.");
    }
}
