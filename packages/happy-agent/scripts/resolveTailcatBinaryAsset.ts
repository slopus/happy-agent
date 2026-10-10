import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TAILCAT_VERSION = "v0.7.0";

interface TailcatAssetTarget {
    readonly key: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-x64";
    readonly platform: "darwin" | "linux" | "win32";
}

const TAILCAT_SHA256: Readonly<Record<TailcatAssetTarget["key"], string>> = {
    "win32-x64": "58b20f596925445b0b4b66ae21104492a6a896e1c1aee66e338847688b8234e4",
    "darwin-arm64": "2ca927dcc30d2a2e4ac2c7fed6e36ea317ca88443864e92ecc80cd134ab3991e",
    "darwin-x64": "f17ae389bcd999ea652db8371a2e26640c694f2476f16f759449b4075f849424",
    "linux-arm64": "1f8e877f9080ab0436eaf2bb0d0712f190f56d30d3e78ece8d0680b280f1f955",
    "linux-x64": "75da81231e01f2a52005f26f4eca6df4bce71cb694a42fa467a30e93c3d7a5b9",
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
