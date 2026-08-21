import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeProjectCwd } from "../normalizeProjectCwd.js";

describe("normalizeProjectCwd", () => {
    it("uses filesystem identity for existing project directories", async () => {
        const directory = await mkdtemp(join(tmpdir(), "happy-terminal-project-cwd-"));
        const project = join(directory, "project");
        const alias = join(directory, "alias");
        try {
            await mkdir(project);
            await symlink(project, alias, "dir");

            expect(normalizeProjectCwd(alias)).toBe(await realpath(project));
            expect(normalizeProjectCwd(alias)).toBe(normalizeProjectCwd(project));
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("falls back to an absolute path when the directory does not exist", () => {
        expect(normalizeProjectCwd("relative/missing-project")).toBe(
            join(process.cwd(), "relative/missing-project"),
        );
    });
});
