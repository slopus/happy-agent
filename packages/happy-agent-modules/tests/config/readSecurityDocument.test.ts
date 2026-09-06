import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { readSecurityDocument } from "../../sources/config/impl/readSecurityDocument.js";

/**
 * The security documents an automatic permission review judges against are configuration's to
 * read: it owns where they live, so it owns getting the text out of them. What the reviewer needs
 * of that reading — an absent file is an absent policy, a blank file is no policy, an unreadable
 * file is an error rather than half a policy — is what is proven here.
 */

const MAX_BYTES = 32 * 1024;
const ctx = createRootContext().named("read-security-document-test");
const createdDirectories = new Set<string>();

afterEach(async () => {
    await Promise.all(
        [...createdDirectories].map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
    createdDirectories.clear();
});

describe("readSecurityDocument", () => {
    it("treats a missing file, a missing parent, and a directory as an absent policy", async () => {
        const directory = await createTestDirectory();

        await expect(
            readSecurityDocument(join(directory, "SECURITY.md"), MAX_BYTES),
        ).resolves.toBeUndefined();
        const file = join(directory, "not-a-directory");
        await writeFile(file, "content");
        await expect(
            readSecurityDocument(join(file, "SECURITY.md"), MAX_BYTES),
        ).resolves.toBeUndefined();
        const asDirectory = join(directory, "SECURITY.md");
        await mkdir(asDirectory);
        await expect(readSecurityDocument(asDirectory, MAX_BYTES)).resolves.toBeUndefined();
    });

    it("reads a policy and treats one that is only whitespace as none", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "SECURITY.md");

        await writeFile(path, "Never touch the production database.");
        await expect(readSecurityDocument(path, MAX_BYTES)).resolves.toBe(
            "Never touch the production database.",
        );

        await writeFile(path, "   \n\t \n");
        await expect(readSecurityDocument(path, MAX_BYTES)).resolves.toBeUndefined();
    });

    it("bounds the text it returns to the caller's byte budget", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "SECURITY.md");
        await writeFile(path, "a".repeat(MAX_BYTES + 500));

        const text = await readSecurityDocument(path, MAX_BYTES);

        expect(text).toHaveLength(MAX_BYTES);
    });

    it("raises a read failure that is not an absent file, rather than reporting no policy", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "SECURITY.md");
        // A link to itself: the read fails with ELOOP, which is neither "not there" nor "not a
        // file", so it must surface rather than be reported as an absent policy.
        await symlink(path, path);

        await expect(readSecurityDocument(path, MAX_BYTES)).rejects.toThrow();
    });
});

describe("ConfigModule security documents", () => {
    it("reads both documents from the paths configuration owns", async () => {
        const root = await createTestDirectory();
        const config = await ConfigModule.load(join(root, ".happy"));
        const { publicHome, securityPath } = config.configuration.paths;

        await expect(config.readGlobalSecurity(ctx, MAX_BYTES)).resolves.toBeUndefined();
        await expect(config.readProjectSecurity(ctx, MAX_BYTES)).resolves.toBeUndefined();

        await mkdir(config.configuration.paths.configHome, { recursive: true });
        await writeFile(securityPath, "GLOBAL_SECURITY_RULE");
        await writeFile(join(publicHome, "AGENTS_SECURITY.md"), "PROJECT_SECURITY_RULE");

        await expect(config.readGlobalSecurity(ctx, MAX_BYTES)).resolves.toBe(
            "GLOBAL_SECURITY_RULE",
        );
        await expect(config.readProjectSecurity(ctx, MAX_BYTES)).resolves.toBe(
            "PROJECT_SECURITY_RULE",
        );
    });

    it("rereads on every call, so a policy edited mid-session reaches the next decision", async () => {
        const root = await createTestDirectory();
        const config = await ConfigModule.load(join(root, ".happy"));
        const { securityPath } = config.configuration.paths;
        await mkdir(config.configuration.paths.configHome, { recursive: true });

        await writeFile(securityPath, "FIRST_RULE");
        await expect(config.readGlobalSecurity(ctx, MAX_BYTES)).resolves.toBe("FIRST_RULE");

        await writeFile(securityPath, "SECOND_RULE");
        await expect(config.readGlobalSecurity(ctx, MAX_BYTES)).resolves.toBe("SECOND_RULE");
    });
});

async function createTestDirectory(): Promise<string> {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "security-document-"));
    createdDirectories.add(directory);
    return directory;
}
