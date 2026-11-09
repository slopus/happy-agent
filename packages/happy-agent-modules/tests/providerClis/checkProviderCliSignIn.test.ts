import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    KEYCHAIN_UNREADABLE,
    checkProviderCliSignIn,
} from "../../sources/providerClis/impl/checkProviderCliSignIn.js";

const folders: string[] = [];

afterEach(async () => {
    await Promise.all(
        folders.map(async (folder) => await rm(folder, { recursive: true, force: true })),
    );
    folders.length = 0;
});

/** A stand-in `claude` whose `auth status --json` prints `output`. */
async function claude(output: string): Promise<{ executable: string; home: string }> {
    const home = await mkdtemp(join(tmpdir(), "check-sign-in-"));
    folders.push(home);
    const executable = join(home, "claude");
    await writeFile(executable, `#!/bin/sh\necho '${output}'\n`);
    await chmod(executable, 0o755);
    return { executable, home };
}

function machine(platform: NodeJS.Platform, home: string) {
    return {
        platform,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        applications: [],
        programDirectories: [],
    };
}

describe("checking a sign-in", () => {
    it("says why a Mac outside the desktop session can't confirm Claude's sign-in", async () => {
        const { executable, home } = await claude('{"loggedIn":false}');
        // No desktop session answers here, as over SSH.
        expect(await checkProviderCliSignIn("claude", executable, machine("darwin", home))).toEqual(
            { status: "unknown", account: null, unchecked: KEYCHAIN_UNREADABLE },
        );
        // Elsewhere a Claude that says it is signed out is.
        expect(await checkProviderCliSignIn("claude", executable, machine("linux", home))).toEqual({
            status: "signed_out",
            account: null,
        });
    });

    it("says an answer it could not read was unreadable", async () => {
        const { executable, home } = await claude("Error: keychain");
        expect(await checkProviderCliSignIn("claude", executable, machine("linux", home))).toEqual({
            status: "unknown",
            account: null,
            unchecked: "Claude Code didn't say whether it's signed in.",
        });
    });
});
