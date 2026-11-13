import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TAILCAT_VERSION = "v0.7.0-happy.1";

interface TailcatAssetTarget {
    readonly key: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-x64";
    readonly platform: "darwin" | "linux" | "win32";
}

const TAILCAT_SHA256: Readonly<Record<TailcatAssetTarget["key"], string>> = {
    "win32-x64": "36ff24ae606692f24832a8599191753140d625247b58d7d2a5d59fe5c5ebd9e8",
    "darwin-arm64": "6f0966026fe4ae6df4b15b55aef0bac52ed8ab8a7edb202b4a238dd70d4e9a8f",
    "darwin-x64": "245d33888949998abfa9aecea375689e68c2b2f00f2b61357ddf6039248c6c13",
    "linux-arm64": "9e66548779e8e968b9a4cfd6c394160ab4ee3d28f6220ac569b21bafb1057ace",
    "linux-x64": "4db730abb6ff8cd8fa60969bf65ba3561c2156631fa349c078a743b561e6e756",
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
