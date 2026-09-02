import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TAILCAT_VERSION = "v0.4.0";

interface TailcatAssetTarget {
    readonly key: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
    readonly platform: "darwin" | "linux";
}

const TAILCAT_SHA256: Readonly<Record<TailcatAssetTarget["key"], string>> = {
    "darwin-arm64": "7e9ca0999a0c65eb5f84ca1ac15a767a498280a3fad39f30d6665ab269f5dddc",
    "darwin-x64": "798d79bccc7333559d924dc6fd0c7d54df338e7a23e89b7c615742f3cce3efa6",
    "linux-arm64": "b9b77747305bc388d31fe2189079e649e958ddadfde85a50ff25f4529345ef05",
    "linux-x64": "8e72a7932baf395c79383c668a5856bbc911d5b24f8a329813246c8a73252566",
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
        "tailcat",
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
