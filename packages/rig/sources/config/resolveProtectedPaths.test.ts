import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProtectedPaths } from "./resolveProtectedPaths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("resolveProtectedPaths", () => {
    it("merges global and project paths and ignores missing entries", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-protected-paths-"));
        temporaryDirectories.push(cwd);
        await Promise.all([
            mkdir(join(cwd, "global")),
            mkdir(join(cwd, "project")),
            writeFile(
                join(cwd, "happy.toml"),
                '[permissions]\nprotected_paths = ["project", "missing-project"]\n',
            ),
        ]);

        expect(resolveProtectedPaths(cwd, ["global", "missing-global"])).toEqual([
            "global",
            "project",
        ]);
    });
});
