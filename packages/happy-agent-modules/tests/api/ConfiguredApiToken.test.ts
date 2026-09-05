import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareLocalApiToken } from "../../sources/api/prepareLocalApiToken.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("replaces a generated socket token with the fixed deployment token and preserves it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fixed-api-token-"));
    roots.push(root);
    const path = join(root, "private", "token");
    const original = await prepareLocalApiToken(path, false);
    const fixed = "f".repeat(43);
    expect(original).not.toBe(fixed);
    expect(await prepareLocalApiToken(path, false, fixed)).toBe(fixed);
    expect(await prepareLocalApiToken(path, false)).toBe(fixed);
    expect((await readFile(path, "utf8")).trim()).toBe(fixed);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(prepareLocalApiToken(path, true, fixed)).rejects.toThrow();
    expect((await readFile(path, "utf8")).trim()).toBe(fixed);
});
