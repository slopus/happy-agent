import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncHappyAgentSkills } from "../../sources/nativeSkills/syncHappyAgentSkills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(async (path) => await rm(path, { force: true, recursive: true })),
    );
});

async function temporaryDirectory(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), name));
    temporaryDirectories.push(directory);
    return directory;
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
        join(root, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`,
        "utf8",
    );
}

describe("syncHappyAgentSkills", () => {
    it("installs the packaged native skills read-only into the Happy home", async () => {
        const root = await temporaryDirectory("happy-agent-skills-");
        const source = join(root, "packaged-skills");
        const happyHome = join(root, ".happy");
        await writeSkill(source, "guided-review", "Review a change.");
        await writeFile(join(source, "guided-review", "example.html"), "<p>example</p>\n");

        await syncHappyAgentSkills(happyHome, source);

        await expect(
            readFile(join(happyHome, "skills", "guided-review", "SKILL.md"), "utf8"),
        ).resolves.toContain("Review a change.");
        await expect(
            readFile(join(happyHome, "skills", "guided-review", "example.html"), "utf8"),
        ).resolves.toBe("<p>example</p>\n");
        expect(
            (await lstat(join(happyHome, "skills", "guided-review", "SKILL.md"))).mode & 0o222,
        ).toBe(0);
    });

    it("removes native skills and files a later release no longer ships", async () => {
        const root = await temporaryDirectory("happy-agent-skills-prune-");
        const first = join(root, "first-release");
        const second = join(root, "second-release");
        const happyHome = join(root, ".happy");
        const outside = join(root, "outside");
        await writeSkill(first, "old-review", "The retired skill.");
        await writeSkill(first, "guided-review", "Review a change.");
        await writeFile(join(first, "guided-review", "stale.md"), "stale\n");
        await writeSkill(second, "guided-review", "Review a change, better.");
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, "keep.md"), "outside\n");

        await syncHappyAgentSkills(happyHome, first);
        // Something the release never shipped, including a link out of the directory.
        await writeFile(join(happyHome, "skills", "stray.md"), "stray\n");
        await symlink(
            outside,
            join(happyHome, "skills", "linked"),
            process.platform === "win32" ? "junction" : "dir",
        );
        await syncHappyAgentSkills(happyHome, second);

        expect((await readdir(join(happyHome, "skills"))).sort()).toEqual(["guided-review"]);
        expect(await readdir(join(happyHome, "skills", "guided-review"))).toEqual(["SKILL.md"]);
        await expect(
            readFile(join(happyHome, "skills", "guided-review", "SKILL.md"), "utf8"),
        ).resolves.toContain("Review a change, better.");
        await expect(readFile(join(outside, "keep.md"), "utf8")).resolves.toBe("outside\n");
    });

    it("refuses an empty release rather than removing every native skill", async () => {
        const root = await temporaryDirectory("happy-agent-skills-empty-");
        const source = join(root, "packaged-skills");
        const empty = join(root, "empty-release");
        const happyHome = join(root, ".happy");
        await writeSkill(source, "guided-review", "Review a change.");
        await mkdir(empty, { recursive: true });
        await syncHappyAgentSkills(happyHome, source);

        await expect(syncHappyAgentSkills(happyHome, empty)).rejects.toThrow(
            "Happy Agent ships no native skills.",
        );
        await expect(
            readFile(join(happyHome, "skills", "guided-review", "SKILL.md"), "utf8"),
        ).resolves.toContain("Review a change.");
    });

    it("ships at least one native skill from the repository", async () => {
        const root = await temporaryDirectory("happy-agent-skills-repository-");
        const happyHome = join(root, ".happy");

        await syncHappyAgentSkills(happyHome);

        await expect(
            readFile(join(happyHome, "skills", "guided-review", "SKILL.md"), "utf8"),
        ).resolves.toMatch(/^---\nname: guided-review\n/u);
    });

    it("ships the rich-replies skill from the repository", async () => {
        const root = await temporaryDirectory("happy-agent-skills-rich-replies-");
        const happyHome = join(root, ".happy");

        await syncHappyAgentSkills(happyHome);

        await expect(
            readFile(join(happyHome, "skills", "rich-replies", "SKILL.md"), "utf8"),
        ).resolves.toMatch(/^---\nname: rich-replies\n/u);
    });
});
