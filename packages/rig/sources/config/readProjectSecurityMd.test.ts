import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GLOBAL_SECURITY_MD_MAX_BYTES } from "./globalSecurityMdMaxBytes.js";
import { readProjectSecurityMd } from "./readProjectSecurityMd.js";
import { createNodeFileSystemContext } from "../agent/context/createNodeFileSystemContext.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("readProjectSecurityMd", () => {
    it("treats missing and blank root files as no project policy", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-project-security-"));
        temporaryDirectories.push(root);
        const path = join(root, "AGENTS_SECURITY.md");

        const fs = createNodeFileSystemContext(root);
        await expect(readProjectSecurityMd(fs)).resolves.toBeUndefined();
        await writeFile(path, " \n\t");
        await expect(readProjectSecurityMd(fs)).resolves.toBeUndefined();
    });

    it("bounds the policy before adding it to a reviewer prompt", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-project-security-"));
        temporaryDirectories.push(root);
        await writeFile(
            join(root, "AGENTS_SECURITY.md"),
            "s".repeat(GLOBAL_SECURITY_MD_MAX_BYTES + 1),
        );

        await expect(readProjectSecurityMd(createNodeFileSystemContext(root))).resolves.toBe(
            "s".repeat(GLOBAL_SECURITY_MD_MAX_BYTES),
        );
    });
});