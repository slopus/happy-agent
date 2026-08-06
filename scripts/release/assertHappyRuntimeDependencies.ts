import type { PackageManifest } from "./PackageManifest.js";

const HAPPY_RUNTIME_DEPENDENCIES = [
    "@noble/ciphers",
    "@noble/curves",
    "@vscode/ripgrep",
    "qrcode",
    "qrcode-terminal",
    "socket.io-client",
] as const;

export function assertHappyRuntimeDependencies(manifest: PackageManifest): void {
    const missing = HAPPY_RUNTIME_DEPENDENCIES.filter(
        (dependency) =>
            manifest.dependencies?.[dependency] === undefined &&
            manifest.devDependencies?.[dependency] === undefined,
    );
    if (missing.length > 0) {
        throw new Error(
            `The Rig package is missing Happy runtime dependencies: ${missing.join(", ")}.`,
        );
    }
}
