import {
    mkdir,
    mkdtemp,
    readdir,
    realpath,
    rm,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BotsModule } from "../../sources/bots/index.js";
import {
    ProjectFileError,
    ProjectFilesModule,
    type ProjectFilesEvent,
    type ProjectFileRoot,
} from "../../sources/files/index.js";
import type { GitModule } from "../../sources/git/index.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import type { SurfacesModule } from "../../sources/surfaces/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const CUTOFF = NOW - 30 * DAY;

let directory: string;
let runners: RunnersModule;
const modules: ProjectFilesModule[] = [];

beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "happy-agent-files-retention-")));
    runners = new RunnersModule(await temporaryTestConfig());
});

afterEach(async () => {
    for (const files of modules.splice(0)) await files.close();
    await runners.close();
    await rm(directory, { force: true, recursive: true });
});

function filesModule(catalogs: {
    projects?: unknown;
    workspaces?: unknown;
    bots?: unknown;
    tasks?: unknown;
    surfaces?: unknown;
}): ProjectFilesModule {
    const files = new ProjectFilesModule(
        (catalogs.projects ?? {}) as ProjectsModule,
        (catalogs.workspaces ?? { enabled: false }) as WorkspacesModule,
        { invalidate: vi.fn(), markChanged: vi.fn() } as unknown as GitModule,
        runners,
        catalogs.bots as BotsModule | undefined,
        catalogs.tasks as TasksModule | undefined,
        catalogs.surfaces as SurfacesModule | undefined,
    );
    modules.push(files);
    return files;
}

/** One message's attachments, last written `age` milliseconds before now. */
async function upload(root: string, message: string, age: number, names = ["1-a.png"]) {
    const folder = join(root, ".happy-uploads", message);
    await mkdir(folder, { recursive: true });
    const at = new Date(NOW - age);
    for (const name of names) {
        await writeFile(join(folder, name), name);
        await utimes(join(folder, name), at, at);
    }
    await utimes(folder, at, at);
    return folder;
}

describe("ProjectFilesModule removes folders past a cutoff", () => {
    it("removes only folders nothing was written to since the cutoff", async () => {
        const files = filesModule({});
        const root: ProjectFileRoot = { projectId: "project-1", root: directory };
        await upload(directory, "old", 31 * DAY, ["1-a.png", "2-b.pdf"]);
        await upload(directory, "fresh", 2 * DAY);
        // A folder made long ago that a file was added to yesterday is in use.
        const touched = await upload(directory, "touched", 40 * DAY);
        const yesterday = new Date(NOW - DAY);
        await writeFile(join(touched, "2-late.png"), "late");
        await utimes(join(touched, "2-late.png"), yesterday, yesterday);
        await utimes(touched, new Date(NOW - 40 * DAY), new Date(NOW - 40 * DAY));
        // Entries beside the message folders are never removed, however old.
        const ancient = new Date(NOW - 400 * DAY);
        await writeFile(join(directory, ".happy-uploads", ".gitignore"), "*\n");
        await utimes(join(directory, ".happy-uploads", ".gitignore"), ancient, ancient);
        const elsewhere = join(directory, "elsewhere");
        await mkdir(elsewhere);
        await writeFile(join(elsewhere, "keep.txt"), "keep");
        await utimes(elsewhere, ancient, ancient);
        await symlink(elsewhere, join(directory, ".happy-uploads", "link"));
        const events: ProjectFilesEvent[] = [];
        files.onEvent((_ctx, event) => {
            events.push(event);
        });

        const result = await files.removeOlderThan(root, ".happy-uploads", CUTOFF);

        expect(result).toEqual({ found: true, removed: [".happy-uploads/old"] });
        expect((await readdir(join(directory, ".happy-uploads"))).sort()).toEqual([
            ".gitignore",
            "fresh",
            "link",
            "touched",
        ]);
        await expect(readdir(elsewhere)).resolves.toEqual(["keep.txt"]);
        await vi.waitFor(() =>
            expect(events.flatMap((event) => event.paths ?? [])).toContain(".happy-uploads/old"),
        );
    });

    it("finds nothing to remove where the directory does not exist", async () => {
        const files = filesModule({});
        const root: ProjectFileRoot = { projectId: "project-1", root: directory };

        await expect(files.removeOlderThan(root, ".happy-uploads", CUTOFF)).resolves.toEqual({
            found: false,
            removed: [],
        });
        await expect(readdir(directory)).resolves.toEqual([]);
    });

    it("refuses a directory that leads out of the root and leaves what is there alone", async () => {
        const files = filesModule({});
        const outside = await realpath(await mkdtemp(join(tmpdir(), "happy-agent-files-outside-")));
        try {
            await upload(outside, "old", 90 * DAY);
            await symlink(join(outside, ".happy-uploads"), join(directory, ".happy-uploads"));
            const root: ProjectFileRoot = { projectId: "project-1", root: directory };

            await expect(
                files.removeOlderThan(root, ".happy-uploads", CUTOFF),
            ).rejects.toMatchObject({ code: "forbidden", status: 403 });
            await expect(readdir(join(outside, ".happy-uploads"))).resolves.toEqual(["old"]);
            await expect(files.removeOlderThan(root, "../x", CUTOFF)).rejects.toBeInstanceOf(
                ProjectFileError,
            );
        } finally {
            await rm(outside, { force: true, recursive: true });
        }
    });
});

describe("ProjectFilesModule lists every folder it serves", () => {
    it("resolves each active catalog's folders once and leaves out what cannot be resolved", async () => {
        const folder = async (name: string) => {
            const path = join(directory, name);
            await mkdir(path);
            return path;
        };
        const project = await folder("project");
        const second = await folder("second");
        const workspace = await folder("workspace");
        const bot = await folder("bot");
        const task = await folder("task");
        const surface = await folder("surface");
        const projects = new Map<string, { id: string; status: string; path: string }>([
            ["project-1", { id: "project-1", status: "active", path: project }],
            ["project-2", { id: "project-2", status: "active", path: second }],
            ["project-3", { id: "project-3", status: "archived", path: project }],
            ["project-4", { id: "project-4", status: "active", path: join(directory, "gone") }],
        ]);
        const pages = [
            { projects: [projects.get("project-1"), projects.get("project-3")], nextCursor: "p2" },
            { projects: [projects.get("project-2"), projects.get("project-4")] },
        ];
        const workspaces = new Map([
            ["workspace-1", { id: "workspace-1", projectRef: "project-1", status: "ready" }],
            ["workspace-2", { id: "workspace-2", projectRef: "project-1", status: "archived" }],
            // The project's own root listed as a workspace names the same folder again.
            ["project-1", { id: "project-1", projectRef: "project-1", status: "ready" }],
        ]);
        const workspacePaths = new Map([
            ["workspace-1", workspace],
            ["workspace-2", workspace],
            ["project-1", project],
        ]);
        const files = filesModule({
            projects: {
                listCatalogPage: async (_ctx: unknown, query: { cursor?: string }) =>
                    query.cursor === "p2" ? pages[1] : pages[0],
                get: async (_ctx: unknown, id: string) => projects.get(id),
                location: (record: { path: string }) => ({ path: record.path }),
            },
            workspaces: {
                enabled: true,
                listCatalogPage: async () => ({ workspaces: [...workspaces.values()] }),
                get: async (_ctx: unknown, id: string) => {
                    const record = workspaces.get(id);
                    return record === undefined
                        ? undefined
                        : { ...record, path: workspacePaths.get(id) };
                },
            },
            bots: {
                list: async () => [
                    { id: "bot-1", workspaceId: "bot-workspace", status: "active" },
                    { id: "bot-2", workspaceId: "archived-bot", status: "archived" },
                ],
                forWorkspace: async (_ctx: unknown, workspaceId: string) =>
                    workspaceId === "bot-workspace"
                        ? { id: "bot-1", workspaceId, status: "active", path: bot }
                        : undefined,
            },
            tasks: {
                list: async () => [
                    { id: "task-1", workspaceId: "task-workspace", status: "active" },
                ],
                forWorkspace: async (_ctx: unknown, workspaceId: string) => ({
                    id: "task-1",
                    workspaceId,
                    status: "active",
                    path: task,
                }),
            },
            surfaces: {
                list: async () => [
                    { id: "surface-1", chatAgentId: "chat-agent" },
                    { id: "surface-2", chatAgentId: null },
                ],
                chatForAgent: async () => ({
                    surfaceId: "surface-1",
                    workspaceId: "surface-workspace",
                }),
                chatForWorkspace: async () => ({
                    surfaceId: "surface-1",
                    workspaceId: "surface-workspace",
                    path: surface,
                }),
            },
        });

        const roots = await files.roots({} as never);

        expect(roots).toEqual([
            { projectId: "project-1", root: project },
            { projectId: "project-2", root: second },
            { projectId: "project-1", workspaceId: "workspace-1", root: workspace },
            { projectId: "bot-1", workspaceId: "bot-workspace", root: bot },
            { projectId: "task-1", workspaceId: "task-workspace", root: task },
            { projectId: "surface-1", workspaceId: "surface-workspace", root: surface },
        ]);
    });
});
