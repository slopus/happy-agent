import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGitIdentity } from "../../sources/onboarding/impl/readGitIdentity.js";

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true })));
});

async function home(files: Record<string, string>): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "git-identity-"));
    homes.push(path);
    for (const [name, content] of Object.entries(files)) {
        await mkdir(join(path, name, ".."), { recursive: true });
        await writeFile(join(path, name), content);
    }
    return path;
}

describe("reading the person's Git identity", () => {
    it("reads the user section of ~/.gitconfig, quoted or not, without comments", async () => {
        const path = await home({
            ".gitconfig": [
                "[core]",
                "\tname = not this",
                "[user]",
                '\tname = "Ada Lovelace"',
                "\temail = ada@example.com # work",
            ].join("\n"),
        });
        expect(await readGitIdentity(path)).toEqual({
            name: "Ada Lovelace",
            email: "ada@example.com",
        });
    });

    it("falls back to ~/.config/git/config, and finds nothing without both fields", async () => {
        const fallback = await home({
            ".gitconfig": "[user]\n\tname = Ada\n",
            ".config/git/config": "[user]\n\tname = Ada\n\temail = ada@example.com\n",
        });
        expect(await readGitIdentity(fallback)).toEqual({ name: "Ada", email: "ada@example.com" });
        expect(await readGitIdentity(await home({}))).toBeUndefined();
    });
});
