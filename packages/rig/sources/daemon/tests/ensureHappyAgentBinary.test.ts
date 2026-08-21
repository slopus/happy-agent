import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureHappyAgentBinary } from "../ensureHappyAgentBinary.js";
import { resolveLocalHappyAgentSources } from "../ensureLocalProtocolServer.js";
import { getHappyDaemonPaths, happyAgentBinaryPath } from "../getHappyDaemonPaths.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ensureHappyAgentBinary", () => {
    it("installs the matching release and atomically selects it", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const statuses: string[] = [];

        const installed = await ensureHappyAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive),
            onStatus: (status) => statuses.push(status),
            paths,
            platform: "darwin",
        });

        expect(installed).toEqual({
            path: happyAgentBinaryPath(paths, "1.2.3"),
            version: "1.2.3",
        });
        expect(JSON.parse(await readFile(paths.binaryConfigPath, "utf8"))).toEqual({
            downloadedVersions: ["1.2.3"],
            selectedVersion: "1.2.3",
        });
        expect((await stat(installed.path)).mode & 0o777).toBe(0o700);
        expect(await readdir(paths.versionsDirectory)).toEqual(["1.2.3"]);
        expect(statuses).toEqual([
            "Checking for the latest Happy Agent release.",
            "Downloading Happy Agent 1.2.3.",
        ]);
    });

    it("starts from the selected downloaded version without checking GitHub", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const first = await ensureHappyAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive),
            paths,
            platform: "darwin",
        });
        const fetch_ = vi.fn<typeof fetch>(() => {
            throw new Error("GitHub must not be queried for an installed selection.");
        });

        const second = await ensureHappyAgentBinary({ fetch: fetch_, paths });

        expect(second).toEqual(first);
        expect(fetch_).not.toHaveBeenCalled();
    });

    it("serializes concurrent first-run downloads across launchers", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const fetch_ = releaseFetch(archive, 30);

        const [first, second] = await Promise.all([
            ensureHappyAgentBinary({
                arch: "x64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "linux",
            }),
            ensureHappyAgentBinary({
                arch: "x64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "linux",
            }),
        ]);

        expect(first).toEqual(second);
        expect(fetch_).toHaveBeenCalledTimes(2);
        expect(await readdir(paths.versionsDirectory)).toEqual(["1.2.3"]);
    });

    it("does not publish a version or config after a checksum failure", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("corrupt archive");
        const fetch_ = releaseFetch(archive, 0, "0".repeat(64));

        await expect(
            ensureHappyAgentBinary({
                arch: "arm64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "linux",
            }),
        ).rejects.toThrow("checksum does not match");
        await expect(readFile(paths.binaryConfigPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await readdir(paths.versionsDirectory)).toEqual([]);
        await expect(readFile(paths.installLockPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});

describe("resolveLocalHappyAgentSources", () => {
    it("finds sibling Happy Agent sources from a built Rig checkout", () => {
        const found = resolveLocalHappyAgentSources(
            "file:///workspace/packages/rig/dist/main.js",
            (path) => path.pathname.includes("/packages/happy-agent/sources/"),
        );

        expect(found).toEqual({
            cliPath: "/workspace/packages/happy-agent/sources/cli.ts",
            runModuleUrl:
                "file:///workspace/packages/happy-agent/sources/lifecycle/runAgentDaemon.ts",
        });
    });
});

async function temporaryPaths() {
    const root = await mkdtemp(join(tmpdir(), "rig-happy-agent-download-"));
    roots.push(root);
    return getHappyDaemonPaths({ HAPPY_HOME_DIR: root }, root);
}

async function fakeExtract(
    _archivePath: string,
    destination: string,
    archivedBinaryName: string,
): Promise<void> {
    const path = join(destination, archivedBinaryName);
    await writeFile(path, "#!/bin/sh\n", "utf8");
    await chmod(path, 0o700);
}

function releaseFetch(
    archive: Buffer,
    delayMs = 0,
    digest = createHash("sha256").update(archive).digest("hex"),
) {
    return vi.fn<typeof fetch>(async (input) => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/releases/latest")) {
            return Response.json({
                assets: [
                    {
                        browser_download_url: "https://downloads.example/happy-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: url.includes("never")
                            ? "never"
                            : "happy-agent-1.2.3-darwin-arm64.tar.gz",
                        size: archive.length,
                    },
                    {
                        browser_download_url: "https://downloads.example/happy-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: "happy-agent-1.2.3-linux-x64.tar.gz",
                        size: archive.length,
                    },
                    {
                        browser_download_url: "https://downloads.example/happy-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: "happy-agent-1.2.3-linux-arm64.tar.gz",
                        size: archive.length,
                    },
                ],
                draft: false,
                prerelease: false,
                tag_name: "v1.2.3",
            });
        }
        return new Response(archive, { status: 200 });
    });
}
