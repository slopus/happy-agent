import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: never[]) => {
            reads.push(String(path));
            return actual.readFileSync(path, ...rest);
        }) as typeof actual.readFileSync,
    };
});

const { materializeEmbeddedFiles } = await import("../scripts/embeddedAssetRuntime.js");

const cleanup: string[] = [];
const temporaryDirectory = process.env.TMPDIR;
afterEach(async () => {
    if (temporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = temporaryDirectory;
    for (const path of cleanup.splice(0)) await rm(path, { force: true, recursive: true });
});

describe.skipIf(process.platform === "win32")("embedded asset runtime", () => {
    it("reads and hashes an embedded group once per process", async () => {
        // Spawning a sandboxed command resolves the supervisor executable and creating a provider
        // resolves the Claude executable. Rehashing either on every call blocked the daemon's
        // event loop for seconds, because the read and SHA-256 are synchronous.
        const root = await mkdtemp(join(tmpdir(), "happy-embedded-assets-test-"));
        cleanup.push(root);
        const source = join(root, "payload");
        await writeFile(source, "embedded executable bytes");
        process.env.TMPDIR = join(root, "cache");
        await mkdir(process.env.TMPDIR);
        const files = [{ source, relativePath: "bin/payload", executable: true }];

        const first = materializeEmbeddedFiles("embedded-asset-test", files);
        const sourceReads = reads.filter((path) => path === source).length;
        const second = materializeEmbeddedFiles("embedded-asset-test", [...files]);

        expect(second).toBe(first);
        expect(reads.filter((path) => path === source)).toHaveLength(sourceReads);
    });

    it("still separates groups whose layout differs", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-embedded-assets-test-"));
        cleanup.push(root);
        const source = join(root, "payload");
        await writeFile(source, "embedded library bytes");
        process.env.TMPDIR = join(root, "cache");
        await mkdir(process.env.TMPDIR);

        const library = materializeEmbeddedFiles("embedded-layout-test", [
            { source, relativePath: "lib/payload" },
        ]);
        const executable = materializeEmbeddedFiles("embedded-layout-test", [
            { source, relativePath: "lib/payload", executable: true },
        ]);
        const inline = materializeEmbeddedFiles("embedded-layout-test", [
            { contents: "generated module", relativePath: "lib/payload" },
        ]);

        expect(new Set([library, executable, inline]).size).toBe(3);
    });
});
