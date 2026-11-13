import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TAILCAT_VERSION = "v0.7.0-happy.2";

interface TailcatAssetTarget {
    readonly key: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64" | "win32-x64";
    readonly platform: "darwin" | "linux" | "win32";
}

const TAILCAT_SHA256: Readonly<Record<TailcatAssetTarget["key"], string>> = {
    "win32-x64": "2fadcdf65cfe32df22465915c67bd28aec08f23387a00f566b7df9889bf8f342",
    "darwin-arm64": "57812913efc3eb82415082a5e51925a226618ec73b2488e0bf31b3a7a1fc2618",
    "darwin-x64": "ff86fb9ea5fbfcef6131306260f02891a75794d036655b030e7e7666288ecf9f",
    "linux-arm64": "bfe358a71a6e5908d07af646a0995330b3a5e3391d79604988f355bc66ce9273",
    "linux-x64": "1e8e218c5c7b583070687c64b4fc7dd478151130b25683954f33f23e95b7e727",
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
