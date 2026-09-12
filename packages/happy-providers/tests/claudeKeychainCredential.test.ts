import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTokenFromMacOsKeychain } from "@/vendors/claude/impl/auth.js";

const ACCESS_TOKEN = "keychain-access-token";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Claude Code keychain credential", () => {
    // Claude Code rewrites its credential with `security add-generic-password -U`, which deletes
    // the item and adds it again. A read landing in that window reports errSecItemNotFound for a
    // credential that is present and valid a moment later.
    it("reads the token when the item is momentarily missing during a rewrite", async () => {
        await installFakeSecurity({ failures: 1 });

        await expect(readTokenFromMacOsKeychain(claudeConfigDir(), process.env)).resolves.toBe(
            ACCESS_TOKEN,
        );
    });

    it("reports no token once the keychain keeps failing", async () => {
        await installFakeSecurity({ failures: Number.MAX_SAFE_INTEGER });

        await expect(
            readTokenFromMacOsKeychain(claudeConfigDir(), process.env),
        ).resolves.toBeUndefined();
    });
});

function claudeConfigDir(): string {
    return join(tmpdir(), ".claude");
}

// Puts a `security` on PATH that fails the first `failures` calls the way the real one does when
// the item is missing, so the read runs through the same child process it always does.
async function installFakeSecurity(options: { failures: number }): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "claude-keychain-"));
    const attempts = join(directory, "attempts");
    const executable = join(directory, "security");

    await writeFile(
        executable,
        [
            "#!/bin/sh",
            `attempts=$(cat ${attempts} 2>/dev/null || echo 0)`,
            "attempts=$((attempts + 1))",
            `echo "$attempts" > ${attempts}`,
            `if [ "$attempts" -le ${options.failures} ]; then`,
            "    echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2",
            "    exit 44",
            "fi",
            `echo '{"claudeAiOauth":{"accessToken":"${ACCESS_TOKEN}"}}'`,
            "",
        ].join("\n"),
    );
    await chmod(executable, 0o755);

    const path = process.env.PATH;
    process.env.PATH = `${directory}${delimiter}${path ?? ""}`;
    cleanups.push(async () => {
        process.env.PATH = path;
        await rm(directory, { force: true, recursive: true });
    });
}
