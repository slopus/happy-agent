import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TAILCAT_VERSION = "v0.7.0-happy.3";

interface TailcatAssetTarget {
    readonly key: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-x64";
    readonly platform: "darwin" | "linux" | "win32";
}

const TAILCAT_SHA256: Readonly<Record<TailcatAssetTarget["key"], string>> = {
    "win32-x64": "e7f100e350374fef4d1c4640c86a1b1f3b05303a6fcaffa836870d02344d9bd1",
    "darwin-arm64": "0bb26b2ef2d582101844b869650436e74a575171032c9cc33e3c80629fe010a1",
    "darwin-x64": "915a77cadd0fab7c1241665fd08dc6fa468786ce92c16e417b247e8eeaa723d5",
    "linux-arm64": "d0fe3a8ff263206a482ab94cad630e36e9cda13b3b62c9a6e28a1939ed37c74c",
    "linux-x64": "7bfc1dd14e72a614f8c54f586090920798f7f6895c9931a1c04fc7226b0d6432",
};

/** Resolve and verify the checked-in Tailcat release asset for one Happy Agent binary target. */
export function resolveTailcatBinaryAsset(
    happyAgentRoot: string,
    target: TailcatAssetTarget,
): string {
    const source = resolve(
        happyAgentRoot,
        "assets",
        "tailcat",
        TAILCAT_VERSION,
        target.key,
        target.platform === "win32" ? "tailcat.exe" : "tailcat",
    );
    assertExecutable(source, `Tailcat ${TAILCAT_VERSION} asset for ${target.key}`);
    const actual = createHash("sha256").update(readFileSync(source)).digest("hex");
    if (actual !== TAILCAT_SHA256[target.key]) {
        throw new Error(
            `Tailcat ${TAILCAT_VERSION} asset for ${target.key} has SHA-256 ${actual}; expected ${TAILCAT_SHA256[target.key]}.`,
        );
    }

    const signedOverride = process.env.HAPPY_AGENT_SIGNED_TAILCAT_PATH?.trim();
    if (signedOverride === undefined || signedOverride.length === 0) {
        verifyVersionWhenNative(source, target);
        return source;
    }
    if (target.platform !== "darwin" || process.platform !== "darwin") {
        throw new Error("A signed Tailcat override is valid only for a native macOS build.");
    }
    const hostKey = `darwin-${process.arch}`;
    if (hostKey !== target.key) {
        throw new Error(`A ${hostKey} runner cannot supply signed Tailcat for ${target.key}.`);
    }
    const signed = resolve(signedOverride);
    assertExecutable(signed, `Signed Tailcat ${TAILCAT_VERSION} asset`);
    const verification = spawnSync(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--verbose=2", signed],
        { encoding: "utf8" },
    );
    if (verification.status !== 0) {
        throw new Error(
            `Signed Tailcat verification failed.${formatProcessError(verification.stderr)}`,
        );
    }
    verifyVersionWhenNative(signed, target);
    return signed;
}

function assertExecutable(path: string, label: string): void {
    try {
        accessSync(path, constants.R_OK | constants.X_OK);
    } catch {
        throw new Error(`${label} is missing or is not executable: ${path}`);
    }
}

function verifyVersionWhenNative(path: string, target: TailcatAssetTarget): void {
    if (`${process.platform}-${process.arch}` !== target.key) return;
    const version = spawnSync(path, ["version"], { encoding: "utf8" });
    if (version.status !== 0) {
        throw new Error(
            `Tailcat version verification failed.${formatProcessError(version.stderr)}`,
        );
    }
    if (version.stdout.trim() !== TAILCAT_VERSION) {
        throw new Error(
            `Tailcat reported ${JSON.stringify(version.stdout.trim())}; expected ${TAILCAT_VERSION}.`,
        );
    }
}

function formatProcessError(stderr: string | Buffer | null | undefined): string {
    const detail = stderr?.toString().trim().slice(-8_192) ?? "";
    return detail === "" ? "" : ` ${detail}`;
}
