import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchClaudeProviderUsage } from "@/vendors/claude/fetchClaudeProviderUsage.js";
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

    it.each([0, 1, 2, 3])(
        "stops within three attempts after %i missing reads",
        async (failures) => {
            const fixture = await installFakeSecurity({ failures });

            const token = await readTokenFromMacOsKeychain(fixture.directory, {
                USER: "test-user",
            });

            expect(token).toBe(failures < 3 ? ACCESS_TOKEN : undefined);
            expect(await fixture.attempts()).toBe(Math.min(failures + 1, 3));
        },
    );

    it.each(["signal", "timeout"] as const)("recovers after a child %s", async (failure) => {
        const fixture = await installFakeSecurity({ failures: 1, failure });

        await expect(
            readTokenFromMacOsKeychain(fixture.directory, { USER: "test-user" }),
        ).resolves.toBe(ACCESS_TOKEN);
        expect(await fixture.attempts()).toBe(2);
    });

    it.each(["signal", "timeout"] as const)(
        "bounds repeated child %s failures",
        async (failure) => {
            const fixture = await installFakeSecurity({ failures: 3, failure });
            const started = performance.now();

            await expect(
                readTokenFromMacOsKeychain(fixture.directory, { USER: "test-user" }),
            ).resolves.toBeUndefined();
            expect(await fixture.attempts()).toBe(3);
            // Three 500ms child deadlines plus 20/40ms backoff, with CI scheduling headroom.
            expect(performance.now() - started).toBeLessThan(4_000);
        },
    );

    it.runIf(process.platform === "darwin")(
        "recovers the token before quota HTTP requests",
        async () => {
            const fixture = await installFakeSecurity({ failures: 1 });
            const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
                expect(await fixture.attempts()).toBe(2);
                return new Response("{}", { status: 200 });
            });

            const usage = await fetchClaudeProviderUsage({
                configDir: fixture.directory,
                env: { USER: "test-user" },
                fetch,
            });

            expect(usage?.providerId).toBe("claude");
            expect(fetch).toHaveBeenCalledTimes(2);
            for (const [, options] of fetch.mock.calls) {
                expect(options?.headers).toHaveProperty("authorization", `Bearer ${ACCESS_TOKEN}`);
                expect(options?.signal).toBeInstanceOf(AbortSignal);
            }
        },
    );

    it.runIf(process.platform === "darwin")(
        "returns no quota without HTTP when the credential stays absent",
        async () => {
            const fixture = await installFakeSecurity({ failures: 3 });
            const fetch = vi.fn<typeof globalThis.fetch>();

            await expect(
                fetchClaudeProviderUsage({
                    configDir: fixture.directory,
                    env: { USER: "test-user" },
                    fetch,
                }),
            ).resolves.toBeNull();
            expect(await fixture.attempts()).toBe(3);
            expect(fetch).not.toHaveBeenCalled();
        },
    );
});

function claudeConfigDir(): string {
    return join(tmpdir(), ".claude");
}

// Puts a `security` on PATH that fails the first `failures` calls the way the real one does when
// the item is missing, so the read runs through the same child process it always does.
async function installFakeSecurity(options: {
    failures: number;
    failure?: "signal" | "timeout";
}): Promise<{ directory: string; attempts: () => Promise<number> }> {
    const directory = await mkdtemp(join(tmpdir(), "claude-keychain-"));
    const attempts = join(directory, "attempts");
    const executable = join(directory, "security");
    const quotedAttempts = `'${attempts.replaceAll("'", "'\\''")}'`;
    const fail =
        options.failure === "signal"
            ? "kill -KILL $$"
            : options.failure === "timeout"
              ? `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 1000)'`
              : "exit 44";

    await writeFile(
        executable,
        [
            "#!/bin/sh",
            `attempts=$(cat ${quotedAttempts} 2>/dev/null || echo 0)`,
            "attempts=$((attempts + 1))",
            `echo "$attempts" > ${quotedAttempts}`,
            `if [ "$attempts" -le ${options.failures} ]; then`,
            "    echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2",
            `    ${fail}`,
            "fi",
            `echo '{"claudeAiOauth":{"accessToken":"${ACCESS_TOKEN}"}}'`,
            "",
        ].join("\n"),
    );
    await chmod(executable, 0o755);

    const path = process.env.PATH;
    process.env.PATH = `${directory}${delimiter}${path ?? ""}`;
    cleanups.push(async () => {
        if (path === undefined) delete process.env.PATH;
        else process.env.PATH = path;
        await rm(directory, { force: true, recursive: true });
    });
    return { directory, attempts: async () => Number(await readFile(attempts, "utf8")) };
}
