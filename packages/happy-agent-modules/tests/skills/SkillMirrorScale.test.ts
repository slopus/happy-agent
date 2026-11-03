import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectMirroredSkills } from "../../sources/skills/impl/collectMirroredSkills.js";

it("collects 1,025 installed skills for runners without the former count cutoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-mirror-scale-"));
    try {
        for (let index = 0; index < 1_025; index++) {
            const name = `skill-${index}`;
            await mkdir(join(root, name));
            await writeFile(
                join(root, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: A workflow.\n---\nInstructions.`,
            );
        }
        const result = await collectMirroredSkills([root], new Set(), new Map());
        expect(result.skills).toHaveLength(1_025);
        expect(result.skipped).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

it("reports aggregate byte-limit omissions explicitly even when each file is within its limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-mirror-bytes-"));
    try {
        for (let index = 0; index < 9; index++) {
            const name = `skill-${index}`;
            await mkdir(join(root, name));
            await writeFile(
                join(root, name, "SKILL.md"),
                `---\nname: ${name}\ndescription: A workflow.\n---\nInstructions.`,
            );
            const path = join(root, name, "support.bin");
            await writeFile(path, "");
            await truncate(path, 8 * 1024 * 1024);
        }
        const result = await collectMirroredSkills([root], new Set(), new Map());
        expect(result.skills).toHaveLength(7);
        expect(result.skipped).toEqual([
            "skill-7: the skills together exceed 64 MiB",
            "skill-8: the skills together exceed 64 MiB",
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
