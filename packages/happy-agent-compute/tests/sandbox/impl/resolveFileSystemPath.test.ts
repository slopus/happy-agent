import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveFileSystemPath } from "../../../sources/sandbox/impl/resolveFileSystemPath.js";

describe("resolveFileSystemPath", () => {
    it("resolves relative, absolute, and home-relative paths consistently", () => {
        const cwd = resolve("/workspace");
        const home = resolve("/home/user");
        const input = resolve("/tmp/input.txt");
        expect(resolveFileSystemPath("src/index.ts", cwd, home)).toBe(join(cwd, "src", "index.ts"));
        expect(resolveFileSystemPath(input, cwd, home)).toBe(input);
        expect(resolveFileSystemPath("~", cwd, home)).toBe(home);
        expect(resolveFileSystemPath("~/input.txt", cwd, home)).toBe(join(home, "input.txt"));
    });

    it("rejects home-relative paths when the execution environment has no home", () => {
        expect(() => resolveFileSystemPath("~/input.txt", "/workspace")).toThrow(
            "home-relative paths are unavailable",
        );
    });
});
