import { execFile as execFileCallback } from "node:child_process";
import { mkdir, symlink, writeFile as writeFs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { clientFrameEvent, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("the public files and Git API", () => {
    it("searches, pages, reads, writes, and confines workspace files", async () => {
        const binary = Buffer.from([0, 1, 2, 127, 128, 255]);
        const gym = await createAgentGym({
            files: {
                "README.md": "A workspace readme.\n",
                "node_modules/dependency/index.js": "module.exports = {};\n",
                "src/alpha.ts": "export const alpha = 1;\n",
                "src/beta.ts": "export const beta = 2;\n",
                "src/deep/gamma.test.ts": "export const gamma = true;\n",
                "assets/sample.bin": binary,
            },
        });
        running.add(gym);

        const workspaceId = await rootWorkspaceId(gym);

        const search = await gym.client.searchFiles(workspaceId, {
            limit: 10,
            query: "alpha",
        });
        expect(search.files[0]).toEqual({
            fileName: "alpha.ts",
            path: "src/alpha.ts",
        });

        const fuzzySearch = await gym.client.searchFiles(workspaceId, {
            limit: 10,
            query: "gmtest",
        });
        expect(fuzzySearch.files).toContainEqual({
            fileName: "gamma.test.ts",
            path: "src/deep/gamma.test.ts",
        });

        const emptySearch = await gym.client.searchFiles(workspaceId, {
            limit: 10,
            query: "",
        });
        expect(emptySearch.files.map((file) => file.path)).toEqual(
            expect.arrayContaining(["README.md", "src/alpha.ts"]),
        );
        expect(emptySearch.files.map((file) => file.path)).not.toContain(
            "node_modules/dependency/index.js",
        );

        const rootTree = await gym.client.getFileTree(workspaceId, { limit: 500 });
        expect(rootTree.entries.map((entry) => entry.name)).toContain("node_modules");

        const firstPage = await gym.client.getFileTree(workspaceId, {
            limit: 1,
            path: "src",
        });
        expect(firstPage.entries).toHaveLength(1);
        expect(firstPage.entries[0]).toMatchObject({
            name: "alpha.ts",
            path: "src/alpha.ts",
            type: "file",
        });
        expect(firstPage.nextCursor).toBe("1");

        const secondPage = await gym.client.getFileTree(workspaceId, {
            limit: 10,
            path: "src",
            ...(firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor }),
        });
        expect(secondPage.entries.map((entry) => entry.name)).toEqual(["beta.ts", "deep"]);
        expect(secondPage.nextCursor).toBeNull();

        const binaryRead = await gym.client.readFile(workspaceId, "assets/sample.bin");
        expect(Buffer.from(binaryRead.content, "base64")).toEqual(binary);
        expect(binaryRead.hash).toMatch(/^[0-9a-f]{64}$/);

        await mkdir(join(gym.workspacePath, "outputs"));
        const created = await gym.client.writeFile(workspaceId, {
            content: Buffer.from("created through the API\n", "utf8").toString("base64"),
            expectedHash: null,
            path: "outputs/result.txt",
        });
        expect(created.hash).toMatch(/^[0-9a-f]{64}$/);
        await expect(gym.client.readFile(workspaceId, "outputs/result.txt")).resolves.toMatchObject(
            {
                hash: created.hash,
            },
        );

        const beforeUpdate = await gym.client.readFile(workspaceId, "README.md");
        const updated = await gym.client.writeFile(workspaceId, {
            content: Buffer.from("Updated through the API.\n", "utf8").toString("base64"),
            expectedHash: beforeUpdate.hash,
            path: "README.md",
        });
        expect(updated.hash).not.toBe(beforeUpdate.hash);

        await expectApiError(
            () =>
                gym.client.writeFile(workspaceId, {
                    content: Buffer.from("stale write\n", "utf8").toString("base64"),
                    expectedHash: beforeUpdate.hash,
                    path: "README.md",
                }),
            { code: "hash_mismatch", status: 409 },
        ).then((error) => {
            expect(error.body).toMatchObject({ hash: updated.hash });
        });

        await expectApiError(() => gym.client.readFile(workspaceId, "does-not-exist.txt"), {
            code: "not_found",
            status: 404,
        });
        await expectApiError(() => gym.client.readFile(workspaceId, "../outside.txt"), {
            code: "invalid_request",
            status: 400,
        });

        const outside = join(dirname(gym.workspacePath), "outside.txt");
        await writeFs(outside, "must never be readable through a symlink\n", "utf8");
        await symlink(outside, join(gym.workspacePath, "escape.txt"));
        await expectApiError(() => gym.client.readFile(workspaceId, "escape.txt"), {
            code: "invalid_request",
            status: 403,
        });

        const oversizedPath = join(gym.workspacePath, "too-large.bin");
        await writeFs(oversizedPath, Buffer.alloc(44 * 1024 * 1024 + 1, 7));
        await expectApiError(() => gym.client.readFile(workspaceId, "too-large.bin"), {
            code: "too_large",
            status: 413,
        });
    });

    it("publishes file invalidations for rendered files and API writes", async () => {
        const gym = await createAgentGym({
            files: { "src/open.txt": "before\n" },
        });
        running.add(gym);
        const workspaceId = await rootWorkspaceId(gym);
        const stream = gym.stream();
        await stream.opened();

        await gym.client.readFile(workspaceId, "src/open.txt");
        await writeFs(join(gym.workspacePath, "src/open.txt"), "outside\n", "utf8");
        const external = await stream.waitFor((frame) => {
            const event = clientFrameEvent(frame);
            return (
                event?.type === "files.updated" &&
                event.payload.workspaceId === workspaceId &&
                event.payload.paths?.includes("src/open.txt") === true
            );
        }, "the external file invalidation");
        expect(clientFrameEvent(external)).toMatchObject({
            type: "files.updated",
            payload: { workspaceId, paths: expect.arrayContaining(["src/open.txt"]) },
        });

        await gym.client.writeFile(workspaceId, {
            content: Buffer.from("created\n", "utf8").toString("base64"),
            expectedHash: null,
            path: "created.txt",
        });
        const written = await stream.waitFor((frame) => {
            const event = clientFrameEvent(frame);
            return (
                event?.type === "files.updated" &&
                event.payload.workspaceId === workspaceId &&
                event.payload.paths?.includes("created.txt") === true
            );
        }, "the API file invalidation");
        expect(clientFrameEvent(written)).toMatchObject({
            type: "files.updated",
            payload: { workspaceId, paths: expect.arrayContaining(["created.txt"]) },
        });
        stream.close();
    });

    it("keeps fuzzy indexes scoped to the selected child workspace", async () => {
        const gym = await createAgentGym({
            files: {
                "root-only.ts": "export const rootOnly = true;\n",
            },
        });
        running.add(gym);
        const rootId = await rootWorkspaceId(gym);
        await gym.waitUntil(async () => {
            try {
                const workspace = (await gym.client.getWorkspace(rootId)).workspace;
                return workspace.initialization.status === "ready" ? workspace : undefined;
            } catch (error: unknown) {
                if ((error as { readonly status?: unknown }).status === 409) return undefined;
                throw error;
            }
        }, "the root workspace to initialize");
        const created = await gym.client.createWorkspace({
            agentId: gym.defaultSessionId,
            mutationId: "files-child-workspace",
            name: "files-child",
            parentId: rootId,
        });
        const child = await gym.waitUntil(async () => {
            try {
                const workspace = (await gym.client.getWorkspace(created.workspace.id)).workspace;
                return workspace.initialization.status === "ready" ? workspace : undefined;
            } catch (error: unknown) {
                if ((error as { readonly status?: unknown }).status === 409) return undefined;
                throw error;
            }
        }, "the child workspace to initialize");
        if (child.compute.type !== "host") throw new Error("The child has no host path.");
        await mkdir(join(child.compute.path, "src"), { recursive: true });
        await writeFs(
            join(child.compute.path, "src", "ChildComposer.tsx"),
            "export const childComposer = true;\n",
            "utf8",
        );

        const childSearch = await gym.client.searchFiles(child.id, {
            query: "chldcomp",
        });
        expect(childSearch.files).toContainEqual({
            fileName: "ChildComposer.tsx",
            path: "src/ChildComposer.tsx",
        });

        const rootSearch = await gym.client.searchFiles(rootId, {
            query: "chldcomp",
        });
        expect(rootSearch.files.map((file) => file.path)).not.toContain("src/ChildComposer.tsx");
    });

    it("reads Git revisions, publishes live snapshots, and replaces the watch set", async () => {
        const gym = await createAgentGym();
        running.add(gym);

        const repositoryPath = join(dirname(gym.workspacePath), "git-repository");
        await mkdir(repositoryPath, { recursive: true });
        await writeFs(join(repositoryPath, "tracked.txt"), "version one\n", "utf8");
        await git(repositoryPath, ["init", "--initial-branch=main"]);
        await git(repositoryPath, ["config", "user.email", "gym@example.invalid"]);
        await git(repositoryPath, ["config", "user.name", "API Gym"]);
        await git(repositoryPath, ["add", "tracked.txt"]);
        await git(repositoryPath, ["commit", "-m", "initial"]);
        await git(repositoryPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

        const registered = (
            await gym.client.registerProject({
                path: repositoryPath,
            })
        ).project;
        const ready = await gym.waitUntil(async () => {
            const project = (await gym.client.getProject(registered.id)).project;
            return project.initialization.status === "ready" ? project : undefined;
        }, "the Git project to initialize");
        expect(ready.git).not.toBeNull();

        const headRevision = await gym.client.readFileRevision(registered.id, {
            path: "tracked.txt",
            revision: "HEAD",
        });
        expect(Buffer.from(headRevision.content, "base64").toString("utf8")).toBe("version one\n");

        await writeFs(join(repositoryPath, "tracked.txt"), "version two\n", "utf8");
        await git(repositoryPath, ["add", "tracked.txt"]);
        await git(repositoryPath, ["commit", "-m", "second"]);
        await git(repositoryPath, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        const previousRevision = await gym.client.readFileRevision(registered.id, {
            path: "tracked.txt",
            revision: "HEAD~1",
        });
        expect(Buffer.from(previousRevision.content, "base64").toString("utf8")).toBe(
            "version one\n",
        );

        const initialGit = await gym.client.getWorkspaceGit(registered.id);
        expect(initialGit.git.changedFiles).toBe(0);
        expect(initialGit.git.conflicted).toBe(false);
        expect(["ready", "unavailable"]).toContain(initialGit.git.comparison);

        const stream = gym.stream();
        await stream.opened();
        const watched = await gym.client.watchGit({ workspaceIds: [registered.id] });
        expect(watched.snapshots).toEqual(expect.any(Object));

        await writeFs(join(repositoryPath, "untracked.txt"), "untracked\n", "utf8");
        const untracked = await waitForGitEvent(stream, registered.id, (gitState) =>
            gitState.files.some(
                (file) => file.path === "untracked.txt" && file.status === "untracked",
            ),
        );
        expect(untracked.git.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: "untracked.txt",
                    staged: false,
                    status: "untracked",
                    unstaged: true,
                }),
            ]),
        );

        await git(repositoryPath, ["add", "untracked.txt"]);
        const staged = await waitForGitEvent(stream, registered.id, (gitState) =>
            gitState.files.some(
                (file) =>
                    file.path === "untracked.txt" &&
                    file.status === "added" &&
                    file.staged === true,
            ),
        );
        expect(staged.git.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    path: "untracked.txt",
                    status: "added",
                    staged: true,
                }),
            ]),
        );

        const binary = Buffer.from([0, 1, 2, 3, 127, 128, 255]);
        await gym.client.writeFile(registered.id, {
            content: binary.toString("base64"),
            expectedHash: null,
            path: "binary.dat",
        });
        const binaryEvent = await waitForGitEvent(stream, registered.id, (gitState) =>
            gitState.files.some((file) => file.path === "binary.dat" && file.binary),
        );
        expect(binaryEvent.git.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    binary: true,
                    path: "binary.dat",
                }),
            ]),
        );

        const replacement = await gym.client.watchGit({ workspaceIds: [] });
        expect(replacement.snapshots).toEqual({});
        stream.close();
    }, 30_000);
});

async function rootWorkspaceId(gym: AgentGym): Promise<string> {
    const projects = await gym.client.listProjects();
    const root = projects.projects.find(
        (project) => project.compute.type === "host" && project.compute.path === gym.workspacePath,
    );
    if (root === undefined) throw new Error("The gym root project was not registered.");
    return root.id;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
    await execFile("git", [...args], {
        cwd,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
        },
    });
}

async function waitForGitEvent(
    stream: ReturnType<AgentGym["stream"]>,
    workspaceId: string,
    predicate: (git: GitStateLike) => boolean,
): Promise<{ readonly git: GitStateLike }> {
    const frame = await stream.waitFor((candidate) => {
        if (candidate.event !== "git.updated") return false;
        const data = candidate.data;
        if (data === null || typeof data !== "object") return false;
        const payload = (data as { readonly payload?: unknown }).payload;
        if (payload === null || typeof payload !== "object") return false;
        const eventWorkspaceId = (payload as { readonly workspaceId?: unknown }).workspaceId;
        if (eventWorkspaceId !== workspaceId) return false;
        const git = (payload as { readonly git?: unknown }).git;
        return git !== null && typeof git === "object" && predicate(git as GitStateLike);
    }, `a Git snapshot for ${workspaceId}`);
    const payload = (frame.data as { readonly payload: { readonly git: GitStateLike } }).payload;
    return { git: payload.git };
}

interface GitStateLike {
    readonly files: readonly GitFileLike[];
    readonly changedFiles: number;
    readonly conflicted: boolean;
    readonly comparison: "ready" | "unavailable";
}

interface GitFileLike {
    readonly path: string;
    readonly status: string;
    readonly staged: boolean;
    readonly unstaged: boolean;
    readonly binary: boolean;
}

async function expectApiError(
    action: () => Promise<unknown>,
    expected: { readonly code: string; readonly status: number },
): Promise<ApiErrorLike> {
    try {
        await action();
    } catch (error: unknown) {
        const apiError = error as ApiErrorLike;
        expect(apiError.status).toBe(expected.status);
        expect(apiError.code).toBe(expected.code);
        return apiError;
    }
    throw new Error(`Expected ${expected.code} (${String(expected.status)}).`);
}

interface ApiErrorLike {
    readonly body: unknown;
    readonly code: string | null;
    readonly status: number;
}
