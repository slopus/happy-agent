import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createHash } from "node:crypto";
import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import {
    createHostCompute,
    createRunnerChannelPair,
    RunnerHost,
} from "@slopus/happy-agent-compute";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";
import {
    ProjectFileError,
    ProjectFilesModule,
    type ProjectFilesEvent,
    type ProjectFileRoot,
} from "../../sources/files/index.js";
import { GitModule } from "../../sources/git/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const TOKEN = "a".repeat(43);
const run = promisify(execFile);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A files module whose folder is on a connected runner, served from a temporary home here. */
async function runnerFolder() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "happy-runner-files-")));
    cleanups.push(async () => await rm(home, { force: true, recursive: true }));
    const config = {
        get runners() {
            return { defaultId: "build-box", entries: { "build-box": { token: TOKEN } } };
        },
    } as unknown as ConfigModule;
    const runners = new RunnersModule(config);
    const database = moduleDatabase(runners.migrations, "runner-files-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    runners.beforeStart(database.context);
    cleanups.push(() => database.close());
    cleanups.push(async () => await runners.close());

    const root = database.rootContext;
    const host = new RunnerHost({
        ctx: root.named("test-runner"),
        identity: { version: "9.9.9", platform: "linux", arch: "x64", hostname: "box", home },
        createCompute: async (computeCtx, request) =>
            createHostCompute({ ctx: computeCtx, cwd: request.cwd }),
    });
    cleanups.push(async () => await host.dispose(root.named("test-runner-dispose")));
    const connected = new Promise<void>((resolve) => {
        const stop = runners.onUpdated((_ctx, snapshot) => {
            if (snapshot.runners[0]?.status !== "connected") return;
            stop();
            resolve();
        });
    });
    const [daemonSide, runnerSide] = createRunnerChannelPair();
    void runners.accept("build-box", daemonSide);
    void host.serve(runnerSide);
    await connected;

    const git = new GitModule(undefined, runners);
    cleanups.push(() => git.dispose());
    const files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        git,
        runners,
    );
    cleanups.push(async () => await files.close());
    const folder = join(home, "project");
    await mkdir(folder);
    const fileRoot: ProjectFileRoot = { projectId: "project", root: folder, runnerId: "build-box" };
    return { files, folder, root: fileRoot };
}

describe("files on a runner", () => {
    it("lists, reads, and writes the runner's folder", async () => {
        const { files, folder, root } = await runnerFolder();
        await mkdir(join(folder, "src"));
        await writeFile(join(folder, "src", "index.ts"), "export {};\n");
        await writeFile(join(folder, "README.md"), "hello");

        const tree = await files.tree(root, {});
        expect(tree.entries.map((entry) => [entry.name, entry.type])).toEqual([
            ["README.md", "file"],
            ["src", "directory"],
        ]);

        const read = await files.read(root, { path: "README.md" });
        expect(Buffer.from(read.content, "base64").toString()).toBe("hello");
        expect(read.hash).toBe(hash("hello"));

        await files.write(root, {
            content: Buffer.from("changed").toString("base64"),
            expectedHash: read.hash,
            path: "README.md",
        });
        await expect(readFile(join(folder, "README.md"), "utf8")).resolves.toBe("changed");
        await files.write(root, {
            content: Buffer.from("new").toString("base64"),
            expectedHash: null,
            path: "docs/guide.md",
        });
        await expect(readFile(join(folder, "docs", "guide.md"), "utf8")).resolves.toBe("new");

        const conflict = await files
            .write(root, {
                content: Buffer.from("stale").toString("base64"),
                expectedHash: read.hash,
                path: "README.md",
            })
            .catch((error: unknown) => error);
        expect(conflict).toBeInstanceOf(ProjectFileError);
        expect(conflict).toMatchObject({ code: "conflict", currentHash: hash("changed") });
    });

    it("refuses paths that leave the runner folder", async () => {
        const { files, root } = await runnerFolder();
        await expect(files.read(root, { path: "../outside.txt" })).rejects.toMatchObject({
            code: "invalid",
        });
        await expect(files.read(root, { path: "missing.txt" })).rejects.toMatchObject({
            code: "missing",
        });
    });

    it("searches the runner's own listing of the folder", async () => {
        const { files, folder, root } = await runnerFolder();
        await mkdir(join(folder, "sources", "components"), { recursive: true });
        await writeFile(join(folder, "sources", "components", "ChatComposer.tsx"), "");
        await mkdir(join(folder, "node_modules", "dependency"), { recursive: true });
        await writeFile(join(folder, "node_modules", "dependency", "ChatComposer.js"), "");

        const plain = await files.search(root, { query: "chtcomp" });
        expect(plain.files).toEqual([
            { fileName: "ChatComposer.tsx", path: "sources/components/ChatComposer.tsx" },
        ]);

        await run("git", ["init", "-q"], { cwd: folder });
        await writeFile(join(folder, ".gitignore"), "ignored.txt\n");
        await writeFile(join(folder, "ignored.txt"), "");
        await writeFile(join(folder, "tracked-note.md"), "");
        await vi.waitFor(
            async () => {
                const paths = (await files.search(root, { query: "" })).files.map(
                    (file) => file.path,
                );
                expect(paths).toContain("tracked-note.md");
                expect(paths).not.toContain("ignored.txt");
            },
            { timeout: 10_000 },
        );
    });

    it("announces changes made on the runner after a client looked at the folder", async () => {
        const { files, folder, root } = await runnerFolder();
        const events: ProjectFilesEvent[] = [];
        files.onEvent((_ctx, event) => {
            events.push(event);
        });
        await files.tree(root, {});

        await vi.waitFor(
            async () => {
                await writeFile(join(folder, "made-elsewhere.txt"), String(Date.now()));
                expect(events.some((event) => event.paths?.includes("made-elsewhere.txt"))).toBe(
                    true,
                );
            },
            { interval: 300, timeout: 10_000 },
        );
        expect(events[0]?.workspaceId).toBe("project");
    });
});

function hash(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}
